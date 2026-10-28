/**
 * Channel memory, stage 1: per-chat append-only notes + keyword recall.
 *
 * 为什么先做这一层而不是直接上向量：
 * 宿主 `@deepseek-ai/dsh-llm` 不提供 embedding（只有 resolveModelInfo），
 * 向量化必须自带服务/模型。先用零依赖的关键词召回验证「记忆对体验是否有用」，
 * 再把 recall 换成向量（接口保持不变即可）。
 *
 * 存储选型：**JSONL 追加写**，不引 better-sqlite3 —— 本项目已经因为
 * `@napi-rs/canvas` 这类原生模块踩过平台绑定的坑，记忆是增强功能，不值得
 * 再背一个原生依赖。单个 chat 的记忆量级（默认 200 条）用纯文本完全够。
 *
 * @module dsh-onebot/memory
 */
/** 一条记忆。字段刻意保持最小：正文 + 时间 + 可选标签。 */
export interface MemoryEntry {
    /** 写入时间（epoch ms），用于排序与「最近优先」截断。 */
    ts: number;
    /** 记忆正文。调用方负责裁剪长度。 */
    text: string;
    /** 可选标签，参与检索打分。 */
    tags?: string[];
}
/** 召回结果。 */
export interface MemoryHit {
    entry: MemoryEntry;
    /** 归一化后的相关度（0~1，仅用于排序，不保证跨查询可比）。 */
    score: number;
}
/**
 * chatId → 安全文件名。
 *
 * chatId 形如 `private:123456` / `group:789`，冒号在 Windows 文件名里非法，
 * 因此把所有非 `[A-Za-z0-9._-]` 换成下划线。碰撞风险可接受：chatId 的字符集
 * 来自 OneBot 的纯数字 id 与固定前缀。
 */
export declare function memoryFileName(chatId: string): string;
/** 某个 chat 的记忆文件绝对路径。 */
export declare function memoryFilePath(memoryDir: string, chatId: string): string;
/** 追加一条记忆；目录不存在时自动创建。 */
export declare function appendMemory(memoryDir: string, chatId: string, entry: MemoryEntry): void;
/**
 * 读取某个 chat 的记忆（旧→新）。
 *
 * 坏行（截断、手改坏）直接跳过而不是整体失败：记忆是增强功能，一条坏记录
 * 不该让 recall 整个不可用。
 */
export declare function readMemories(memoryDir: string, chatId: string, max?: number): MemoryEntry[];
/**
 * 把某个 chat 的记忆裁剪到最近 `max` 条（原地重写）。
 *
 * 追加式存储不裁剪会无限增长；这里在每次写入后调用，代价是每次重写整个文件
 * —— 200 条量级下可以接受，换成「每 N 次裁剪一次」是后续优化点。
 *
 * @returns 被丢弃的条数（0 表示未裁剪）。
 */
export declare function trimMemories(memoryDir: string, chatId: string, max: number): number;
/** 中文按 2-gram、英文/数字按连续片段切词；结果去重并小写。 */
export declare function tokenize(text: string): string[];
/**
 * 关键词召回：命中词数 / 查询词数，长词加权，长度做轻微惩罚。
 *
 * 这是「字面召回」——「辣的粉」搜不到「螺蛳粉」。第二批接 embedding 后可把
 * 这里换成余弦相似度，函数签名不变。
 */
export declare function searchMemories(entries: readonly MemoryEntry[], query: string, topK?: number): MemoryHit[];
