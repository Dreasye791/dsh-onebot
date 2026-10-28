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

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
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
  // 按「整段连续数字」判长度，而不是在长串里找子串：
  // 最初用 `1[3-9]\d{9}` 无边界匹配，18 位身份证里的 11 位连续数字会被当成手机号，
  // 13 位时间戳也会被截取命中（`1` + `7` + 9 位）。长度口径没有这个问题。
  //
  // 18 位里最后一位可能是 X（校验位），单独判一次。
  if (/(^|\D)\d{17}[Xx](\D|$)/.test(text)) return '身份证号'
  for (const match of text.matchAll(/\d+/g)) {
    const digits = match[0]
    const length = digits.length
    if (length === 18) return '身份证号'
    if (length === 11 && /^1[3-9]/.test(digits)) return '手机号'
    // 16–19 位纯数字按银行卡处理。19 位订单号之类会被误拦 —— 宁可多拦，
    // 记错的代价远高于拦错的代价。
    if (length >= 16 && length <= 19) return '银行卡号'
  }
  return null
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

/** 把条目序列化回 JSONL（裁剪/删除共用）。 */
function writeAll(memoryDir: string, chatId: string, entries: readonly MemoryEntry[]): boolean {
  try {
    mkdirSync(memoryDir, { recursive: true })
    writeFileSync(memoryFilePath(memoryDir, chatId), entries.map((e) => JSON.stringify(e)).join('\n') + (entries.length > 0 ? '\n' : ''), 'utf8')
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
    return {
      ts: typeof parsed.ts === 'number' && Number.isFinite(parsed.ts) ? parsed.ts : 0,
      text: parsed.text,
      ...(tags !== undefined && tags.length > 0 ? { tags } : {}),
      ...(kind !== undefined ? { kind } : {}),
      ...(by !== undefined ? { by } : {}),
      ...(role !== undefined ? { role } : {}),
      ...(subject !== undefined ? { subject } : {}),
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
  return writeAll(memoryDir, chatId, kept) ? all.length - kept.length : 0
}

/**
 * 删掉某个主体的全部画像（`/memory forget`）。
 *
 * `subject` 为空时删掉所有 profile（管理员清理用，调用方负责判权）。
 *
 * @returns 被删除的条数。
 */
export function forgetProfiles(memoryDir: string, chatId: string, subject?: string): number {
  const all = readAllMemories(memoryDir, chatId)
  const kept = all.filter((entry) => {
    if ((entry.kind ?? 'note') !== 'profile') return true
    if (subject === undefined || subject === '') return false
    return entry.subject !== subject
  })
  const removed = all.length - kept.length
  if (removed === 0) return 0
  return writeAll(memoryDir, chatId, kept) ? removed : 0
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
 * 关键词召回：命中词数 / 查询词数，长词加权，长度做轻微惩罚。
 *
 * 这是「字面召回」——「辣的粉」搜不到「螺蛳粉」。第二批接 embedding 后可把
 * 这里换成余弦相似度，函数签名不变。
 */
export function searchMemories(entries: readonly MemoryEntry[], query: string, topK = 5): MemoryHit[] {
  const queryTokens = tokenize(query)
  if (queryTokens.length === 0 || topK <= 0) return []
  const hits: MemoryHit[] = []
  for (const entry of entries) {
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
    if (matched === 0) continue
    const coverage = matched / queryTokens.length
    const lengthPenalty = 1 / (1 + Math.log10(1 + entry.text.length / 100))
    hits.push({ entry, score: Number((coverage * lengthPenalty + weight * 0.001).toFixed(4)) })
  }
  hits.sort((a, b) => (b.score - a.score) || (b.entry.ts - a.entry.ts))
  return hits.slice(0, topK)
}
