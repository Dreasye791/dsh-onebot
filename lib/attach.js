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

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const LEDGER_FILE = 'attachment-ledger.json'

/** 递归统计一个目录：字节数与文件数。目录不存在时返回 0/0。 */
export function dirUsage(dir) {
  let bytes = 0
  let files = 0
  const walk = (path) => {
    let names
    try {
      names = readdirSync(path)
    } catch {
      return
    }
    for (const name of names) {
      const child = join(path, name)
      let st
      try {
        st = statSync(child)
      } catch {
        continue
      }
      if (st.isDirectory()) walk(child)
      else if (st.isFile()) {
        bytes += st.size
        files += 1
      }
    }
  }
  walk(dir)
  return { bytes, files }
}

/** 读账本；文件缺失/损坏都返回空账本（统计是旁路，不因坏文件而抛）。 */
export function readLedger(mediaDir) {
  const file = join(mediaDir, LEDGER_FILE)
  try {
    if (!existsSync(file)) return { version: 1, entries: {} }
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    if (parsed === null || typeof parsed !== 'object' || parsed.entries === null || typeof parsed.entries !== 'object') {
      return { version: 1, entries: {} }
    }
    return { version: 1, entries: parsed.entries }
  } catch {
    return { version: 1, entries: {} }
  }
}

/** 写账本；失败仅返回 false（调用方降级为 warn，不影响图片投递）。 */
export function writeLedger(mediaDir, ledger) {
  try {
    writeFileSync(join(mediaDir, LEDGER_FILE), JSON.stringify(ledger, null, 2), 'utf8')
    return true
  } catch {
    return false
  }
}

/** 账本当前累计字节数。 */
export function ledgerBytes(ledger) {
  let total = 0
  for (const entry of Object.values(ledger.entries)) total += entry.bytes
  return total
}

/**
 * 是否还有预算投递新图。
 *
 * 只做「累计已用 < 上限」的粗判：内容寻址去重是否命中要等宿主返回才知，
 * 因此超限时连去重命中也会被拦下——保守但绝不会因为一次刷屏把磁盘吃穿，
 * 且超限后 `/storage` 会明确显示「已达上限」，用户可调高或清理后恢复。
 * @param ledger - 当前账本。
 * @param policy - 投递策略。
 */
export function withinBudget(ledger, policy) {
  if (policy.budgetBytes <= 0) return true
  return ledgerBytes(ledger) < policy.budgetBytes
}

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
export function recordContribution(
  ledger,
  ref,
  now,
) {
  const id = typeof ref.attachmentId === 'string' ? ref.attachmentId : ''
  if (id === '') return false
  const bytes = typeof ref.bytes === 'number' && Number.isFinite(ref.bytes) && ref.bytes > 0 ? ref.bytes : 0
  const existing = ledger.entries[id]
  if (existing !== undefined) {
    existing.hits += 1
    existing.lastSeenAt = now
    return true
  }
  ledger.entries[id] = { attachmentId: id, bytes, firstSeenAt: now, lastSeenAt: now, hits: 1 }
  return false
}

/** 汇总容量统计（供 /storage 命令使用）。 */
export function storageStats(mediaDir, attachmentsDir, policy) {
  const media = dirUsage(mediaDir)
  const attachments = dirUsage(attachmentsDir)
  const ledger = readLedger(mediaDir)
  const entries = Object.values(ledger.entries)
  let bytes = 0
  let dedupHits = 0
  for (const entry of entries) {
    bytes += entry.bytes
    if (entry.hits > 1) dedupHits += entry.hits - 1
  }
  return {
    mediaDir,
    mediaBytes: media.bytes,
    mediaFiles: media.files,
    attachmentsDir,
    attachmentsBytes: attachments.bytes,
    attachmentsFiles: attachments.files,
    ledgerObjects: entries.length,
    ledgerBytes: bytes,
    ledgerDedupHits: dedupHits,
    budgetBytes: policy.budgetBytes,
    budgetExhausted: policy.budgetBytes > 0 && bytes >= policy.budgetBytes,
  }
}

/** 宿主内建支持的图片 MIME（dsh-attachment-local 的 mediaTypes 默认集合）。 */
const HOST_MEDIA_TYPES = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
}

/** 从本地文件名推断宿主可接受的 MIME；不支持则 undefined。 */
export function hostMediaType(path) {
  const dot = path.lastIndexOf('.')
  if (dot < 0) return undefined
  return HOST_MEDIA_TYPES[path.slice(dot + 1).toLowerCase()]
}

/** 一个 MiB，供配置项（MB）换算成字节。 */
export const MIB = 1024 * 1024

/**
 * 由配置构造投递策略。
 *
 * 边界处理：非正数（含负数、NaN）的字节上限统一按 0（不限）处理——配置写错
 * 成 -1 时若当上限用，会让**所有**图片都被拒，那比放开更糟。
 * @param config - 三项配置（enabled 直接取用；两个上限已是字节单位）。
 * @returns 归一化后的策略。
 */
export function resolveAttachPolicy(config) {
  const max = Number.isFinite(config.maxImageBytes) ? config.maxImageBytes : 0
  const budget = Number.isFinite(config.budgetBytes) ? config.budgetBytes : 0
  return {
    enabled: config.enabled,
    maxImageBytes: max > 0 ? Math.round(max) : 0,
    budgetBytes: budget > 0 ? Math.round(budget) : 0,
  }
}

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
export async function deliverImage(
  attachments,
  path,
  policy,
  mediaDir,
) {
  if (!policy.enabled) return { skipped: 'disabled' }
  const mediaType = hostMediaType(path)
  if (mediaType === undefined) return { skipped: 'unsupported-type' }
  let size = 0
  try {
    size = statSync(path).size
  } catch {
    return { skipped: 'save-failed' }
  }
  if (size <= 0) return { skipped: 'save-failed' }
  if (policy.maxImageBytes > 0 && size > policy.maxImageBytes) return { skipped: 'too-large' }
  const host = attachments
  if (host === undefined || host === null || typeof host.saveImages !== 'function') {
    return { skipped: 'host-unavailable' }
  }
  const ledger = readLedger(mediaDir)
  if (!withinBudget(ledger, policy)) return { skipped: 'budget' }
  let data
  try {
    data = readFileSync(path)
  } catch {
    return { skipped: 'save-failed' }
  }
  let refs
  try {
    refs = await host.saveImages([{
      data: new Uint8Array(data),
      mediaType,
      name: path.slice(Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/')) + 1),
    }])
  } catch {
    return { skipped: 'save-failed' }
  }
  const ref = Array.isArray(refs) ? refs[0] : undefined
  if (ref === undefined || ref === null || typeof ref !== 'object'
    || typeof ref.attachmentId !== 'string' || ref.attachmentId === '') {
    return { skipped: 'save-failed' }
  }
  const dedupHit = recordContribution(ledger, ref, Date.now())
  writeLedger(mediaDir, ledger)
  return { ref, dedupHit }
}

/** 人类可读字节数（与 health.ts 的 formatBytes 同口径，避免跨模块耦合重复导入）。 */
export function humanBytes(size) {
  if (!Number.isFinite(size) || size <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = size
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return (unit === 0 ? String(Math.round(value)) : value.toFixed(1)) + ' ' + units[unit]
}

/** 把统计快照渲染成一段中文多行文本（/storage 与工具共用）。 */
export function formatStorageStats(stats) {
  const lines = [
    '媒体目录：' + stats.mediaDir,
    '  ' + humanBytes(stats.mediaBytes) + '（' + stats.mediaFiles + ' 个文件）',
    '附件库（宿主所有）：' + stats.attachmentsDir,
    '  ' + humanBytes(stats.attachmentsBytes) + '（' + stats.attachmentsFiles + ' 个文件）',
    '本插件贡献：' + stats.ledgerObjects + ' 个对象 / ' + humanBytes(stats.ledgerBytes) +
      (stats.ledgerDedupHits > 0 ? '（去重命中 ' + stats.ledgerDedupHits + ' 次，未重复占用）' : ''),
  ]
  if (stats.budgetBytes > 0) {
    const percent = Math.min(100, Math.round((stats.ledgerBytes / stats.budgetBytes) * 100))
    lines.push('软上限：' + humanBytes(stats.budgetBytes) + '，已用 ' + percent + '%' +
      (stats.budgetExhausted ? '（已达上限：新图片改为只提供路径）' : ''))
  } else {
    lines.push('软上限：未设置（attachmentBudgetMB=0，不限制）')
  }
  return lines.join('\n')
}

