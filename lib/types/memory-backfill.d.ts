import type { Embedder } from './memory-embed.js';
/** 补齐参数。 */
export interface BackfillOptions {
    memoryDir: string;
    chatId: string;
    embedder: Embedder;
    /** 每批提交给编码器的条数（缺省 8）：批太小则往返多，批太大则单次阻塞久。 */
    batchSize?: number;
    /** 本次最多处理多少条（缺省 32）：把补齐分摊到多个回合，避免一次性吃满 CPU。 */
    budget?: number;
    /** 返回 true 时停止（通常是「有新回合开始了」）。 */
    isCancelled?: (() => boolean) | undefined;
    /** 编码失败回调（由调用方做节流上报，避免「静默降级」）。 */
    onFailure?: ((error: unknown) => void) | undefined;
}
/** 补齐结果。 */
export interface BackfillResult {
    /** 本次成功写入向量的条数 */
    embedded: number;
    /** 开始前缺向量的条数 */
    pending: number;
    /** 结束后仍缺向量的条数 */
    remaining: number;
    /** 是否被 `isCancelled` 提前中断 */
    cancelled: boolean;
}
/**
 * 给一个会话补齐缺失的向量。
 *
 * 不抛错：编码失败按「这批跳过」处理，返回结果里 `embedded` 会小于 `pending`，
 * 下一轮 `turn/end` 会再试。
 */
export declare function backfillChat(options: BackfillOptions): Promise<BackfillResult>;
