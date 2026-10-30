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

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** 记忆类型。`note` = 会话公共；`profile` = 某个成员的特征。 */
export type MemoryKind = 'note' | 'profile'

/** 写入者角色（用于第二批「自动注入」时按来源过滤）。 */
export type MemoryRole = 'admin' | 'member'

/** 一条记忆。字段刻意保持最小；`kind` 缺省视为 `note`（兼容历史条目）。 */
export interface MemoryEntry {
  /** 写入时间（epoch ms），用于排序、TTL 判定与「最近优先」截断。 */
  ts: number
  /** 记忆正文。调用方负责裁剪长度。 */
  text: string
  /** 可选标签，参与检索打分，也决定 TTL 档位。 */
  tags?: string[]
  /** 类型；缺省 = `note`（历史条目没有这个字段）。 */
  kind?: MemoryKind
  /** 写入发起者 QQ 号。 */
  by?: string
  /** 写入发起者角色。 */
  role?: MemoryRole
  /** 画像主体 QQ 号（`kind: 'profile'` 时必填）。 */
  subject?: string
  /**
   * 最近一次「提及」的时间（epoch ms）：同一事实被再次记录时刷新，而不是新增一条。
   *
   * 缺省（历史条目）视为等于 `ts`。面板用它显示「最近提及」，判断某条印象是否已经
   * 很久没被提起 —— `ts` 只说明首次写入，不能回答这个问题。
   */
  lastSeenAt?: number
  /**
   * 语义向量（缺省 = 未编码：历史条目、编码失败、语义召回关闭）。
   *
   * 明文数组而非 base64：可读、可手改、坏行仍能被 `parseLine` 跳过。512 维约 5 KB/条，
   * 200 条上限 ≈ 1 MB/会话 —— 这个代价是「召回能换个说法」换来的，可以接受。
   */
  emb?: number[]
  /**
   * 向量维度（= `emb.length`，单独存一份便于排查「换模型导致的不兼容」）。
   * 与当前编码器维度不符时该条跳过语义路，仍走关键词。
   */
  dim?: number
}

/** 召回结果。 */
export interface MemoryHit {
  entry: MemoryEntry
  /** 归一化后的相关度（0~1，仅用于排序，不保证跨查询可比）。 */
  score: number
}

/**
 * 按标签决定的 TTL（天）。`0` = 不过期。
 *
 * 为什么要分档：一刀切会让两类内容都不合适 —— 「周五要交周报」留着半年只会
 * 误导；「叫他小明」却是长期有效的事实。这里只看第一个命中的标签，未命中用
 * 默认值。
 */
export const TTL_DAYS_BY_TAG: Readonly<Record<string, number>> = {
  待办: 14,
  偏好: 0,
  事实: 365,
}

/** 没有命中任何标签时的默认 TTL（天）。 */
export const DEFAULT_TTL_DAYS = 90

/** 该条记忆的 TTL（天）；`0` = 永不过期。 */
export function ttlDaysFor(entry: MemoryEntry): number {
  for (const tag of entry.tags ?? []) {
    const days = TTL_DAYS_BY_TAG[tag]
    if (days !== undefined) return days
  }
  return DEFAULT_TTL_DAYS
}

/**
 * 是否已过期（**绝对过期**：从写入时刻起算，被 recall 多少次都不续期）。
 *
 * 为什么不做滑动过期：那需要每次 recall 回写 `lastUsedAt`，而 recall 的语义
 * 是只读（工具描述里写明了「只读，不修改记忆」）；「常用的记忆」也不等于
 * 「正确的记忆」。过期只是**不再被召回**，文件里的原文保留（软过期）。
 */
export function isExpired(entry: MemoryEntry, now = Date.now()): boolean {
  const days = ttlDaysFor(entry)
  if (days <= 0) return false
  return now - entry.ts > days * 24 * 60 * 60 * 1000
}

/** 召回范围。 */
export interface RecallScope {
  /** 当前发言者 QQ；`profile` 只为这个人返回。 */
  speaker?: string
  /** 是否包含画像（默认 true）。 */
  includeProfiles?: boolean
  /** 当前时间（测试注入）。 */
  now?: number
}

/**
 * 按范围筛出可被召回的条目。
 *
 * 规则：
 * - 过期的**一律**排除（不论 note 还是 profile）；
 * - `note` 属于整个会话，总是候选；
 * - `profile` 只为「当前发言者自己」返回 —— 别人的画像不该在你面前被翻出来。
 */
export function selectForRecall(entries: readonly MemoryEntry[], scope: RecallScope = {}): MemoryEntry[] {
  const now = scope.now ?? Date.now()
  const includeProfiles = scope.includeProfiles !== false
  const speaker = scope.speaker
  return entries.filter((entry) => {
    if (isExpired(entry, now)) return false
    if ((entry.kind ?? 'note') === 'note') return true
    if (!includeProfiles) return false
    if (speaker === undefined || speaker === '') return false
    return entry.subject === speaker
  })
}

/**
 * 敏感信息识别：命中即拒绝写入。
 *
 * 只覆盖「一眼可辨、误记代价高」的三类。刻意不做宽松匹配（如任意长数字），
 * 否则正常编号也会被拦。返回人类可读的类别名，`null` = 未命中。
 */
export function findSensitive(text: string): string | null {
  // 按「整段数字」判长度，而不是在长串里找子串：
  // 最初用 `1[3-9]\d{9}` 无边界匹配，18 位身份证里的 11 位连续数字会被当成手机号，
  // 13 位时间戳也会被截取命中（`1` + `7` + 9 位）。长度口径没有这个问题。
  //
  // 18 位里最后一位可能是 X（校验位），`\d+` 切不出来，单独判一次。
  if (/(^|\D)\d{17}[Xx](\D|$)/.test(text)) return '身份证号'
  //
  // **两种切法都要试**：只看 `\d+` 会漏掉带分隔符的号码
  // （`138-0013-8000` 被切成 3/4/4 三段，全部不匹配），而只看「去分隔符」会漏掉
  // 相邻的两个号码（`13800138000 13900139000` 会粘成一个 22 位数字）。
  // 两组候选取并集，任一命中即拒。
  const candidates = new Set<string>()
  for (const match of text.matchAll(/\d+/g)) candidates.add(match[0])
  for (const match of text.matchAll(/\d[\d\s\-.·]*\d|\d/g)) {
    candidates.add(match[0].replace(/[\s\-.·]/g, ''))
  }
  for (const digits of candidates) {
    // `+86` 前缀：`8613800138000` 是 13 位，任何长度档都不命中 —— 先剥离国家码再判。
    if (digits.length === 13 && /^861[3-9]\d{9}$/.test(digits)) return '手机号'
    if (digits.length === 11 && /^1[3-9]/.test(digits)) return '手机号'
    // 18 位（纯数字）与 15 位（老身份证）都按身份证处理。15 位必须单独列 ——
    // 它落在下面的银行卡档（16–19）之外，不写就会整类漏过。
    if (digits.length === 18 || digits.length === 15) return '身份证号'
    // 16–19 位纯数字按银行卡处理。19 位订单号之类会被误拦 —— 宁可多拦，
    // 记错的代价远高于拦错的代价。
    if (digits.length >= 16 && digits.length <= 19) return '银行卡号'
  }
  return null
}

/**
 * 正文 + 标签一起过敏感闸。
 *
 * 为什么必须合并判：`tags` 同样是明文落盘、也会出现在 `recall` 结果与设置页卡片里，
 * 而原实现只把 `text` 交给 `findSensitive` —— 手机号写进标签（`tags: ['13800138000']`）
 * 可以完全绕过拦截。用 `\n` 分隔而不是空格，避免标签数字与正文末尾数字粘成一个长串
 * 造成误判。
 */
export function findSensitiveIn(text: string, tags?: readonly string[]): string | null {
  if (tags === undefined || tags.length === 0) return findSensitive(text)
  return findSensitive(text + '\n' + tags.join('\n'))
}

/**
 * chatId → 安全文件名。
 *
 * chatId 形如 `private:123456` / `group:789`，冒号在 Windows 文件名里非法，
 * 因此把所有非 `[A-Za-z0-9._-]` 换成下划线。碰撞风险可接受：chatId 的字符集
 * 来自 OneBot 的纯数字 id 与固定前缀。
 */
export function memoryFileName(chatId: string): string {
  return chatId.replace(/[^A-Za-z0-9._-]/g, '_') + '.jsonl'
}

/** 某个 chat 的记忆文件绝对路径。 */
export function memoryFilePath(memoryDir: string, chatId: string): string {
  return join(memoryDir, memoryFileName(chatId))
}

/** 追加一条记忆；目录不存在时自动创建。 */
export function appendMemory(memoryDir: string, chatId: string, entry: MemoryEntry): void {
  mkdirSync(memoryDir, { recursive: true })
  appendFileSync(memoryFilePath(memoryDir, chatId), JSON.stringify(entry) + '\n', 'utf8')
}

/** `upsertMemory` 的结果。 */
export interface UpsertResult {
  /** true = 命中了完全相同的条目，只刷新了 `lastSeenAt`（没有新增行）。 */
  refreshed: boolean
}

/**
 * 写入一条记忆，并把「完全相同的条目」折成一次提及。
 *
 * 判重口径是 **kind + subject + text 三者全等**，只做精确匹配 —— 近似去重需要相似度
 * 计算（第二批上 embedding 之后再做）。这样重复说同一件事不会堆成几十行，同时
 * `lastSeenAt` 能回答「这条印象最近一次被提到是什么时候」。
 *
 * 注意 `appendMemory` 保持原语义（无条件追加），单测与历史调用方不受影响。
 */
export function upsertMemory(memoryDir: string, chatId: string, entry: MemoryEntry): UpsertResult {
  const entries = readAllMemories(memoryDir, chatId)
  const kindOf = (item: MemoryEntry): MemoryKind => item.kind ?? 'note'
  const index = entries.findIndex((existing) =>
    kindOf(existing) === kindOf(entry)
    && (existing.subject ?? '') === (entry.subject ?? '')
    && existing.text === entry.text)
  if (index < 0) {
    appendMemory(memoryDir, chatId, { ...entry, lastSeenAt: entry.ts })
    return { refreshed: false }
  }
  const previous = entries[index]
  // 刷新时**不能只写 lastSeenAt**：新条目带来的 tags 与向量必须并进去。
  //
  // 原来 `{ ...previous, lastSeenAt }` 会把新的 tags / emb 全部丢掉。后果很具体：
  // 用户先说「周五要交周报」（无标签 → TTL 90 天），后来又说「记住这是待办」
  // （tags: ['待办'] → 本该 14 天），标签没更新，TTL 就一直按 90 天算；
  // 同样，重新编码算出的新向量也被丢弃，换模型后这条永远用旧维度的向量。
  const mergedTags = mergeTags(previous.tags, entry.tags)
  entries[index] = {
    ...previous,
    lastSeenAt: entry.ts,
    ...(mergedTags.length > 0 ? { tags: mergedTags } : {}),
    // 新向量覆盖旧的（以最新一次编码为准）；新条目没带向量就保留原来那条。
    ...(entry.emb !== undefined && entry.emb.length > 0
      ? { emb: entry.emb, dim: entry.emb.length }
      : {}),
  }
  // 写失败直接抛：这里的语义是「这条已经记过了，只刷新时间」，静默失败会让模型
  // 以为刷新成功，而实际上「最近提及」永远停在旧值。
  if (!writeAll(memoryDir, chatId, entries)) throw new Error('记忆写入失败：' + chatId + '（磁盘写入错误）')
  return { refreshed: true }
}

/**
 * 标签取并集（去重、保序、上限 8 —— 与写入侧的 `slice(0, 8)` 同一口径）。
 *
 * 取并集而不是覆盖：用户第二次补充标签（「这条其实是待办」）时不该丢掉第一次的
 * 分类。注意 `ttlDaysFor` 取**第一个命中**的标签，所以顺序会影响 TTL 档位 ——
 * 这是既有口径，不在这里改动。
 */
function mergeTags(left?: readonly string[], right?: readonly string[]): string[] {
  const merged: string[] = []
  for (const tag of [...(left ?? []), ...(right ?? [])]) {
    if (tag === '' || merged.includes(tag)) continue
    merged.push(tag)
    if (merged.length === 8) break
  }
  return merged
}

/**
 * 把条目序列化回 JSONL（裁剪 / 删除 / upsert 共用）。
 *
 * 走 `rewriteMemories` 的 tmp+rename，而不是直接 `writeFileSync`：后者在写入过程中
 * 崩溃/断电会留下半个文件（**所有历史条目**一起损坏），而 rename 是原子的 —— 读者
 * 要么看到旧文件、要么看到新文件。此前两条写路径的原子性不一致，是历史遗留。
 *
 * @returns 是否写入成功。调用方**必须**处理 `false`：静默吞掉会让「删除失败」伪装成
 *          「一条都没命中」，进而被上层报成权限问题（见 `deleteMemoriesWhere`）。
 */
function writeAll(memoryDir: string, chatId: string, entries: readonly MemoryEntry[]): boolean {
  try {
    rewriteMemories(memoryDir, chatId, entries)
    return true
  } catch {
    return false
  }
}

/** 解析一行；非法返回 null（坏行跳过，不让整个文件失效）。 */
function parseLine(line: string): MemoryEntry | null {
  const trimmed = line.trim()
  if (trimmed === '') return null
  try {
    const parsed = JSON.parse(trimmed) as Partial<MemoryEntry>
    if (typeof parsed.text !== 'string' || parsed.text === '') return null
    const tags = Array.isArray(parsed.tags)
      ? parsed.tags.filter((t): t is string => typeof t === 'string')
      : undefined
    const kind: MemoryKind | undefined = parsed.kind === 'profile' ? 'profile' : undefined
    const role: MemoryRole | undefined = parsed.role === 'admin' ? 'admin' : parsed.role === 'member' ? 'member' : undefined
    const by = typeof parsed.by === 'string' && parsed.by !== '' ? parsed.by : undefined
    const subject = typeof parsed.subject === 'string' && parsed.subject !== '' ? parsed.subject : undefined
    const lastSeenAt = typeof parsed.lastSeenAt === 'number' && Number.isFinite(parsed.lastSeenAt) && parsed.lastSeenAt > 0
      ? parsed.lastSeenAt
      : undefined
    // 向量只在「全是有限数字且非空」时才认；任何一项坏了就整条丢弃 —— 半个向量
    // 参与余弦会算出无意义的分，比没有向量更糟（正确做法是当作未编码，走关键词）。
    const emb = Array.isArray(parsed.emb)
      && parsed.emb.length > 0
      && parsed.emb.every((value) => typeof value === 'number' && Number.isFinite(value))
      ? parsed.emb as number[]
      : undefined
    const dim = emb !== undefined ? emb.length : undefined
    // `ts` 是条目的**标识**：`deleteMemory` / `updateMemory` / 面板编辑都按它定位。
    // 缺失或非法时用 `lastSeenAt` 兜底；两者都没有就整行跳过。
    //
    // 为什么不能归 0：一条 `ts: 0` 的记忆恒判过期（`now - 0` 必然超过任何 TTL，
    // 于是永不召回），而且**所有**坏行会共享 `ts = 0` 这一个标识 —— 删一条就把它们
    // 全删掉。宁可让这一行读不出来（内容仍在文件里），也不要制造这种身份冲突。
    const stamp = typeof parsed.ts === 'number' && Number.isFinite(parsed.ts) && parsed.ts > 0
      ? parsed.ts
      : (lastSeenAt ?? 0)
    if (stamp <= 0) return null
    return {
      ts: stamp,
      text: parsed.text,
      ...(tags !== undefined && tags.length > 0 ? { tags } : {}),
      ...(kind !== undefined ? { kind } : {}),
      ...(by !== undefined ? { by } : {}),
      ...(role !== undefined ? { role } : {}),
      ...(subject !== undefined ? { subject } : {}),
      ...(lastSeenAt !== undefined ? { lastSeenAt } : {}),
      ...(emb !== undefined ? { emb } : {}),
      ...(dim !== undefined ? { dim } : {}),
    }
  } catch {
    return null
  }
}

/** 读取某个 chat 的全部记忆（旧→新）。 */
export function readAllMemories(memoryDir: string, chatId: string): MemoryEntry[] {
  const file = memoryFilePath(memoryDir, chatId)
  if (!existsSync(file)) return []
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    return []
  }
  const entries: MemoryEntry[] = []
  for (const line of raw.split('\n')) {
    const entry = parseLine(line)
    if (entry !== null) entries.push(entry)
  }
  return entries
}

/** 读取某个 chat 的记忆（旧→新），`max` 只保留最近的若干条。 */
export function readMemories(memoryDir: string, chatId: string, max = 200): MemoryEntry[] {
  const entries = readAllMemories(memoryDir, chatId)
  return entries.length > max ? entries.slice(entries.length - max) : entries
}

/**
 * 把某个 chat 的记忆裁剪到最近 `max` 条（原地重写）。
 *
 * 追加式存储不裁剪会无限增长；这里在每次写入后调用，代价是每次重写整个文件
 * —— 200 条量级下可以接受。
 *
 * @returns 被丢弃的条数（0 表示未裁剪）。
 */
export function trimMemories(memoryDir: string, chatId: string, max: number): number {
  if (max <= 0) return 0
  const all = readAllMemories(memoryDir, chatId)
  if (all.length <= max) return 0
  const kept = all.slice(all.length - max)
  // 裁剪失败**不抛**：它是「防止无限增长」的兜底，失败最多让文件多留几条，
  // 不该让这次 remember 整体失败（用户已经被告知「记住了」）。下一次写入会重试。
  return writeAll(memoryDir, chatId, kept) ? all.length - kept.length : 0
}

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
export function forgetProfiles(memoryDir: string, chatId: string, subject: string | undefined): number {
  const wanted = subject ?? ''
  if (wanted === '') return 0
  const all = readAllMemories(memoryDir, chatId)
  const kept = all.filter((entry) => {
    if ((entry.kind ?? 'note') !== 'profile') return true
    return entry.subject !== wanted
  })
  const removed = all.length - kept.length
  if (removed === 0) return 0
  return writeAll(memoryDir, chatId, kept) ? removed : 0
}

/**
 * 删掉本会话**所有**画像（`note` 保留）。
 *
 * 与 `forgetProfiles` 分开命名，是为了让「删一个人」和「删全部」在调用点一眼可辨 ——
 * 同一个函数靠 `subject` 是否为空来区分，是这类误删的经典来源。
 *
 * @returns 被删除的条数。
 */
export function forgetAllProfiles(memoryDir: string, chatId: string): number {
  const all = readAllMemories(memoryDir, chatId)
  const kept = all.filter((entry) => (entry.kind ?? 'note') !== 'profile')
  const removed = all.length - kept.length
  if (removed === 0) return 0
  return writeAll(memoryDir, chatId, kept) ? removed : 0
}

/**
 * 按谓词批量删除（`qq_memory_forget` 用），一次重写整个文件。
 *
 * 为什么不复用 `deleteMemory`：那个按 `ts` 删**单条**，而 forget 需要「关键词命中
 * + 权限过滤」的组合条件，逐条删会重写 N 次文件。
 *
 * @returns 被删除的条目（调用方用它回显「删了什么」，否则模型只能猜）。
 */
export function deleteMemoriesWhere(
  memoryDir: string,
  chatId: string,
  predicate: (entry: MemoryEntry) => boolean,
): MemoryEntry[] {
  const all = readAllMemories(memoryDir, chatId)
  const removed: MemoryEntry[] = []
  const kept: MemoryEntry[] = []
  for (const entry of all) {
    if (predicate(entry)) removed.push(entry)
    else kept.push(entry)
  }
  if (removed.length === 0) return []
  // 写失败必须抛，不能返回空数组：上层（`qq_memory_forget`）拿到空数组会判定为
  // 「一条都没命中你会删的」，进而报「你只能删除自己写的」—— 真正的磁盘故障被
  // 伪装成权限不足，模型会据此改用 `remember` 再记一条。
  if (!writeAll(memoryDir, chatId, kept)) throw new Error('记忆删除失败：' + chatId + '（磁盘写入错误）')
  return removed
}

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
export function writeMemoryEmbeddings(
  memoryDir: string,
  chatId: string,
  updates: readonly { ts: number; text: string; emb: readonly number[] }[],
): number {
  if (updates.length === 0) return 0
  /** `ts` 与 `text` 用 `\u0000` 连接：正文里不会有 NUL，避免拼接歧义。 */
  const keyOf = (ts: number, text: string): string => ts + '\u0000' + text
  const byKey = new Map<string, readonly number[]>()
  for (const item of updates) {
    if (item.emb.length > 0) byKey.set(keyOf(item.ts, item.text), item.emb)
  }
  if (byKey.size === 0) return 0
  const entries = readAllMemories(memoryDir, chatId)
  let written = 0
  const next = entries.map((entry) => {
    const vector = byKey.get(keyOf(entry.ts, entry.text))
    if (vector === undefined) return entry
    written += 1
    return { ...entry, emb: [...vector], dim: vector.length }
  })
  if (written === 0) return 0
  rewriteMemories(memoryDir, chatId, next)
  return written
}

/** `private_123.jsonl` → `private:123`；不是记忆文件时返回 undefined（`memoryFileName` 的逆）。 */
export function chatIdFromFileName(name: string): string | undefined {
  if (!name.toLowerCase().endsWith('.jsonl')) return undefined
  const base = name.slice(0, name.length - '.jsonl'.length)
  const match = /^(private|group)_(.+)$/.exec(base)
  return match === null ? undefined : match[1] + ':' + match[2]
}

/** 一个会话的记忆文件概览。 */
export interface MemoryFileInfo {
  chatId: string
  bytes: number
  mtimeMs: number
}

/**
 * 列出所有记忆文件（**只 stat，不解析内容**）。
 *
 * 面板会话列表靠它：解析上千条 JSON 只为显示「有几个会话」不值得，
 * 大小与 mtime 足以排序与展示；具体条目由 `readMemoryEntries` 按需分页读取。
 */
export function listMemoryFiles(memoryDir: string): MemoryFileInfo[] {
  let names: string[]
  try {
    names = readdirSync(memoryDir)
  } catch {
    return []
  }
  const files: MemoryFileInfo[] = []
  for (const name of names) {
    const chatId = chatIdFromFileName(name)
    if (chatId === undefined) continue
    try {
      const info = statSync(join(memoryDir, name))
      if (!info.isFile()) continue
      files.push({ chatId, bytes: info.size, mtimeMs: info.mtimeMs })
    } catch {
      // 遍历过程中被删：跳过
    }
  }
  return files.sort((left, right) => right.mtimeMs - left.mtimeMs)
}

/**
 * 整文件原子重写（update/delete 共用）。
 *
 * 面板保存时模型可能正好在 `appendMemory`，直接覆盖会丢掉那次追加 —— 先写 `.tmp` 再
 * `rename` 保证读到的永远是完整文件；代价是极端并发下仍可能丢一条追加，与「记忆是
 * 增强功能、不阻塞主链路」的既有取舍一致。
 */
function rewriteMemories(memoryDir: string, chatId: string, entries: readonly MemoryEntry[]): void {
  mkdirSync(memoryDir, { recursive: true })
  const body = entries.length === 0 ? '' : entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n'
  const file = memoryFilePath(memoryDir, chatId)
  const temp = file + '.tmp'
  writeFileSync(temp, body, 'utf8')
  renameSync(temp, file)
}

/** 面板编辑：只允许改正文与标签（`ts`/`kind`/`subject` 是身份，不可改）。 */
export interface MemoryEditPatch {
  text?: string
  tags?: string[]
}

/** 按 `ts` 更新一条记忆；返回是否命中（同毫秒多条时只改第一条）。 */
export function updateMemory(memoryDir: string, chatId: string, ts: number, patch: MemoryEditPatch): boolean {
  const entries = readAllMemories(memoryDir, chatId)
  const index = entries.findIndex((entry) => entry.ts === ts)
  if (index < 0) return false
  const next: MemoryEntry = { ...entries[index] }
  const textChanged = patch.text !== undefined && patch.text !== entries[index].text
  if (patch.text !== undefined) next.text = patch.text
  if (patch.tags !== undefined) {
    if (patch.tags.length === 0) delete next.tags
    else next.tags = patch.tags
  }
  // 正文改了 → 旧向量指向的是**旧语义**，必须失效。
  //
  // 保留它比删掉更糟：向量不变而文本变，这条记忆会在**不相关**的查询里被召回
  // （虚假相似），而且看起来「一切正常」，极难发现。`dim` 也一并清掉，让后台补齐
  // 任务按 `emb === undefined` 统一处理「新增未编码」与「编辑后失效」两种来源。
  //
  // 只改 tags 不失效：标签只参与关键词打分，不进 embedding。
  if (textChanged) {
    delete next.emb
    delete next.dim
  }
  entries[index] = next
  rewriteMemories(memoryDir, chatId, entries)
  return true
}

/** 按 `ts` 删除一条记忆；返回是否命中。 */
export function deleteMemory(memoryDir: string, chatId: string, ts: number): boolean {
  const entries = readAllMemories(memoryDir, chatId)
  const kept = entries.filter((entry) => entry.ts !== ts)
  if (kept.length === entries.length) return false
  rewriteMemories(memoryDir, chatId, kept)
  return true
}

/** 中文按 2-gram、英文/数字按连续片段切词；结果去重并小写。 */
export function tokenize(text: string): string[] {
  const lower = text.toLowerCase()
  const tokens = new Set<string>()
  // 英文/数字片段
  for (const m of lower.matchAll(/[a-z0-9]+/g)) {
    if (m[0].length >= 2) tokens.add(m[0])
  }
  // 连续汉字：长度 1 保留单字，长度 ≥2 出 2-gram 与整段
  for (const m of lower.matchAll(/[\u4e00-\u9fa5]+/g)) {
    const run = m[0]
    if (run.length === 1) {
      tokens.add(run)
      continue
    }
    tokens.add(run)
    for (let i = 0; i + 1 < run.length; i += 1) tokens.add(run.slice(i, i + 2))
  }
  return [...tokens]
}

/** 取一条 user/message 事件的纯文本（content 可能是字符串或 blocks 数组）。 */
function textOfUserEvent(data: unknown): string | undefined {
  if (data === null || typeof data !== 'object') return undefined
  const content = (data as { content?: unknown }).content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return undefined
  const parts: string[] = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    const typed = block as { type?: unknown; text?: unknown }
    if (typed.type === 'text' && typeof typed.text === 'string') parts.push(typed.text)
  }
  return parts.length > 0 ? parts.join('\n') : undefined
}

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
export function speakerFromUserEvents(events: readonly unknown[]): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index] as { type?: unknown; data?: unknown } | null | undefined
    if (event === null || typeof event !== 'object') continue
    if (event.type !== 'user/message') continue
    const text = textOfUserEvent(event.data)
    if (text === undefined) return undefined
    return /<user_message[^>]*\sqq="(\d+)"/.exec(text)?.[1]
  }
  return undefined
}

/**
 * 一条记忆的关键词相关度（0~1）：命中词数 / 查询词数，长词加权，长度做轻微惩罚。
 *
 * 抽成独立函数是为了让「纯关键词」与「混合召回」用**同一份口径** —— 两套实现
 * 会慢慢漂移，表现为同一条记忆在 recall 与面板搜索里的命中顺序不一样。
 *
 * @param entry - 记忆条目（正文 + 标签一起参与匹配）。
 * @param queryTokens - 已切好的查询词（调用方负责，避免每条重复分词）。
 */
export function keywordScore(entry: MemoryEntry, queryTokens: readonly string[]): number {
  if (queryTokens.length === 0) return 0
  const haystack = entry.text + (entry.tags !== undefined ? ' ' + entry.tags.join(' ') : '')
  const entryTokens = new Set(tokenize(haystack))
  let weight = 0
  let matched = 0
  for (const token of queryTokens) {
    if (!entryTokens.has(token)) continue
    matched += 1
    // 长词更能代表意图（「螺蛳粉」比「粉」更有区分度）
    weight += Math.min(token.length, 4)
  }
  if (matched === 0) return 0
  const coverage = matched / queryTokens.length
  const lengthPenalty = 1 / (1 + Math.log10(1 + entry.text.length / 100))
  return Number((coverage * lengthPenalty + weight * 0.001).toFixed(4))
}

/**
 * 关键词召回：命中词数 / 查询词数，长词加权，长度做轻微惩罚。
 *
 * 这是「字面召回」——「辣的粉」搜不到「螺蛳粉」。语义召回见 `searchMemoriesHybrid`。
 */
export function searchMemories(entries: readonly MemoryEntry[], query: string, topK = 5): MemoryHit[] {
  const queryTokens = tokenize(query)
  if (queryTokens.length === 0 || topK <= 0) return []
  const hits: MemoryHit[] = []
  for (const entry of entries) {
    const score = keywordScore(entry, queryTokens)
    if (score <= 0) continue
    hits.push({ entry, score })
  }
  hits.sort((a, b) => (b.score - a.score) || (b.entry.ts - a.entry.ts))
  return hits.slice(0, topK)
}

/**
 * 余弦相似度（0~1，负相关压到 0）。
 *
 * 维度不一致直接返回 0 —— 它只是一个打分分量，不该抛错；真正的「维度不兼容」
 * 由调用方按 `emb.length` 过滤（见 `searchMemoriesHybrid`）。
 */
export function cosineSimilarity(left: readonly number[], right: readonly number[]): number {
  if (left.length === 0 || left.length !== right.length) return 0
  let dot = 0
  let normLeft = 0
  let normRight = 0
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index]
    const b = right[index]
    dot += a * b
    normLeft += a * a
    normRight += b * b
  }
  if (normLeft === 0 || normRight === 0) return 0
  const cosine = dot / Math.sqrt(normLeft * normRight)
  // 负相关当成 0：语义相反不该得到「半个命中」，否则它会挤掉真正无关但中性的条目。
  return cosine > 0 ? Number(cosine.toFixed(4)) : 0
}

/** 混合召回选项。 */
export interface HybridSearchOptions {
  /** 查询向量；缺省 = 只走关键词（与第一批行为完全一致）。 */
  queryVector?: readonly number[] | undefined
  /** 语义权重 0~1，缺省 0.6（0 = 纯关键词，1 = 纯语义）。 */
  weight?: number | undefined
  topK?: number | undefined
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
export function searchMemoriesHybrid(
  entries: readonly MemoryEntry[],
  query: string,
  options: HybridSearchOptions = {},
): MemoryHit[] {
  const topK = options.topK ?? 5
  if (topK <= 0) return []
  const queryTokens = tokenize(query)
  const queryVector = options.queryVector
  const semantic = queryVector !== undefined && queryVector.length > 0
  if (queryTokens.length === 0 && !semantic) return []
  const weight = Number.isFinite(options.weight) ? Math.max(0, Math.min(1, options.weight as number)) : 0.6
  // `weight === 1` = 只用语义：没有向量的条目就没有语义分，不该靠关键词挤进来
  // （否则「1 = 纯语义」名不副实）。`weight < 1` 仍保持「无向量不打折」—— 那才是
  // 默认配置下历史条目不被系统性压低的关键。
  const pureSemantic = semantic && weight >= 1
  const hits: MemoryHit[] = []
  for (const entry of entries) {
    const keyword = keywordScore(entry, queryTokens)
    let score = 0
    if (semantic && entry.emb !== undefined && entry.emb.length === queryVector.length) {
      score = weight * cosineSimilarity(queryVector, entry.emb) + (1 - weight) * keyword
    } else if (pureSemantic) {
      continue
    } else {
      score = keyword
    }
    if (score <= 0) continue
    hits.push({ entry, score: Number(score.toFixed(4)) })
  }
  hits.sort((a, b) => (b.score - a.score) || (b.entry.ts - a.entry.ts))
  return hits.slice(0, topK)
}
