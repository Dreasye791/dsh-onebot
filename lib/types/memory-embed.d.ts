/**
 * 记忆的语义编码抽象（第二批 2a：接口 + 实现 + 工厂，**本批不接线**）。
 *
 * 设计意图（三条硬约束）：
 * 1. 本地实现与远程实现共用 `Embedder` 接口 —— 切换只改配置，不改调用方代码；
 * 2. 任何编码失败都降级为「纯关键词」，绝不能让写入或召回失败；
 * 3. 热路径（每条消息）不编码 —— 只有 remember / recall 这两个显式工具调用才编码。
 *
 * **零新依赖**：`@xenova/transformers`（约 5MB + onnxruntime-web）不在 dependencies 里，
 * 用动态 `import()` 加载：未安装时 reject → `isAvailable()` 为 false → 调用方降级。
 * 这样「不装也能跑、装了才有语义召回」，而不是让所有人背上这个依赖。
 *
 * @module dsh-onebot/memory-embed
 */
/** 一次编码请求的抽象：本地 ONNX 与远程 HTTP 共用同一签名。 */
export interface Embedder {
    /**
     * 实现类型：`'local'`（进程内，**不出机器**）/ `'http'`（原文会 POST 到外部端点）。
     *
     * 调用方用它决定「哪些内容可以送去编码」：后台补齐在 http 模式下**跳过画像**，
     * 因为用户开启 http 时预期的是「我让它记的那条会发出去」，而不是「把别人的画像
     * 与几十条历史闲聊一起批量外发」。
     */
    readonly kind: 'local' | 'http';
    /**
     * 模型指纹：**只有同一个 `id` 算同一个语义空间**。
     *
     * 为什么维度不够：BGE-M3 与 Qwen3-Embedding-0.6B 默认都是 **1024 维**，但两个
     * 模型训练出来的向量空间完全不可比。若只按维度判断兼容性，换模型后旧向量会被
     * 拿去和新模型的查询向量算余弦 —— 结果毫无意义，而且**没有任何报错**，
     * 表现为「换了个更好的模型，检索反而变差」。
     *
     * 形式：`local:<模型目录>` / `http:<endpoint>#<模型名>`。`local` 用路径是因为
     * 同一个目录名可能对应不同权重；路径变化会触发一次重编，代价可接受。
     */
    readonly id: string;
    /** 可用性探针：模型缺失 / 服务未配置 → false，调用方应降级到纯关键词。 */
    isAvailable(): Promise<boolean>;
    /** 向量维度；不可用（或尚未编码过）时为 0。 */
    readonly dim: number;
    /**
     * 批量编码，返回数组顺序与入参一致。
     * 空入参返回 `[]`（不发起任何请求）；失败直接抛错，由调用方统一降级。
     */
    embed(texts: readonly string[]): Promise<number[][]>;
}
/** 编码器配置（后续由 index.ts 的 schema 提供；本批先用普通对象，便于单测）。 */
export interface EmbedderConfig {
    /** `off`（默认）/ `local` / `http` */
    mode?: 'off' | 'local' | 'http';
    /** `local`：模型目录（内含 onnx + tokenizer）；`http`：模型名 */
    model?: string;
    /** `http`：endpoint。**以 `/v1` 结尾走 OpenAI 协议**，否则走 Ollama 协议 */
    url?: string;
    /** `http`：Bearer token */
    key?: string;
    /** 期望维度；`local` 从首次编码结果推导，`http` 建议显式给（用于识别换模型） */
    dim?: number;
}
/** `@xenova/transformers` 的 feature-extraction pipeline（只用到这些，便于测试注入）。 */
export type FeaturePipeline = (texts: string[], options: {
    pooling: 'mean';
    normalize: boolean;
}) => Promise<unknown>;
/** 加载 pipeline 的工厂；默认动态 import 可选依赖，测试可注入假实现。 */
export type PipelineFactory = (modelDir: string) => Promise<FeaturePipeline>;
/**
 * 本地（进程内）编码器。懒加载模型。
 *
 * 加载失败后进入**退避窗口**（默认 5 分钟）再允许重试，而不是永久放弃：
 * 模型目录可能只是因为网络盘掉线、杀软临时锁定、内存不足才加载失败 —— 让用户
 * 为了这种临时故障重启整个进程，代价太大。窗口内不重试是为了避免每条消息都
 * 重新 `import` 一遍（那是几十毫秒级的无谓开销）。
 */
export declare class LocalEmbedder implements Embedder {
    private readonly modelDir;
    private readonly factory;
    private readonly retryAfterMs;
    private pipeline;
    private loading;
    /** 上次加载失败的时刻；`undefined` = 从未失败（或已恢复）。 */
    private failedAt;
    private dimension;
    readonly kind: "local";
    /** 模型指纹：目录变了就是换了模型（见 `Embedder.id` 的说明）。 */
    readonly id: string;
    constructor(modelDir: string, factory?: PipelineFactory, retryAfterMs?: number);
    get dim(): number;
    isAvailable(): Promise<boolean>;
    /** 懒加载：并发调用共享同一个 loading Promise；退避窗口内不重试。 */
    private ensurePipeline;
    embed(texts: readonly string[]): Promise<number[][]>;
}
/** 远程编码器选项。 */
export interface HttpEmbedderOptions {
    url: string;
    model: string;
    key?: string;
    dim?: number;
    /** 测试注入点；缺省用全局 fetch。 */
    fetchImpl?: typeof fetch;
    /** 单次请求超时（毫秒），缺省 5000。 */
    timeoutMs?: number;
}
/** 远程编码器（OpenAI 兼容 / Ollama）。 */
export declare class HttpEmbedder implements Embedder {
    private readonly options;
    private dimension;
    readonly kind: "http";
    /**
     * 模型指纹：`endpoint#模型名`。
     *
     * 带上 endpoint 是必要的 —— 同一个模型名在不同服务上（比如一个 Ollama 跑
     * `bge-m3`，另一个 OpenAI 兼容端点也自称 `bge-m3`）不保证权重相同。
     */
    readonly id: string;
    constructor(options: HttpEmbedderOptions);
    get dim(): number;
    /**
     * **不主动探活**：每次 recall 多一次网络往返不值得。
     * 只做静态判断（url/model 是否配置），真正的可用性由 `embed` 抛错体现。
     */
    isAvailable(): Promise<boolean>;
    embed(texts: readonly string[]): Promise<number[][]>;
}
/** 工厂注入点（单测用；生产不传）。 */
export interface EmbedderFactoryOptions {
    pipelineFactory?: PipelineFactory;
    fetchImpl?: typeof fetch;
}
/**
 * 按配置创建编码器。任何缺项都返回 `undefined`（等价于 `mode: 'off'`）。
 *
 * 为什么不在这里抛错：调用方对「没有 embedder」的处理与「不可用」一致 —— 都是
 * 退回纯关键词。少一条错误分支，就少一处忘记降级的可能。
 */
export declare function createEmbedder(config: EmbedderConfig, options?: EmbedderFactoryOptions): Embedder | undefined;
/**
 * 统一降级点：编码失败返回 `undefined`，调用方据此退回纯关键词。
 *
 * 所有调用点都应该走这里，而不是各自 `try/catch` —— 否则迟早有一处忘记捕获，
 * 让「记忆是增强功能」变成「记忆坏了整个回合失败」。
 */
export declare function embedSafely(embedder: Embedder | undefined, texts: readonly string[], onFailure?: ((error: unknown) => void) | undefined): Promise<number[][] | undefined>;
