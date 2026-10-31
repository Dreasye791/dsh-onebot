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
    /**
     * 最近一次「提及」的时间（epoch ms）：同一事实被再次记录时刷新，而不是新增一条。
     *
     * 缺省（历史条目）视为等于 `ts`。面板用它显示「最近提及」，判断某条印象是否已经
     * 很久没被提起 —— `ts` 只说明首次写入，不能回答这个问题。
     */
    lastSeenAt?: number;
    /**
     * 语义向量（缺省 = 未编码：历史条目、编码失败、语义召回关闭）。
     *
     * 明文数组而非 base64：可读、可手改、坏行仍能被 `parseLine` 跳过。512 维约 5 KB/条，
     * 200 条上限 ≈ 1 MB/会话 —— 这个代价是「召回能换个说法」换来的，可以接受。
     */
    emb?: number[];
    /**
     * 向量维度（= `emb.length`，单独存一份便于排查「换模型导致的不兼容」）。
     * 与当前编码器维度不符时该条跳过语义路，仍走关键词。
     */
    dim?: number;
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
 * 正文 + 标签一起过敏感闸。
 *
 * 为什么必须合并判：`tags` 同样是明文落盘、也会出现在 `recall` 结果与设置页卡片里，
 * 而原实现只把 `text` 交给 `findSensitive` —— 手机号写进标签（`tags: ['13800138000']`）
 * 可以完全绕过拦截。用 `\n` 分隔而不是空格，避免标签数字与正文末尾数字粘成一个长串
 * 造成误判。
 */
export declare function findSensitiveIn(text: string, tags?: readonly string[]): string | null;
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
/** `upsertMemory` 的结果。 */
export interface UpsertResult {
    /** true = 命中了完全相同的条目，只刷新了 `lastSeenAt`（没有新增行）。 */
    refreshed: boolean;
}
/**
 * 为一个新条目分配**本会话内唯一**的 `ts`。
 *
 * 为什么需要：`ts` 同时承担「写入时间」和**条目标识**两个角色 —— `updateMemory` /
 * `deleteMemory` / 面板编辑与删除都按它定位。而唯一的写入路径用的是 `Date.now()`：
 * 面板保存与模型工具调用并发时可能落在同一毫秒，于是两条不同记忆共享一个标识，
 * 「删一条」变成「删两条」、「改一条」改到另一条头上。
 *
 * 分配方式：从 `now` 起找第一个未被占用的毫秒。最大差值只有几条毫秒，而 `ts` 只被
 * 用于排序、TTL（天级）与面板显示（分钟级），这点偏移完全不可见。
 *
 * 为什么不引入 `id` 字段：那要改模型侧契约（`forget` 的参数）、面板 descriptor 的
 * 宿主/客户端两侧，以及 54 处测试断言；这里十几行就能从**源头**消除冲突。
 *
 * @param entries - 该会话当前的全部条目（调用方通常已经读过文件）。
 * @param now - 期望的时间戳，缺省 `Date.now()`。
 */
export declare function allocateTs(entries: readonly MemoryEntry[], now?: number): number;
/**
 * 写入一条记忆，并把「完全相同的条目」折成一次提及。
 *
 * 判重口径是 **kind + subject + text 三者全等**，只做精确匹配 —— 近似去重需要相似度
 * 计算（第二批上 embedding 之后再做）。这样重复说同一件事不会堆成几十行，同时
 * `lastSeenAt` 能回答「这条印象最近一次被提到是什么时候」。
 *
 * 注意 `appendMemory` 保持原语义（无条件追加），单测与历史调用方不受影响。
 */
export declare function upsertMemory(memoryDir: string, chatId: string, entry: MemoryEntry): UpsertResult;
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
 * 删掉**某个主体**的画像（`/memory forget`）。
 *
 * `subject` 必须非空：空串/`undefined` **什么都不删并返回 0**。
 *
 * 这是刻意的护栏。此前语义是「空 subject = 删掉本会话所有画像」，而调用点只是把
 * 命令发送者的 `userId` 原样透传 —— 一旦上游某处让 `userId` 变成空串（入站层改造、
 * 伪造的 sender、重放的事件），一句 `/memory forget` 就会删光本会话所有人的画像，
 * 且不可撤销。要清空全部画像，请显式调用 `forgetAllProfiles`。
 *
 * @returns 被删除的条数。
 */
export declare function forgetProfiles(memoryDir: string, chatId: string, subject: string | undefined): number;
/**
 * 删掉本会话**所有**画像（`note` 保留）。
 *
 * 与 `forgetProfiles` 分开命名，是为了让「删一个人」和「删全部」在调用点一眼可辨 ——
 * 同一个函数靠 `subject` 是否为空来区分，是这类误删的经典来源。
 *
 * @returns 被删除的条数。
 */
export declare function forgetAllProfiles(memoryDir: string, chatId: string): number;
/**
 * 按谓词批量删除（`qq_memory_forget` 用），一次重写整个文件。
 *
 * 为什么不复用 `deleteMemory`：那个按 `ts` 删**单条**，而 forget 需要「关键词命中
 * + 权限过滤」的组合条件，逐条删会重写 N 次文件。
 *
 * @returns 被删除的条目（调用方用它回显「删了什么」，否则模型只能猜）。
 */
export declare function deleteMemoriesWhere(memoryDir: string, chatId: string, predicate: (entry: MemoryEntry) => boolean): MemoryEntry[];
/**
 * 批量写回向量（后台补齐用），一次重写整个文件。
 *
 * 为什么按 `ts` 逐条打补丁而不是整文件替换：补齐期间模型可能正好在 `remember` 追加新条目，
 * 整文件替换会把那条新增抹掉；只改命中条目的 `emb` / `dim` 是最小写。
 *
 * **为什么还要比对 `text`**：补齐是先快照正文、再编码（含跨批 await，可能持续数秒）、
 * 最后写回。这期间用户完全可能在面板上改了这条的正文 —— 而 `updateMemory` 刚刚因为
 * 「正文变了」把 `emb` 删掉。此时若只按 `ts` 写回，等于用**旧文本的向量**填回新文本，
 * 恰好撤销了「编辑失效」的全部意义（虚假相似：这条会在不相关查询里被召回）。
 * 所以文本对不上就跳过，下一轮补齐会按新文本重新编码。
 *
 * 同一个 `ts + text` 双键也顺带缓解了 `ts = Date.now()` 可能重复的问题
 * （同毫秒写入两条不同记忆时，不会再互相写串向量）。
 *
 * @returns 实际写入的条数（`ts`+`text` 对不上的会被跳过）。
 */
export declare function writeMemoryEmbeddings(memoryDir: string, chatId: string, updates: readonly {
    ts: number;
    text: string;
    emb: readonly number[];
}[]): number;
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
/**
 * 按 `ts` 删除**一条**记忆；返回是否命中。
 *
 * 只删第一条命中：`ts` 现在由 `allocateTs` 保证唯一，正常情况下本来就只有一条。
 * 这里仍用「定位一条、删一条」而不是 `filter`，是对**修复前写入的存量数据**兜底 ——
 * 万一文件里真有同 `ts` 的两条，`filter` 会把它们一起删掉，而删除不可撤销。
 */
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
 * 一条记忆的关键词相关度（0~1）：命中词数 / 查询词数，长词加权，长度做轻微惩罚。
 *
 * 抽成独立函数是为了让「纯关键词」与「混合召回」用**同一份口径** —— 两套实现
 * 会慢慢漂移，表现为同一条记忆在 recall 与面板搜索里的命中顺序不一样。
 *
 * @param entry - 记忆条目（正文 + 标签一起参与匹配）。
 * @param queryTokens - 已切好的查询词（调用方负责，避免每条重复分词）。
 */
export declare function keywordScore(entry: MemoryEntry, queryTokens: readonly string[]): number;
/**
 * 关键词召回：命中词数 / 查询词数，长词加权，长度做轻微惩罚。
 *
 * 这是「字面召回」——「辣的粉」搜不到「螺蛳粉」。语义召回见 `searchMemoriesHybrid`。
 */
export declare function searchMemories(entries: readonly MemoryEntry[], query: string, topK?: number): MemoryHit[];
/**
 * 余弦相似度（0~1，负相关压到 0）。
 *
 * 维度不一致直接返回 0 —— 它只是一个打分分量，不该抛错；真正的「维度不兼容」
 * 由调用方按 `emb.length` 过滤（见 `searchMemoriesHybrid`）。
 */
export declare function cosineSimilarity(left: readonly number[], right: readonly number[]): number;
/** 混合召回选项。 */
export interface HybridSearchOptions {
    /** 查询向量；缺省 = 只走关键词（与第一批行为完全一致）。 */
    queryVector?: readonly number[] | undefined;
    /** 语义权重 0~1，缺省 0.6（0 = 纯关键词，1 = 纯语义）。 */
    weight?: number | undefined;
    topK?: number | undefined;
}
/**
 * 混合召回：关键词分与语义分加权。
 *
 * 三条口径：
 * 1. **有向量且维度匹配** → `w × cos + (1−w) × keyword`；
 * 2. **无向量 / 维度不符**（历史条目、编码失败、换过模型）→ **只按关键词分**，
 *    不打折。打折会让历史条目被系统性压低，而用户看到的只是「排序莫名其妙」；
 * 3. 关键词为 0 但语义很高 → 仍然入选，这正是语义召回存在的意义。
 */
export declare function searchMemoriesHybrid(entries: readonly MemoryEntry[], query: string, options?: HybridSearchOptions): MemoryHit[];
