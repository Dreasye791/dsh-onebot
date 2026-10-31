/**
 * 记忆向量的后台补齐（第二批 2b′）。
 *
 * 为什么需要：新写入的记忆自带向量，但**历史条目**（开语义召回之前写的、或模型刚装上
 * 才启用的）没有向量 —— 它们只走关键词路。用户看到的现象是「语义召回时灵时不灵」。
 *
 * 为什么不能同步补：单条编码 20–60ms，200 条就是 6s。`recall` 里补会把一次查询变成
 * 一次超时。
 *
 * 为什么挂在 `turn/end` 之后：那一刻用户已经看到回复，补齐的延迟他感知不到；而且
 * 「有回合在跑」这个信号天然可以作为让路条件（新回合开始就中断，下轮再补）。
 *
 * 三条硬约束：
 * 1. **幂等**：只挑 `emb === undefined` 的条目，跑多少遍都不会重复编码；
 * 2. **可中断**：`isCancelled()` 每批检查一次，新回合开始时立刻停手；
 * 3. **静默**：任何失败都只是「这批没补上」，不抛错、不打扰用户 —— 补齐是增强功能。
 *
 * @module dsh-onebot/memory-backfill
 */
import { readAllMemories, writeMemoryEmbeddings } from './memory.js';
import { embedSafely } from './memory-embed.js';
/**
 * 给一个会话补齐缺失的向量。
 *
 * 不抛错：编码失败按「这批跳过」处理，返回结果里 `embedded` 会小于 `pending`，
 * 下一轮 `turn/end` 会再试。
 */
export async function backfillChat(options) {
    const { memoryDir, chatId, embedder } = options;
    const batchSize = Math.max(1, Math.floor(options.batchSize ?? 8));
    const budget = Math.max(0, Math.floor(options.budget ?? 32));
    const isCancelled = options.isCancelled ?? (() => false);
    const targetDim = embedder.dim;
    /**
     * **http 模式不补画像**。
     *
     * 补齐是后台批量（一轮最多 32 条），而用户开启 http 端点时预期的是「我让它记的
     * 那条会发出去」—— 把别人的画像和几十条历史闲聊一起批量 POST 过去，明显超出这个
     * 预期。画像要等当事人下次被 remember 时再编码（那时是当轮内容，符合预期）。
     *
     * `local` 不出机器，补什么都行。
     */
    const allowProfiles = embedder.kind === 'local';
    /**
     * 判断一条记忆是否「需要（重新）编码」。
     *
     * 不只是 `emb === undefined`：**维度变了**（换过模型）的条目也必须重编，否则它们
     * 永远匹配不上查询向量 —— 表现为「换了模型以后，旧记忆的语义召回全失效」，
     * 而界面上什么都看不出来。`targetDim === 0` 表示还没编过任何东西（local 未加载 /
     * http 没配 dim），此时无从判断，不误伤已有向量。
     */
    const embedderId = embedder.id;
    const needsEmbedding = (entry) => {
        const emb = entry.emb;
        if (emb === undefined || emb.length === 0)
            return true;
        // **指纹变了就重编**（含「历史条目没有指纹」）：只比维度不够 —— BGE-M3 与
        // Qwen3-Embedding 都是 1024 维，两个语义空间的向量不可比。留着旧向量会让
        // 召回算出无意义的分数，而且完全静默。
        if (entry.model !== embedderId)
            return true;
        if (targetDim > 0 && emb.length !== targetDim)
            return true;
        return false;
    };
    const shouldBackfill = (entry) => {
        if (!needsEmbedding(entry))
            return false;
        // http 模式跳过 profile（见 allowProfiles 的注释）
        if (!allowProfiles && entry.kind === 'profile')
            return false;
        return true;
    };
    const pendingEntries = readAllMemories(memoryDir, chatId).filter((entry) => shouldBackfill(entry));
    const pending = pendingEntries.length;
    if (pending === 0 || budget === 0) {
        return { embedded: 0, pending, remaining: pending, cancelled: false };
    }
    let embedded = 0;
    let processed = 0;
    let cancelled = false;
    for (let start = 0; start < pendingEntries.length && processed < budget; start += batchSize) {
        if (isCancelled()) {
            cancelled = true;
            break;
        }
        const room = budget - processed;
        const batch = pendingEntries.slice(start, start + Math.min(batchSize, room));
        if (batch.length === 0)
            break;
        processed += batch.length;
        const vectors = await embedSafely(embedder, batch.map((entry) => entry.text), options.onFailure);
        if (vectors === undefined || vectors.length !== batch.length) {
            // 整批失败：不逐条重试（那会把一次故障放大成 N 次请求），留给下一轮。
            continue;
        }
        const updates = [];
        for (let index = 0; index < batch.length; index += 1) {
            const vector = vectors[index];
            // 带上 text：写回时按 `ts + text` 双键匹配，编码期间正文被改过就不会写串
            // （`updateMemory` 已把旧向量删了，这里再写回去等于撤销失效）。
            // 带上 model：向量与指纹必须同源写入，否则下次会误判兼容。
            if (Array.isArray(vector) && vector.length > 0) {
                updates.push({ ts: batch[index].ts, text: batch[index].text, emb: vector, model: embedderId });
            }
        }
        if (updates.length > 0)
            embedded += writeMemoryEmbeddings(memoryDir, chatId, updates);
        // 让出事件循环：补齐在后台跑，不能把主线程占满（宿主还要处理消息/渲染）。
        await new Promise((resolve) => { setTimeout(resolve, 0); });
    }
    const remaining = readAllMemories(memoryDir, chatId).filter((entry) => shouldBackfill(entry)).length;
    return { embedded, pending, remaining, cancelled };
}
