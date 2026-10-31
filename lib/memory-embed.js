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
const TRANSFORMERS_PACKAGE = '@xenova/transformers';
/**
 * 默认工厂：动态加载 `@xenova/transformers`。
 *
 * 包名放在变量里（不是字面量）是为了让 TypeScript **不去解析**这个模块 —— 它不在
 * 依赖里，写成字面量会直接编译失败。运行时若未安装，`import()` reject，被
 * `LocalEmbedder` 捕获后降级。
 */
const loadTransformersPipeline = async (modelDir) => {
    const mod = await import(TRANSFORMERS_PACKAGE);
    if (typeof mod.pipeline !== 'function')
        throw new Error('@xenova/transformers 缺少 pipeline 导出');
    const pipe = await mod.pipeline('feature-extraction', modelDir);
    if (typeof pipe !== 'function')
        throw new Error('@xenova/transformers 的 pipeline 未返回可调用对象');
    return pipe;
};
/**
 * 把 pipeline 输出统一成 `number[][]`。
 *
 * transformers 返回的是 Tensor（有 `tolist()`），注入的假实现可能直接给数组 ——
 * 两种都接受，其它形状一律报错（让降级发生，而不是把脏数据写进记忆）。
 */
function toVectors(raw) {
    const maybe = raw;
    const list = maybe !== null && typeof maybe?.tolist === 'function' ? maybe.tolist() : raw;
    if (!Array.isArray(list))
        throw new Error('embedding 输出形状不可识别（期望 number[][]）');
    return list;
}
/**
 * 本地（进程内）编码器。懒加载模型。
 *
 * 加载失败后进入**退避窗口**（默认 5 分钟）再允许重试，而不是永久放弃：
 * 模型目录可能只是因为网络盘掉线、杀软临时锁定、内存不足才加载失败 —— 让用户
 * 为了这种临时故障重启整个进程，代价太大。窗口内不重试是为了避免每条消息都
 * 重新 `import` 一遍（那是几十毫秒级的无谓开销）。
 */
export class LocalEmbedder {
    modelDir;
    factory;
    retryAfterMs;
    pipeline;
    loading;
    /** 上次加载失败的时刻；`undefined` = 从未失败（或已恢复）。 */
    failedAt;
    dimension = 0;
    kind = 'local';
    /** 模型指纹：目录变了就是换了模型（见 `Embedder.id` 的说明）。 */
    id;
    constructor(modelDir, factory = loadTransformersPipeline, retryAfterMs = 5 * 60_000) {
        this.modelDir = modelDir;
        this.factory = factory;
        this.retryAfterMs = retryAfterMs;
        this.id = 'local:' + modelDir;
    }
    get dim() {
        return this.dimension;
    }
    async isAvailable() {
        return (await this.ensurePipeline()) !== undefined;
    }
    /** 懒加载：并发调用共享同一个 loading Promise；退避窗口内不重试。 */
    ensurePipeline() {
        if (this.pipeline !== undefined)
            return Promise.resolve(this.pipeline);
        if (this.loading !== undefined)
            return this.loading;
        if (this.modelDir === '')
            return Promise.resolve(undefined);
        if (this.failedAt !== undefined && Date.now() - this.failedAt < this.retryAfterMs) {
            return Promise.resolve(undefined);
        }
        this.loading = this.factory(this.modelDir)
            .then((pipe) => {
            this.pipeline = pipe;
            this.failedAt = undefined;
            return pipe;
        })
            .catch(() => {
            this.failedAt = Date.now();
            return undefined;
        })
            .finally(() => {
            this.loading = undefined;
        });
        return this.loading;
    }
    async embed(texts) {
        if (texts.length === 0)
            return [];
        const pipe = await this.ensurePipeline();
        if (pipe === undefined)
            throw new Error('本地 embedding 模型不可用（未安装 @xenova/transformers 或模型目录缺失）');
        const vectors = toVectors(await pipe([...texts], { pooling: 'mean', normalize: true }));
        if (vectors.length !== texts.length) {
            throw new Error('embedding 返回条数（' + vectors.length + '）与输入（' + texts.length + '）不一致');
        }
        if (this.dimension === 0 && vectors.length > 0 && Array.isArray(vectors[0])) {
            this.dimension = vectors[0].length;
        }
        return vectors;
    }
}
/** OpenAI 协议：`{ data: [{ embedding: number[] }] }` */
function parseOpenAiPayload(payload) {
    const data = payload.data;
    if (!Array.isArray(data))
        throw new Error('embedding 响应缺少 data 字段');
    return data.map((item) => {
        const embedding = item.embedding;
        if (!Array.isArray(embedding))
            throw new Error('embedding 响应缺少向量');
        return embedding;
    });
}
/** Ollama 协议：`{ embeddings: number[][] }` */
function parseOllamaPayload(payload) {
    const embeddings = payload.embeddings;
    if (!Array.isArray(embeddings))
        throw new Error('embedding 响应缺少 embeddings 字段');
    return embeddings;
}
/** 远程编码器（OpenAI 兼容 / Ollama）。 */
export class HttpEmbedder {
    options;
    dimension;
    kind = 'http';
    /**
     * 模型指纹：`endpoint#模型名`。
     *
     * 带上 endpoint 是必要的 —— 同一个模型名在不同服务上（比如一个 Ollama 跑
     * `bge-m3`，另一个 OpenAI 兼容端点也自称 `bge-m3`）不保证权重相同。
     */
    id;
    constructor(options) {
        this.options = options;
        this.dimension = options.dim ?? 0;
        this.id = 'http:' + options.url.replace(/\/+$/, '') + '#' + options.model;
    }
    get dim() {
        return this.dimension;
    }
    /**
     * **不主动探活**：每次 recall 多一次网络往返不值得。
     * 只做静态判断（url/model 是否配置），真正的可用性由 `embed` 抛错体现。
     */
    async isAvailable() {
        return this.options.url !== '' && this.options.model !== '';
    }
    async embed(texts) {
        if (texts.length === 0)
            return [];
        const base = this.options.url.replace(/\/+$/, '');
        // OpenAI 兼容 vs Ollama 的判定。
        //
        // 不能死抠 `endsWith('/v1')`：用户很可能直接粘**完整端点**
        // `https://api.x.com/v1/embeddings`（各家文档里最常见的写法），或带网关前缀的地址 ——
        // 判成 Ollama 就会 POST 到 `…/v1/embeddings/api/embed` 拿 404，而降级是静默的，
        // 排查成本极高。所以接受 `/v1` 与 `/v1/embeddings` 两种结尾，且已含 `/embeddings`
        // 时不再重复拼接。
        const openai = /\/v1(\/embeddings)?$/.test(base);
        const endpoint = openai
            ? (base.endsWith('/embeddings') ? base : base + '/embeddings')
            : base + '/api/embed';
        const doFetch = this.options.fetchImpl ?? fetch;
        const controller = new AbortController();
        // 超时随批量放大，而不是写死 5s。
        //
        // 一次补 8 条时，本地 ONNX 冷启动或慢 CPU 上的 Ollama 完全可能超过 5s —— 整批
        // 超时后 `embedSafely` 会把它吞成「这轮不补了」，日志里什么都没有，表现成
        // 「语义召回时灵时不灵」且查不出原因。上限 30s：再长就等于让 recall 卡住。
        const timeoutMs = this.options.timeoutMs ?? Math.min(30_000, 5_000 + texts.length * 1_000);
        const timer = setTimeout(() => { controller.abort(); }, timeoutMs);
        let payload;
        try {
            const response = await doFetch(endpoint, {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    ...(this.options.key !== undefined && this.options.key !== ''
                        ? { authorization: 'Bearer ' + this.options.key }
                        : {}),
                },
                body: JSON.stringify({ model: this.options.model, input: [...texts] }),
                signal: controller.signal,
            });
            if (!response.ok)
                throw new Error('embedding 服务返回 HTTP ' + response.status);
            payload = await response.json();
        }
        finally {
            clearTimeout(timer);
        }
        const vectors = openai ? parseOpenAiPayload(payload) : parseOllamaPayload(payload);
        if (vectors.length !== texts.length) {
            throw new Error('embedding 返回条数（' + vectors.length + '）与输入（' + texts.length + '）不一致');
        }
        if (this.dimension === 0 && vectors.length > 0 && Array.isArray(vectors[0])) {
            this.dimension = vectors[0].length;
        }
        return vectors;
    }
}
/**
 * 按配置创建编码器。任何缺项都返回 `undefined`（等价于 `mode: 'off'`）。
 *
 * 为什么不在这里抛错：调用方对「没有 embedder」的处理与「不可用」一致 —— 都是
 * 退回纯关键词。少一条错误分支，就少一处忘记降级的可能。
 */
export function createEmbedder(config, options = {}) {
    const mode = config.mode ?? 'off';
    if (mode === 'off')
        return undefined;
    const model = (config.model ?? '').trim();
    if (mode === 'local') {
        if (model === '')
            return undefined;
        return new LocalEmbedder(model, options.pipelineFactory ?? loadTransformersPipeline);
    }
    const url = (config.url ?? '').trim();
    if (url === '' || model === '')
        return undefined;
    return new HttpEmbedder({
        url,
        model,
        ...(config.key !== undefined && config.key !== '' ? { key: config.key } : {}),
        ...(config.dim !== undefined && config.dim > 0 ? { dim: config.dim } : {}),
        ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
    });
}
/**
 * 统一降级点：编码失败返回 `undefined`，调用方据此退回纯关键词。
 *
 * 所有调用点都应该走这里，而不是各自 `try/catch` —— 否则迟早有一处忘记捕获，
 * 让「记忆是增强功能」变成「记忆坏了整个回合失败」。
 */
export async function embedSafely(embedder, texts, onFailure) {
    if (embedder === undefined)
        return undefined;
    try {
        return await embedder.embed(texts);
    }
    catch (error) {
        // **必须上报**：静默吞掉会让「端点配错 / 模型缺失 / 超时」变成永久静默降级 ——
        // 用户只看到「语义召回好像没用」，日志里一条线索都没有。节流由调用方负责
        // （同一 chat 5 分钟一次），这里只负责把错误递出去。
        onFailure?.(error);
        return undefined;
    }
}
