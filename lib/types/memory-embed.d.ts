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
/** 本地（进程内）编码器。懒加载模型，加载失败后不再重试。 */
export declare class LocalEmbedder implements Embedder {
    private readonly modelDir;
    private readonly factory;
    private pipeline;
    private loading;
    /** 已经尝试过且失败 —— 避免每次调用都重新 import 一遍。 */
    private failed;
    private dimension;
    constructor(modelDir: string, factory?: PipelineFactory);
    get dim(): number;
    isAvailable(): Promise<boolean>;
    /** 懒加载：并发调用共享同一个 loading Promise，失败只记一次。 */
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
export declare function embedSafely(embedder: Embedder | undefined, texts: readonly string[]): Promise<number[][] | undefined>;
