/**
 * OneBot 11 message parsing: CQ-code unescaping, segment-array → text/media
 * extraction, mention detection, and face-id → readable label mapping. Ported
 * from the Hermes onebot_utils.py (CQ parsing half). Pure functions, no I/O.
 * @module dsh-onebot/cq
 */
/** One OneBot 11 message segment. */
export interface OneBotSegment {
    type: string;
    data: Record<string, string>;
}
/** A media reference extracted from an inbound message, resolved by media.ts. */
export interface MediaRef {
    kind: 'image' | 'voice' | 'video' | 'file';
    /** Remote URL to download (image/voice/video). */
    url?: string;
    /** raw file field: base64://..., file://..., or a hash. */
    file?: string;
    /** OneBot file_id (NapCat file segments carry the real id here). */
    fileId?: string;
    name?: string;
    subType?: string;
}
/** A fully parsed inbound message. */
export interface ParsedMessage {
    /** Plain text with media placeholders, ready for the agent. */
    text: string;
    media: MediaRef[];
    /** OneBot message_id of the quoted (reply) message, if any. */
    replyId?: string;
    /** OneBot forward id embedded in the message, if any. */
    forwardId?: string;
}
/**
 * Reverse the CQ escaping NapCat applies inside attribute values
 * (&amp; → &, &#91; → [, &#93; → ], &#44; → ,). Skipping this broke
 * image-CDN downloads with a 403 (the & in signed URLs arrived escaped).
 * @param value - raw CQ attribute value or text.
 * @returns unescaped value.
 */
export declare function cqUnescape(value: string): string;
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
export declare function faceToLabel(id: string): string;
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
export declare function detectExplicitMention(segments: OneBotSegment[] | undefined, raw: string, selfId: string, botQQ: string): boolean;
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
export declare function detectMention(segments: OneBotSegment[] | undefined, raw: string, selfId: string, botQQ: string): boolean;
/** Split a raw CQ string into segments; used only when no segment array exists. */
export declare function parseCqString(raw: string): OneBotSegment[];
/**
 * Parse a OneBot message (segment array preferred, CQ string fallback) into
 * text + media references. Media appear as placeholders in the text; media.ts
 * resolves each ref to a local path afterwards.
 * @param segments - message segment array (preferred).
 * @param raw - raw CQ string (fallback / complement).
 * @returns parsed text, media refs, and the quoted message id.
 */
export declare function parseMessage(segments: OneBotSegment[] | undefined, raw: string): ParsedMessage;
/** Marker regex shared with split.ts (outbound [[qq_forward]]). */
export declare const FORWARD_BLOCK_RE: RegExp;
