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

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** 一条记忆。字段刻意保持最小：正文 + 时间 + 可选标签。 */
export interface MemoryEntry {
  /** 写入时间（epoch ms），用于排序与「最近优先」截断。 */
  ts: number
  /** 记忆正文。调用方负责裁剪长度。 */
  text: string
  /** 可选标签，参与检索打分。 */
  tags?: string[]
}

/** 召回结果。 */
export interface MemoryHit {
  entry: MemoryEntry
  /** 归一化后的相关度（0~1，仅用于排序，不保证跨查询可比）。 */
  score: number
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

/**
 * 读取某个 chat 的记忆（旧→新）。
 *
 * 坏行（截断、手改坏）直接跳过而不是整体失败：记忆是增强功能，一条坏记录
 * 不该让 recall 整个不可用。
 */
export function readMemories(memoryDir: string, chatId: string, max = 200): MemoryEntry[] {
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
    const trimmed = line.trim()
    if (trimmed === '') continue
    try {
      const parsed = JSON.parse(trimmed) as Partial<MemoryEntry>
      if (typeof parsed.text !== 'string' || parsed.text === '') continue
      const tags = Array.isArray(parsed.tags)
        ? parsed.tags.filter((t): t is string => typeof t === 'string')
        : undefined
      entries.push({
        ts: typeof parsed.ts === 'number' && Number.isFinite(parsed.ts) ? parsed.ts : 0,
        text: parsed.text,
        ...(tags !== undefined && tags.length > 0 ? { tags } : {}),
      })
    } catch {
      // 坏行跳过
    }
  }
  return entries.length > max ? entries.slice(entries.length - max) : entries
}

/**
 * 把某个 chat 的记忆裁剪到最近 `max` 条（原地重写）。
 *
 * 追加式存储不裁剪会无限增长；这里在每次写入后调用，代价是每次重写整个文件
 * —— 200 条量级下可以接受，换成「每 N 次裁剪一次」是后续优化点。
 *
 * @returns 被丢弃的条数（0 表示未裁剪）。
 */
export function trimMemories(memoryDir: string, chatId: string, max: number): number {
  if (max <= 0) return 0
  const all = readMemories(memoryDir, chatId, Number.MAX_SAFE_INTEGER)
  if (all.length <= max) return 0
  const kept = all.slice(all.length - max)
  try {
    mkdirSync(memoryDir, { recursive: true })
    writeFileSync(memoryFilePath(memoryDir, chatId), kept.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8')
  } catch {
    return 0
  }
  return all.length - kept.length
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
