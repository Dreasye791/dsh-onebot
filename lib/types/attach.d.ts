/**
 * 入站图片的「真·图片块」投递与容量管理（T15）。
 *
 * 背景：T15 之前，入站图片只以 `[图片:<本地路径>]` 文本注解进入 prompt，
 * 模型的视觉通道从未被使用——它能读到路径，却拿不到像素（见 DEVLOG T15）。
 * 本模块把落盘的图片字节交给宿主的 `ctx.attachments` 服务，换回一个不变量
 * 化的 content-addressed 引用，再由 bridge 组进 `{ type: 'image', attachment }`。
 *
 * 空间管理要点（用户要求：可配置 + 简单容量统计）：
 * - 宿主附件库是 **content-addressed 去重** 的：同一张图重复出现只占一份空间。
 *   因此插件侧的账本只统计「自己贡献过哪些对象」，不能冒充全局占用。
 * - `attachmentBudgetMB` 是插件自设的软上限：账本累计一旦超限，新的图片不再
 *   走附件投递（退回文本路径），这样一次刷屏不会把磁盘吃穿。
 * - 账本落在 `<mediaDir>/attachment-ledger.json`，与媒体临时目录同生命周期，
 *   由 `/storage` 与该模块的统计函数共同读取。
 * @module dsh-onebot/attach
 */
/** 附件投递策略：来自配置，决定「什么图值得进附件库」。 */
export interface AttachPolicy {
    /** 是否把入站图片投递为真图片块；false = 退回旧行为（只给路径文本）。 */
    enabled: boolean;
    /** 单张图片字节上限；超过则不走附件投递（避免一张巨图吃掉配额）。0 = 不限。 */
    maxImageBytes: number;
    /** 插件账本累计字节软上限（字节）；超过后新图只给路径。0 = 不限。 */
    budgetBytes: number;
    /** 账本回收窗口（毫秒）：`lastSeenAt` 早于 now-该值的条目在下次
     *  投递前被移出账本，从而把软上限占用还回去。0 = 不回收（只增不减）。
     *  注意它只影响本插件的预算记账，**不删宿主附件库里的任何文件**——
     *  宿主对象由宿主自己的清理策略回收（`MediaStore.cleanupExpired` 之类）。 */
    retentionMs: number;
    /** 单次投递的宿主写盘超时（毫秒）：超过即放弃本次投递并退回路径文本。
     *  0 = 不超时。存在的理由见 `withLedgerLock` 的说明：临界区里包含一次
     *  无超时的宿主调用，卡住就会堵死所有会话的图片投递。 */
    saveTimeoutMs: number;
}
/** 账本里的一条记录：哪些对象是插件贡献的。 */
export interface LedgerEntry {
    /** 宿主附件的 content-addressed id（`sha256:<hex>`）。 */
    attachmentId: string;
    /** 该对象的字节数（归一化后，宿主实际落盘大小）。 */
    bytes: number;
    /** 首次贡献时间（ms）。 */
    firstSeenAt: number;
    /** 最近一次被同一对象命中（去重）的时间（ms）。 */
    lastSeenAt: number;
    /** 同一对象被命中的总次数（含首次）；>1 说明去重生效、未多占空间。 */
    hits: number;
}
/** 账本文件形状。 */
export interface AttachLedger {
    /** 账本版本，便于将来迁移。 */
    version: 1;
    /** 按 attachmentId 索引。 */
    entries: Record<string, LedgerEntry>;
}
/** 容量统计快照：给 /storage 命令与 bridge.storageReport() 共用。 */
export interface StorageStats {
    /** 插件媒体目录（mediaDir）绝对路径。 */
    mediaDir: string;
    /** mediaDir 递归总字节数。 */
    mediaBytes: number;
    /** mediaDir 递归文件总数。 */
    mediaFiles: number;
    /** 附件库根目录绝对路径（宿主所有）。 */
    attachmentsDir: string;
    /** 附件库递归总字节数。 */
    attachmentsBytes: number;
    /** 附件库递归文件总数。 */
    attachmentsFiles: number;
    /** 插件账本贡献的对象数。 */
    ledgerObjects: number;
    /** 插件账本贡献的总字节数（内容去重后）。 */
    ledgerBytes: number;
    /** 去重命中次数（同一对象被重复投递的次数之和）。 */
    ledgerDedupHits: number;
    /** 账本软上限字节；0 = 不限。 */
    budgetBytes: number;
    /** 是否已达软上限（不再投递新图）。 */
    budgetExhausted: boolean;
    /** 账本回收窗口（毫秒）；0 = 不回收（只增不减）。 */
    retentionMs: number;
}
/** 递归统计一个目录：字节数与文件数。目录不存在时返回 0/0。 */
export declare function dirUsage(dir: string): {
    bytes: number;
    files: number;
};
/** 读账本；文件缺失/损坏都返回空账本（统计是旁路，不因坏文件而抛）。
 *
 * 逐条校验条目形状：`ledgerBytes` 会直接读 `entry.bytes`，一条 `null` 条目
 * 就能让预算判定抛 TypeError 并静默关掉整条投递链。非法条目直接丢弃，
 * 让坏账本退化为「少记」而不是「全崩」。 */
export declare function readLedger(mediaDir: string): AttachLedger;
/** 写账本；失败仅返回 false（调用方降级为 warn，不影响图片投递）。
 *
 * 原子写：先写 `*.tmp` 再 rename 覆盖。直接覆写目标文件时，进程中断或
 * 并发写会留下截断的 JSON，而 `readLedger` 对坏文件一律返回空账本 ——
 * 预算会从 0 重算，等于把软上限抹掉。rename 在同一文件系统内是原子的，
 * 读方要么看到旧账本、要么看到新账本，不会看到半截内容。 */
export declare function writeLedger(mediaDir: string, ledger: AttachLedger): boolean;
/** 账本当前累计字节数。 */
export declare function ledgerBytes(ledger: AttachLedger): number;
/**
 * 是否还有预算投递新图。
 *
 * 只做「累计已用 < 上限」的粗判：内容寻址去重是否命中要等宿主返回才知，
 * 因此超限时连去重命中也会被拦下——保守但绝不会因为一次刷屏把磁盘吃穿，
 * 且超限后 `/storage` 会明确显示「已达上限」，用户可调高或清理后恢复。
 * @param ledger - 当前账本。
 * @param policy - 投递策略。
 */
export declare function withinBudget(ledger: AttachLedger, policy: AttachPolicy): boolean;
/**
 * 把一次成功投递记进账本（就地更新，调用方负责落盘）。
 *
 * 去重语义：宿主按 sha256 内容寻址，同一张图第二次投递不新增磁盘占用，
 * 因此只累加 `hits` 与 `lastSeenAt`，不重复累加 `bytes`。
 * @param ledger - 就地更新的账本。
 * @param ref - 宿主返回的附件引用（只读 `attachmentId` / `bytes` 两个字段）。
 * @param now - 时间戳（毫秒）。
 * @returns 本次是否命中去重。
 */
export declare function recordContribution(ledger: AttachLedger, ref: {
    attachmentId?: unknown;
    bytes?: unknown;
}, now: number): boolean;
/**
 * 从账本里移出过期条目，返回被释放的字节数（就地更新，调用方负责落盘）。
 *
 * 存在的理由：`withinBudget` 只看「累计已用 < 上限」，而账本只增不减 ——
 * 软上限一旦用满，即使宿主附件库被清空、磁盘上一个对象都不剩，本插件仍然
 * 永久拒绝新图（只能手删账本 JSON 才能恢复，而文档里没有这个入口）。
 *
 * 语义边界（必须说清，否则容易被误读成删除文件）：
 * - 只改本插件的预算记账，**不删** `<mediaDir>` 与宿主附件库里的任何文件；
 * - 被移出的对象若日后再次投递，宿主按内容寻址命中同一 attachmentId，
 *   会作为新条目重新记账（bytes 与当时一致，不会重复占用磁盘）；
 * - `retentionMs <= 0` 表示不回收（保持旧行为：只增不减）。
 * @param ledger - 就地更新的账本。
 * @param now - 当前时间戳（毫秒）。
 * @param retentionMs - 回收窗口（毫秒）；<=0 = 不回收。
 * @returns 被移出的条目数与释放的字节数。
 */
export declare function pruneLedger(ledger: AttachLedger, now: number, retentionMs: number): {
    pruned: number;
    freedBytes: number;
};
/** 汇总容量统计（供 /storage 命令使用）。 */
export declare function storageStats(mediaDir: string, attachmentsDir: string, policy: AttachPolicy): StorageStats;
/** 投递结果：成功给出宿主引用，失败给出可观测原因（不抛，掉回文本路径）。 */
export interface AttachResult {
    /** 宿主返回的不可变引用（原样透传给 `{ type: 'image', attachment }`）。 */
    ref?: ImageAttachmentRef;
    /** 未投递的原因（成功时缺省）。 */
    skipped?: 'disabled' | 'too-large' | 'budget' | 'unsupported-type' | 'host-unavailable' | 'save-failed';
    /** R-08：跳过时的原始原因（宿主异常信息/超时），供日志与 `/storage` 定位根因。 */
    detail?: string;
    /** 本次是否命中去重（仅成功时有意义）。 */
    dedupHit?: boolean;
}
/** 从本地文件名推断宿主可接受的 MIME；不支持则 undefined。 */
export declare function hostMediaType(path: string): string | undefined;
/** 宿主返回的附件引用（content-addressed）。 */
export interface ImageAttachmentRef {
    attachmentId: string;
    mediaType?: string;
    width?: number;
    height?: number;
    bytes?: number;
}
/** 一个 MiB，供配置项（MB）换算成字节。 */
export declare const MIB: number;
/**
 * 由配置构造投递策略。
 *
 * 边界处理：非正数（含负数、NaN）的字节上限统一按 0（不限）处理——配置写错
 * 成 -1 时若当上限用，会让**所有**图片都被拒，那比放开更糟。
 * @param config - 五项配置（enabled 直接取用；两个上限已是字节单位；
 *   retentionMs / saveTimeoutMs 为毫秒，<=0 = 关闭该机制）。
 * @returns 归一化后的策略。
 */
export declare function resolveAttachPolicy(config: {
    enabled: boolean;
    maxImageBytes: number;
    budgetBytes: number;
    retentionMs?: number;
    saveTimeoutMs?: number;
}): AttachPolicy;
/**
 * 把一张已经落盘的图片投递成宿主附件引用（T15 的「真图片块」来源）。
 *
 * 三条闸门按代价从低到高排列，任一不过都**不抛**、只返回原因，调用方据此
 * 退回 `[图片:<路径>]` 文本注解——视觉能力增强失败绝不能影响消息本身可达。
 *
 * 1. `maxImageBytes`：单图字节上限（读 stat 即可判断，不必读文件）。
 * 2. `budgetBytes`：插件账本累计软上限（去重命中不占新空间，放行）。
 * 3. 宿主能力与落盘：`attachments` 服务缺失、类型不支持、写入异常都归此。
 * @param attachments - 运行时取到的 `ctx.attachments`（可能 undefined）。
 * @param path - 已在 mediaDir 下的图片绝对路径。
 * @param policy - 投递策略。
 * @param mediaDir - 账本所在目录。
 * @returns 投递结果。
 */
export declare function deliverImage(attachments: unknown, path: string, policy: AttachPolicy, mediaDir: string): Promise<AttachResult>;
/** 人类可读字节数（与 health.ts 的 formatBytes 同口径，避免跨模块耦合重复导入）。 */
export declare function humanBytes(size: number): string;
/** 人类可读的时长（毫秒 → 天/小时/分钟），供 /storage 的回收窗口显示。 */
export declare function humanDuration(ms: number): string;
/** 把统计快照渲染成一段中文多行文本（/storage 与工具共用）。 */
export declare function formatStorageStats(stats: StorageStats): string;
