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
export declare function detectMention(segments: OneBotSegment[] | undefined, raw: string, selfId: string, botQQ: string, replyTarget?: string): boolean;
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
