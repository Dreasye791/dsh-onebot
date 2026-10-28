/**
 * Channel memory: per-chat append-only notes, per-member profiles, keyword recall.
 *
 * 两个粒度：
 * - `note`：会话公共记忆（谁都能写，属于这个群/这个私聊）；
 * - `profile`：某个成员的特征（称呼、偏好、习惯），`subject` 是主体 QQ 号。
 *
 * 为什么先做关键词而不是向量：宿主 `@deepseek-ai/dsh-llm` 不提供 embedding
 * （只有 resolveModelInfo），向量化必须自带服务/模型。先用零依赖的关键词召回
 * 验证「记忆对体验是否有用」，再接向量 —— `searchMemories` 的签名不用变。
 *
 * 存储选型：**JSONL 追加写**，不引 better-sqlite3 —— 本项目已因
 * `@napi-rs/canvas` 这类原生模块踩过平台绑定的坑，记忆是增强功能，不值得
 * 再背一个原生依赖。单 chat 量级（默认 200 条）用纯文本完全够。
 *
 * @module dsh-onebot/memory
 */
/** 记忆类型。`note` = 会话公共；`profile` = 某个成员的特征。 */
export type MemoryKind = 'note' | 'profile';
/** 写入者角色（用于第二批「自动注入」时按来源过滤）。 */
export type MemoryRole = 'admin' | 'member';
/** 一条记忆。字段刻意保持最小；`kind` 缺省视为 `note`（兼容历史条目）。 */
export interface MemoryEntry {
    /** 写入时间（epoch ms），用于排序、TTL 判定与「最近优先」截断。 */
    ts: number;
    /** 记忆正文。调用方负责裁剪长度。 */
    text: string;
    /** 可选标签，参与检索打分，也决定 TTL 档位。 */
    tags?: string[];
    /** 类型；缺省 = `note`（历史条目没有这个字段）。 */
    kind?: MemoryKind;
    /** 写入发起者 QQ 号。 */
    by?: string;
    /** 写入发起者角色。 */
    role?: MemoryRole;
    /** 画像主体 QQ 号（`kind: 'profile'` 时必填）。 */
    subject?: string;
}
/** 召回结果。 */
export interface MemoryHit {
    entry: MemoryEntry;
    /** 归一化后的相关度（0~1，仅用于排序，不保证跨查询可比）。 */
    score: number;
}
/**
 * 按标签决定的 TTL（天）。`0` = 不过期。
 *
 * 为什么要分档：一刀切会让两类内容都不合适 —— 「周五要交周报」留着半年只会
 * 误导；「叫他小明」却是长期有效的事实。这里只看第一个命中的标签，未命中用
 * 默认值。
 */
export declare const TTL_DAYS_BY_TAG: Readonly<Record<string, number>>;
/** 没有命中任何标签时的默认 TTL（天）。 */
export declare const DEFAULT_TTL_DAYS = 90;
/** 该条记忆的 TTL（天）；`0` = 永不过期。 */
export declare function ttlDaysFor(entry: MemoryEntry): number;
/**
 * 是否已过期（**绝对过期**：从写入时刻起算，被 recall 多少次都不续期）。
 *
 * 为什么不做滑动过期：那需要每次 recall 回写 `lastUsedAt`，而 recall 的语义
 * 是只读（工具描述里写明了「只读，不修改记忆」）；「常用的记忆」也不等于
 * 「正确的记忆」。过期只是**不再被召回**，文件里的原文保留（软过期）。
 */
export declare function isExpired(entry: MemoryEntry, now?: number): boolean;
/** 召回范围。 */
export interface RecallScope {
    /** 当前发言者 QQ；`profile` 只为这个人返回。 */
    speaker?: string;
    /** 是否包含画像（默认 true）。 */
    includeProfiles?: boolean;
    /** 当前时间（测试注入）。 */
    now?: number;
}
/**
 * 按范围筛出可被召回的条目。
 *
 * 规则：
 * - 过期的**一律**排除（不论 note 还是 profile）；
 * - `note` 属于整个会话，总是候选；
 * - `profile` 只为「当前发言者自己」返回 —— 别人的画像不该在你面前被翻出来。
 */
export declare function selectForRecall(entries: readonly MemoryEntry[], scope?: RecallScope): MemoryEntry[];
/**
 * 敏感信息识别：命中即拒绝写入。
 *
 * 只覆盖「一眼可辨、误记代价高」的三类。刻意不做宽松匹配（如任意长数字），
 * 否则正常编号也会被拦。返回人类可读的类别名，`null` = 未命中。
 */
export declare function findSensitive(text: string): string | null;
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
/** 读取某个 chat 的全部记忆（旧→新）。 */
export declare function readAllMemories(memoryDir: string, chatId: string): MemoryEntry[];
/** 读取某个 chat 的记忆（旧→新），`max` 只保留最近的若干条。 */
export declare function readMemories(memoryDir: string, chatId: string, max?: number): MemoryEntry[];
/**
 * 把某个 chat 的记忆裁剪到最近 `max` 条（原地重写）。
 *
 * 追加式存储不裁剪会无限增长；这里在每次写入后调用，代价是每次重写整个文件
 * —— 200 条量级下可以接受。
 *
 * @returns 被丢弃的条数（0 表示未裁剪）。
 */
export declare function trimMemories(memoryDir: string, chatId: string, max: number): number;
/**
 * 删掉某个主体的全部画像（`/memory forget`）。
 *
 * `subject` 为空时删掉所有 profile（管理员清理用，调用方负责判权）。
 *
 * @returns 被删除的条数。
 */
export declare function forgetProfiles(memoryDir: string, chatId: string, subject?: string): number;
/** `private_123.jsonl` → `private:123`；不是记忆文件时返回 undefined（`memoryFileName` 的逆）。 */
export declare function chatIdFromFileName(name: string): string | undefined;
/** 一个会话的记忆文件概览。 */
export interface MemoryFileInfo {
    chatId: string;
    bytes: number;
    mtimeMs: number;
}
/**
 * 列出所有记忆文件（**只 stat，不解析内容**）。
 *
 * 面板会话列表靠它：解析上千条 JSON 只为显示「有几个会话」不值得，
 * 大小与 mtime 足以排序与展示；具体条目由 `readMemoryEntries` 按需分页读取。
 */
export declare function listMemoryFiles(memoryDir: string): MemoryFileInfo[];
/** 面板编辑：只允许改正文与标签（`ts`/`kind`/`subject` 是身份，不可改）。 */
export interface MemoryEditPatch {
    text?: string;
    tags?: string[];
}
/** 按 `ts` 更新一条记忆；返回是否命中（同毫秒多条时只改第一条）。 */
export declare function updateMemory(memoryDir: string, chatId: string, ts: number, patch: MemoryEditPatch): boolean;
/** 按 `ts` 删除一条记忆；返回是否命中。 */
export declare function deleteMemory(memoryDir: string, chatId: string, ts: number): boolean;
/** 中文按 2-gram、英文/数字按连续片段切词；结果去重并小写。 */
export declare function tokenize(text: string): string[];
/**
 * 从会话事件里取「本轮发言者」的 QQ 号。
 *
 * 入站文本形如 `[11:30 昵称(10001)][@我] <user_message qq="10001" nickname="…">…`，
 * 而 prompt 已声明「边界标签本身是可信元数据」。所以只需要**最后一条** user/message：
 * 解析不到就返回 undefined（不要往前翻历史 —— 那会把上一轮的发言者安到这一轮头上）。
 *
 * 为什么要取**第一个** `<user_message`：引用/转发展开会在内部再嵌一层同名标签，
 * 第一个才是本体。
 *
 * 纯函数，便于单测（工具侧只负责把 `session.ownEvents()` 喂进来）。
 */
export declare function speakerFromUserEvents(events: readonly unknown[]): string | undefined;
/**
 * 关键词召回：命中词数 / 查询词数，长词加权，长度做轻微惩罚。
 *
 * 这是「字面召回」——「辣的粉」搜不到「螺蛳粉」。第二批接 embedding 后可把
 * 这里换成余弦相似度，函数签名不变。
 */
export declare function searchMemories(entries: readonly MemoryEntry[], query: string, topK?: number): MemoryHit[];
