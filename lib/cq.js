/**
 * OneBot 11 message parsing: CQ-code unescaping, segment-array → text/media
 * extraction, mention detection, and face-id → readable label mapping. Ported
 * from the Hermes onebot_utils.py (CQ parsing half). Pure functions, no I/O.
 * @module dsh-onebot/cq
 */
import { FACE_NAMES } from './face-names.js';
/**
 * Reverse the CQ escaping NapCat applies inside attribute values
 * (&amp; → &, &#91; → [, &#93; → ], &#44; → ,). Skipping this broke
 * image-CDN downloads with a 403 (the & in signed URLs arrived escaped).
 * @param value - raw CQ attribute value or text.
 * @returns unescaped value.
 */
export function cqUnescape(value) {
    return value
        .replaceAll('&#91;', '[')
        .replaceAll('&#93;', ']')
        .replaceAll('&#44;', ',')
        .replaceAll('&amp;', '&');
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
export function faceToLabel(id) {
    const name = FACE_NAMES[id];
    if (name !== undefined)
        return '[表情:' + name + ']';
    return id !== '' ? '[表情:id=' + id + ']' : '[表情]';
}
const CQ_AT_RE = /\[CQ:at,qq=([^,\]]+)\]/g;
/**
 * Detect whether the message mentions the bot. Prefers the segment array;
 * falls back to CQ-string scanning. @-detection stays fail-closed: with an
 * unknown bot id and no configured botQQ, group messages are never treated
 * as mentioning us.
 *
 * Reply segments are TARGET-AWARE and fail-CLOSED. The OneBot 11 spec's reply
 * segment carries only `id` — no `qq` at all (some implementations, NapCat
 * included, may add it as an extension). Treating a missing `qq` as "replied to
 * the bot" made *every* quote-tap in a group wake the bot, so an absent or
 * foreign target now counts as NOT a mention. The quoted target is resolved
 * upstream (get_msg) when the segment itself cannot answer it; see
 * `replyTargetIsBot`.
 * @param segments - segment array (may be undefined for CQ-only payloads).
 * @param raw - raw CQ string.
 * @param selfId - learned bot QQ id ('' when unknown).
 * @param botQQ - configured bot QQ id ('' when unset).
 * @param replyTarget - resolved author of the quoted message, when the inbound
 *   pipeline managed to fetch it. '' / undefined = unknown (not a mention).
 */
export function detectMention(segments, raw, selfId, botQQ, replyTarget) {
    const bot = selfId !== '' ? selfId : botQQ;
    // 空数组要按「没有段」处理，与 parseMessage（本文件 :208 的
    // `segments !== undefined && segments.length > 0 ? segments : parseCqString(raw)`）
    // 保持同一判据：normalizeOneBot11 在 event.message 为 [] 时会把 segments 置为 []
    // 但保留 raw_message，若这里只判 `!== undefined`，正文由 raw 解析出了 @、
    // 提及判定却在空循环后返回 false —— 真实 @机器人 反而在 requireMention 群里被丢弃。
    if (segments !== undefined && segments.length > 0) {
        for (const seg of segments) {
            if (seg.type === 'reply') {
                // Prefer the segment's own target when present; fall back to the
                // target resolved by the pipeline. Unknown target = not a mention.
                const qq = seg.data.qq ?? '';
                const target = qq !== '' ? qq : (replyTarget ?? '');
                if (target !== '' && target === bot)
                    return true;
                continue;
            }
            if (bot !== '' && seg.type === 'at' && (seg.data.qq === bot || seg.data.qq === 'all'))
                return true;
        }
        return false;
    }
    if (bot === '')
        return false;
    CQ_AT_RE.lastIndex = 0;
    for (const m of raw.matchAll(CQ_AT_RE)) {
        if (m[1] === bot || m[1] === 'all')
            return true;
    }
    // A CQ-string reply carries no author either: only a resolved target counts.
    if (replyTarget !== undefined && replyTarget !== '' && replyTarget === bot)
        return true;
    return false;
}
/** Split a raw CQ string into segments; used only when no segment array exists. */
export function parseCqString(raw) {
    const segments = [];
    const re = /\[CQ:([a-z]+),([^\]]*)\]/g;
    let last = 0;
    for (const m of raw.matchAll(re)) {
        if (m.index !== undefined && m.index > last) {
            segments.push({ type: 'text', data: { text: raw.slice(last, m.index) } });
        }
        const data = {};
        for (const pair of m[2].split(',')) {
            const eq = pair.indexOf('=');
            if (eq > 0)
                data[pair.slice(0, eq)] = cqUnescape(pair.slice(eq + 1));
        }
        segments.push({ type: m[1], data });
        last = (m.index ?? 0) + m[0].length;
    }
    if (last < raw.length) {
        segments.push({ type: 'text', data: { text: raw.slice(last) } });
    }
    return segments;
}
/**
 * Parse a OneBot message (segment array preferred, CQ string fallback) into
 * text + media references. Media appear as placeholders in the text; media.ts
 * resolves each ref to a local path afterwards.
 * @param segments - message segment array (preferred).
 * @param raw - raw CQ string (fallback / complement).
 * @returns parsed text, media refs, and the quoted message id.
 */
export function parseMessage(segments, raw) {
    const textParts = [];
    const media = [];
    let replyId;
    let forwardId;
    const appendImage = (data) => {
        const subType = data.sub_type ?? data['sub-type'];
        if (subType === '1') {
            textParts.push('[表情包]');
            return;
        }
        media.push({ kind: 'image', url: data.url || undefined, file: data.file || undefined, subType });
        textParts.push('[图片]');
    };
    const list = segments !== undefined && segments.length > 0 ? segments : parseCqString(raw);
    for (const seg of list) {
        switch (seg.type) {
            case 'text':
                if (seg.data.text !== '')
                    textParts.push(seg.data.text);
                break;
            case 'image':
                appendImage(seg.data);
                break;
            case 'face':
                textParts.push(faceToLabel(seg.data.id ?? ''));
                break;
            case 'record':
                media.push({ kind: 'voice', url: seg.data.url || undefined, file: seg.data.file || undefined });
                textParts.push('[语音]');
                break;
            case 'video':
                media.push({ kind: 'video', url: seg.data.url || undefined, file: seg.data.file || undefined });
                textParts.push('[视频]');
                break;
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
                });
                textParts.push(seg.data.name || seg.data.file ? `[文件:${seg.data.name || seg.data.file}]` : '[文件]');
                break;
            case 'at': {
                const qq = seg.data.qq ?? '';
                textParts.push(qq === 'all' ? '@全体成员' : `@${qq}`);
                break;
            }
            case 'reply':
                if (seg.data.id !== undefined) {
                    replyId = seg.data.id;
                    textParts.push('[引用]');
                }
                break;
            case 'forward':
                // NapCat uses `id`; go-cqhttp-style implementations may use `resId`.
                if (seg.data.id !== undefined || seg.data.resId !== undefined) {
                    forwardId = seg.data.id ?? seg.data.resId;
                    textParts.push('[合并转发]');
                }
                break;
            case 'json':
                textParts.push('[卡片]');
                break;
            case 'poke':
                textParts.push('[戳一戳]');
                break;
            case 'contact':
                textParts.push(seg.data.name ? `[联系人:${seg.data.name}]` : '[联系人]');
                break;
            case 'location':
                textParts.push('[位置]');
                break;
            case 'share':
                textParts.push(seg.data.title ? `[分享:${seg.data.title}]` : '[分享]');
                break;
            default:
                // Unknown segment types keep their placeholder role; no crash.
                textParts.push(`[${seg.type}]`);
                break;
        }
    }
    const text = textParts.join('').trim();
    return { text, media, replyId, forwardId };
}
/** Extract the plain text of a quoted (get_msg) message for [引用] expansion. */
export function segmentText(segments, raw) {
    return parseMessage(segments, raw).text;
}
/** Marker regex shared with split.ts (outbound [[qq_forward]]). */
export const FORWARD_BLOCK_RE = /\[\[qq_forward\]\]([\s\S]*?)\[\[\/qq_forward\]\]/g;
