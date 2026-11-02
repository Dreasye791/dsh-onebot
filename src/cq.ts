/**
 * OneBot 11 message parsing: CQ-code unescaping, segment-array → text/media
 * extraction, mention detection, and face-id → readable label mapping. Ported
 * from the Hermes onebot_utils.py (CQ parsing half). Pure functions, no I/O.
 * @module dsh-onebot/cq
 */

import { FACE_NAMES } from './face-names.js'

/** One OneBot 11 message segment. */
export interface OneBotSegment {
  type: string
  data: Record<string, string>
}

/** A media reference extracted from an inbound message, resolved by media.ts. */
export interface MediaRef {
  kind: 'image' | 'voice' | 'video' | 'file'
  /** Remote URL to download (image/voice/video). */
  url?: string
  /** raw file field: base64://..., file://..., or a hash. */
  file?: string
  /** OneBot file_id (NapCat file segments carry the real id here). */
  fileId?: string
  name?: string
  subType?: string
}

/** A fully parsed inbound message. */
export interface ParsedMessage {
  /** Plain text with media placeholders, ready for the agent. */
  text: string
  media: MediaRef[]
  /** OneBot message_id of the quoted (reply) message, if any. */
  replyId?: string
  /** OneBot forward id embedded in the message, if any. */
  forwardId?: string
}

/**
 * Reverse the CQ escaping NapCat applies inside attribute values
 * (&amp; → &, &#91; → [, &#93; → ], &#44; → ,). Skipping this broke
 * image-CDN downloads with a 403 (the & in signed URLs arrived escaped).
 * @param value - raw CQ attribute value or text.
 * @returns unescaped value.
 */
export function cqUnescape(value: string): string {
  return value
    .replaceAll('&#91;', '[')
    .replaceAll('&#93;', ']')
    .replaceAll('&#44;', ',')
    .replaceAll('&amp;', '&')
}


/** QQ face id → emoji (common set; unknown ids fall back to a neutral face). */
/**
 * Map a QQ face id to a readable inbound label.
 *
 * The id is the QQ panel slot (NapCat's `QSid`), so the name has to come from
 * `face-names.ts` — generated from NapCat's own qface asset. There is
 * deliberately no emoji guess: a wrong emoji reads as the sender's mood, and an
 * id=289 「睁眼」 used to arrive as 🐛 for exactly that reason. An unknown id
 * keeps its raw value so a missing table row stays diagnosable instead of
 * collapsing into a neutral face.
 */
export function faceToLabel(id: string): string {
  const name = FACE_NAMES[id]
  if (name !== undefined) return '[表情:' + name + ']'
  return id !== '' ? '[表情:id=' + id + ']' : '[表情]'
}


const CQ_AT_RE = /\[CQ:at,qq=([^,\]]+)\]/g

/**
 * Detect explicit @bot / @all only; a reply segment never implies an @.
 *
 * 为什么单独拆出来：门禁的决策是「显式 @ → 直接放行；否则若带 replyId，再去
 * get_msg 校验被引作者」，两件事正交。合在一个函数里会让「新增一条提及规则」
 * 必须同时改三个分支（段数组 / CQ 字符串 / 引用作者），也让门禁无法区分
 * 「无效 id / 取数失败 / 作者未知 / 引用了别人」这四种丢弃原因。
 * @param segments - segment array (may be undefined for CQ-only payloads).
 * @param raw - raw CQ string.
 * @param selfId - learned bot QQ id ('' when unknown).
 * @param botQQ - configured bot QQ id ('' when unset).
 * @returns whether this message explicitly mentions the known bot.
 */
export function detectExplicitMention(
  segments: OneBotSegment[] | undefined,
  raw: string,
  selfId: string,
  botQQ: string,
): boolean {
  const bot = selfId !== '' ? selfId : botQQ
  if (bot === '') return false
  // 空数组要按「没有段」处理，与 parseMessage（本文件 :208 的
  // `segments !== undefined && segments.length > 0 ? segments : parseCqString(raw)`）
  // 保持同一判据：normalizeOneBot11 在 event.message 为 [] 时会把 segments 置为 []
  // 但保留 raw_message，若这里只判 `!== undefined`，正文由 raw 解析出了 @、
  // 提及判定却在空循环后返回 false —— 真实 @机器人 反而在 requireMention 群里被丢弃。
  if (segments !== undefined && segments.length > 0) {
    return segments.some(seg => seg.type === 'at' && (seg.data.qq === bot || seg.data.qq === 'all'))
  }
  CQ_AT_RE.lastIndex = 0
  for (const m of raw.matchAll(CQ_AT_RE)) {
    if (m[1] === bot || m[1] === 'all') return true
  }
  return false
}

/**
 * Detect whether the message mentions the bot: an explicit @ first, then a reply
 * segment that carries the target qq as an adapter extension (the OneBot 11 spec's
 * reply segment has only `id`; NapCat et al. may add `qq`).
 *
 * A bare reply id carries **no author information** and therefore cannot imply a
 * mention — the inbound gate resolves the quoted author via get_msg for that case
 * and decides there (see `replyTargetIsBot`). Keeping that decision out of here is
 * what lets the gate report *why* it dropped a message.
 * @param segments - segment array (may be undefined for CQ-only payloads).
 * @param raw - raw CQ string.
 * @param selfId - learned bot QQ id ('' when unknown).
 * @param botQQ - configured bot QQ id ('' when unset).
 */
export function detectMention(
  segments: OneBotSegment[] | undefined,
  raw: string,
  selfId: string,
  botQQ: string,
): boolean {
  if (detectExplicitMention(segments, raw, selfId, botQQ)) return true
  const bot = selfId !== '' ? selfId : botQQ
  if (bot === '') return false
  // 同样保留「空数组回落 raw」的判据：normalizeOneBot11 在 event.message 为 []
  // 时把 segments 置为 [] 而保留 raw_message，若这里只判 `!== undefined`，
  // 段内没扫到 reply 就会漏掉 raw 里的 reply 段。
  // 上游此处仍是 `segments !== undefined`，会把 531f07a 修的空数组场景退回去，
  // 所以取本地版本。
  const list = segments !== undefined && segments.length > 0 ? segments : parseCqString(raw)
  return list.some(seg => seg.type === 'reply' && String(seg.data.qq ?? '') === bot)
}

/** Split a raw CQ string into segments; used only when no segment array exists. */
export function parseCqString(raw: string): OneBotSegment[] {
  const segments: OneBotSegment[] = []
  const re = /\[CQ:([a-z]+),([^\]]*)\]/g
  let last = 0
  for (const m of raw.matchAll(re)) {
    if (m.index !== undefined && m.index > last) {
      segments.push({ type: 'text', data: { text: raw.slice(last, m.index) } })
    }
    const data: Record<string, string> = {}
    for (const pair of m[2].split(',')) {
      const eq = pair.indexOf('=')
      if (eq > 0) data[pair.slice(0, eq)] = cqUnescape(pair.slice(eq + 1))
    }
    segments.push({ type: m[1], data })
    last = (m.index ?? 0) + m[0].length
  }
  if (last < raw.length) {
    segments.push({ type: 'text', data: { text: raw.slice(last) } })
  }
  return segments
}

/**
 * Parse a OneBot message (segment array preferred, CQ string fallback) into
 * text + media references. Media appear as placeholders in the text; media.ts
 * resolves each ref to a local path afterwards.
 * @param segments - message segment array (preferred).
 * @param raw - raw CQ string (fallback / complement).
 * @returns parsed text, media refs, and the quoted message id.
 */
export function parseMessage(segments: OneBotSegment[] | undefined, raw: string): ParsedMessage {
  const textParts: string[] = []
  const media: MediaRef[] = []
  let replyId: string | undefined
  let forwardId: string | undefined

  const appendImage = (data: Record<string, string>): void => {
    const subType = data.sub_type ?? data['sub-type']
    if (subType === '1') {
      textParts.push('[表情包]')
      return
    }
    media.push({ kind: 'image', url: data.url || undefined, file: data.file || undefined, subType })
    textParts.push('[图片]')
  }

  const list = segments !== undefined && segments.length > 0 ? segments : parseCqString(raw)
  for (const seg of list) {
    switch (seg.type) {
      case 'text':
        if (seg.data.text !== '') textParts.push(seg.data.text)
        break
      case 'image':
        appendImage(seg.data)
        break
      case 'face':
        textParts.push(faceToLabel(seg.data.id ?? ''))
        break
      case 'record':
        media.push({ kind: 'voice', url: seg.data.url || undefined, file: seg.data.file || undefined })
        textParts.push('[语音]')
        break
      case 'video':
        media.push({ kind: 'video', url: seg.data.url || undefined, file: seg.data.file || undefined })
        textParts.push('[视频]')
        break
      case 'file':
        // NapCat's file segment: `file` holds the file NAME (not a path),
        // `file_id` the real id, `name` is usually absent. Keep the raw
        // fields for media.ts; the display name falls back to `file`.
        media.push({
          kind: 'file',
          url: seg.data.url || undefined,
          file: seg.data.file || undefined,
          fileId: seg.data.file_id || undefined,
          name: seg.data.name || seg.data.file || undefined,
        })
        textParts.push(seg.data.name || seg.data.file ? `[文件:${seg.data.name || seg.data.file}]` : '[文件]')
        break
      case 'at': {
        const qq = seg.data.qq ?? ''
        textParts.push(qq === 'all' ? '@全体成员' : `@${qq}`)
        break
      }
      case 'reply':
        if (seg.data.id !== undefined) {
          replyId = seg.data.id
          textParts.push('[引用]')
        }
        break
      case 'forward':
        // NapCat uses `id`; go-cqhttp-style implementations may use `resId`.
        if (seg.data.id !== undefined || seg.data.resId !== undefined) {
          forwardId = seg.data.id ?? seg.data.resId
          textParts.push('[合并转发]')
        }
        break
      case 'json':
        textParts.push('[卡片]')
        break
      case 'poke':
        textParts.push('[戳一戳]')
        break
      case 'contact':
        textParts.push(seg.data.name ? `[联系人:${seg.data.name}]` : '[联系人]')
        break
      case 'location':
        textParts.push('[位置]')
        break
      case 'share':
        textParts.push(seg.data.title ? `[分享:${seg.data.title}]` : '[分享]')
        break
      default:
        // Unknown segment types keep their placeholder role; no crash.
        textParts.push(`[${seg.type}]`)
        break
    }
  }

  const text = textParts.join('').trim()
  return { text, media, replyId, forwardId }
}

/** Marker regex shared with split.ts (outbound [[qq_forward]]). */
export const FORWARD_BLOCK_RE = /\[\[qq_forward\]\]([\s\S]*?)\[\[\/qq_forward\]\]/g
