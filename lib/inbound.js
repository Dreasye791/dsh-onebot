/**
 * Inbound pipeline (M2-D1-PR4): the OneBot-11 → agent-turn path. Two pieces:
 * `normalizeOneBot11`, the pure protocol-adaptation seam that reduces one
 * raw message event to a neutral NormalizedInbound (null = not processable),
 * and `InboundPipeline`, which runs the normalized message through the
 * policy gate → mention gate → command router → media resolution →
 * quote/forward expansion → rate limit → turn dispatch. Extracted verbatim
 * from bridge.ts — gate order, prefix assembly, media annotation and
 * rate-limit behavior are identical; the bridge keeps same-name facade
 * methods so the onFrame call site, the command table and the M2-T0
 * pipeline-order overrides keep working unchanged.
 * @module dsh-onebot/inbound
 */
import { writeFile } from 'node:fs/promises';
import { extForInboundName } from './media.js';
import { transcriptLabel } from './stt.js';
import { cqUnescape, detectMention, parseCqString, parseMessage } from './cq.js';
import { buildChatId, buildGroupMessagePrefix, classifyUserRole, dmAllowed, groupAllowed, RESTRICTED_PREFIX, sanitizeNickname, wrapUserMessage, } from './chat.js';
import { describeError } from './errors.js';
import { currentTrace, TRACE_REASONS } from './trace.js';
/**
 * Reduce one raw OneBot 11 event to the neutral inbound shape, or null when
 * the event is not a processable chat message (notice/recall, meta, unknown
 * message_type, or a missing sender id). Pure: no I/O, no state — the
 * connection's self_id learning stays in the transport layer and the
 * ignoreSelf comparison stays in the pipeline (both are runtime state).
 */
export function normalizeOneBot11(event) {
    const messageType = event.message_type;
    if (messageType !== 'private' && messageType !== 'group')
        return null;
    const userId = String(event.user_id ?? '');
    if (userId === '')
        return null;
    const kind = messageType === 'private' ? 'private' : 'group';
    const groupId = kind === 'group' ? String(event.group_id ?? '') : '';
    const chatId = buildChatId(kind, kind === 'private' ? userId : groupId);
    const segments = Array.isArray(event.message) ? event.message : undefined;
    const raw = typeof event.raw_message === 'string' ? event.raw_message : String(event.message ?? '');
    const messageId = event.message_id === undefined || event.message_id === null
        ? undefined
        : String(event.message_id);
    const parsed = parseMessage(segments, raw);
    const sender = event.sender ?? {};
    const nickname = typeof sender.card === 'string' && sender.card !== ''
        ? sender.card
        : typeof sender.nickname === 'string' && sender.nickname !== ''
            ? sender.nickname
            : userId;
    return {
        kind,
        userId,
        groupId,
        chatId,
        segments,
        raw,
        text: parsed.text,
        media: parsed.media,
        replyId: parsed.replyId,
        forwardId: parsed.forwardId,
        messageId,
        nickname,
    };
}
/** W2-②: default (chatId, message_id) dedup window, aligned with the MIT
 * competitor's dedupWindowSeconds (300s). */
export const DEFAULT_DEDUP_WINDOW_SECONDS = 300;
/** W2-②: max entries kept in the dedup window map (LRU-evicted beyond this)
 * so a flood of distinct message_ids cannot grow memory unbounded. */
export const DEDUP_MAX_ENTRIES = 4096;
/** Cap on the get_msg quote memo (text + author per quoted id). Same LRU
 * reasoning as DEDUP_MAX_ENTRIES: an unbounded map would leak under a flood of
 * distinct quoted ids. */
export const QUOTE_MEMO_MAX_ENTRIES = 512;
/** 单条引用消息最多解析/投递的图片张数。
 *
 * 为什么要有上限：`buildBody` 对 media 是**串行** `await`，而单张下载的硬超时
 * 是 30s（`media.ts` 的 DOWNLOAD_TIMEOUT_MS），全部发生在 turn dispatch 之前。
 * 引用一条 9 图消息且 CDN 全部无响应时，最坏会让这条消息在 dispatch 前卡
 * 4 分半，用户看到的是机器人装死。超过上限的图在文本里显式标为未展开，
 * 让模型知道「还有图但没取」，而不是拿着一个空占位符瞎猜。 */
export const QUOTE_MEDIA_MAX = 4;
/**
 * The inbound pipeline: one normalized OneBot event → one agent turn.
 * Owns media resolution, quote/forward expansion and the B7 rate limit;
 * turn dispatch stays behind the context callback.
 */
export class InboundPipeline {
    ctx;
    /** W2-② dedup knobs (see InboundPipelineOptions). */
    dedupMaxEntries;
    now;
    /** W2-② dedup window state: "chatId#messageId" → first-seen epoch ms, in
     * insertion order (Map) so the oldest entry is the LRU victim. */
    seenMessages = new Map();
    constructor(ctx, options = {}) {
        this.ctx = ctx;
        this.dedupMaxEntries = options.dedupMaxEntries ?? DEDUP_MAX_ENTRIES;
        this.now = options.now ?? Date.now;
    }
    /** W1/T5 health snapshot: how many message_ids are currently held in the
     * dedup window (LRU-capped; see DEDUP_MAX_ENTRIES). */
    get dedupWindowEntries() {
        return this.seenMessages.size;
    }
    async processInbound(inbound) {
        if (this.duplicated(inbound))
            return;
        const { kind, userId, groupId, chatId } = inbound;
        if (this.ctx.config.ignoreSelf && this.ctx.selfId() !== '' && userId === this.ctx.selfId()) {
            // pipeline-hooks.md #5: this drop used to be fully silent.
            this.ctx.log('debug', '机器人自己的消息已忽略: ' + chatId);
            currentTrace()?.emit('self', { ok: false, reason: TRACE_REASONS.inboundSelf });
            return;
        }
        const policy = this.ctx.policy;
        if (kind === 'private') {
            if (!dmAllowed(userId, policy)) {
                this.ctx.log('debug', 'ignoring DM from non-allowed user ' + userId);
                currentTrace()?.emit('whitelist', { ok: false, reason: TRACE_REASONS.inboundDmBlocked });
                return;
            }
        }
        else {
            if (!groupAllowed(groupId, policy)) {
                this.ctx.log('debug', 'ignoring group message from non-allowed group ' + groupId);
                currentTrace()?.emit('whitelist', { ok: false, reason: TRACE_REASONS.inboundGroupBlocked });
                return;
            }
        }
        // A reply segment carries only a message id (OneBot 11 has no qq there), so
        // the gate must resolve the quoted message's author before it can tell
        // "@me" from "someone else's quote". Only fetched when the gate would
        // otherwise drop the message — an @-mention or requireMention=false never
        // pays for the extra get_msg.
        let replyTarget;
        const needsReplyResolution = kind === 'group' && this.ctx.config.requireMention
            && inbound.replyId !== undefined
            && !detectMention(inbound.segments, inbound.raw, this.ctx.selfId(), this.ctx.config.botQQ);
        if (needsReplyResolution) {
            replyTarget = await this.resolveReplyTarget(inbound.replyId);
        }
        const mentioned = detectMention(inbound.segments, inbound.raw, this.ctx.selfId(), this.ctx.config.botQQ, replyTarget);
        if (kind === 'group' && this.ctx.config.requireMention && !mentioned) {
            this.ctx.log('debug', 'ignoring unmentioned group message in ' + groupId);
            currentTrace()?.emit('mention', { ok: false, reason: TRACE_REASONS.inboundUnmentioned });
            return;
        }
        // M3-D5 identity whitelist: the sanitized nickname feeds the single-line
        // prefix, the <user_message> attribute and lastNickname — one value,
        // provably line-safe and markup-free for all three surfaces.
        const nickname = sanitizeNickname(inbound.nickname);
        // B8c: lazy idle eviction before processing each inbound message (flush →
        // dispose → remove; the mapping is kept so the chat can resume).
        await this.ctx.sweepIdleChats();
        // A new user message starts a fresh reply cycle: drop any unmerged loop
        // residue from the previous cycle so interims never merge across turns.
        const priorChat = this.ctx.getChat(chatId);
        if (priorChat !== undefined) {
            priorChat.loopBuffer = [];
            priorChat.loopPending = null;
        }
        // Fire-and-forget temp cleanup on each inbound.
        void this.ctx.media.cleanupExpired();
        // C6a: route slash commands BEFORE any media/quote I/O — a message that
        // happens to carry media must not pay for downloads or get_msg calls just
        // to be consumed as a command (admin-only; unknown /-words still fall
        // through to the model). The most recent inbound image is registered from
        // parsed.media up front so /ocr still sees it (resolved lazily there).
        for (const ref of inbound.media) {
            if (ref.kind === 'image')
                this.ctx.getSettings(chatId).pendingImageRef = ref;
        }
        if (await this.ctx.tryHandleCommand(chatId, inbound.text, userId, nickname)) {
            currentTrace()?.emit('command', { ok: true, reason: TRACE_REASONS.inboundCommand });
            return;
        }
        // T15：本条消息的图片引用集合，**局部**于本次 processInbound 调用。
        // 之前它挂在 per-chat settings 上（settings.pendingAttachments），而同 chat
        // 的入站是 fire-and-forget 并发的：A 消息的图会被 B 消息的 dispatch 取走
        // （串图），或 B 进入时清空把 A 尚未消费的图丢掉（丢图）。改成随消息显式
        // 传递后，两条消息各持一份，互不影响——各早退分支也不再需要「清空」这个
        // 补救动作，因为它们手里的数组随栈帧一起消失。
        // 先把两个展开做完（都只解析、不下载），再按最终文本里的出现顺序
        // forward → quote → body 依次落盘投递。image 块在 content 里统一追加在
        // 文本之后（见 bridge 的 dispatchFollowup），只有「图块顺序 == 文本占位符
        // 顺序」模型才能把图和文字对上——先 body 再 expansion 会让引用/转发里的图
        // 排到用户自己那张图的后面，等于张冠李戴。
        let forward = '';
        let forwardMedia = [];
        if (inbound.forwardId !== undefined) {
            const expansion = await this.expandForward(inbound.forwardId);
            forward = expansion.text;
            forwardMedia = expansion.media;
        }
        let quote = '';
        let quoteMedia = [];
        if (inbound.replyId !== undefined) {
            const expansion = await this.ctx.expandQuote(inbound.replyId);
            quote = expansion.text;
            quoteMedia = expansion.media;
        }
        const images = [];
        // 展开内容里的图片不登记「最近图片」：`/ocr` 指的是用户自己发的图，引用/
        // 转发里的图若顶掉 lastImagePath，下一条 /ocr 会去识别别人的图。
        if (forwardMedia.length > 0) {
            forward = await this.ctx.buildBody(forward, forwardMedia, chatId, images, false);
        }
        if (quoteMedia.length > 0) {
            quote = await this.ctx.buildBody(quote, quoteMedia, chatId, images, false, '[引用图片:不可用]');
        }
        const body = await this.ctx.buildBody(inbound.text, inbound.media, chatId, images);
        const isAdmin = classifyUserRole(userId, policy.adminUsers) === 'admin';
        if (this.rateLimited(chatId)) {
            return;
        }
        // M3-D5: the whole sender-controlled payload (body + quote/forward
        // expansions) enters the prompt inside the <user_message> boundary, so
        // forged prefix lines, restricted-member tags and system-prompt-like text
        // stay pure data. The framework-generated group prefix and
        // RESTRICTED_PREFIX remain outside — the only trusted metadata.
        const content = [forward, quote, body].filter(part => part !== '').join('\n');
        if (content.trim() === '') {
            // pipeline-hooks.md #17: this drop used to be fully silent.
            this.ctx.log('debug', '消息展开后无有效文本内容，已丢弃: ' + chatId);
            currentTrace()?.emit('dispatch', { ok: false, reason: TRACE_REASONS.inboundEmptyContent });
            return;
        }
        let final = wrapUserMessage(content, userId, nickname);
        if (kind === 'group') {
            final = buildGroupMessagePrefix(nickname, userId, mentioned) + final;
            if (!isAdmin && this.ctx.config.restrictedMemberPrefix) {
                final = RESTRICTED_PREFIX + final;
            }
        }
        const role = isAdmin ? 'admin' : 'member';
        // T2 (P1): the busy-turn policy seam runs AFTER every gate above (dedup /
        // self / policy / mention / command / rate-limit) and only around the
        // final dispatch — a queued or steered message has already paid for its
        // rate-limit slot and passed the whole pipeline. `plain` = no media, no
        // quote, no forward: the only shape eligible for steer (media-bearing
        // messages always queue so the full media pipeline runs for their own
        // turn). Seam absent = pre-T2 behavior (straight dispatch).
        const plain = inbound.media.length === 0 && inbound.replyId === undefined && inbound.forwardId === undefined;
        if (this.ctx.interceptBusyTurn !== undefined
            && await this.ctx.interceptBusyTurn(chatId, final, role, nickname, plain, images, userId)) {
            // 两条路径的图片归属都在 seam 内部处理（steer 只可能发生在 plain=true，
            // 即无媒体的消息上，本就没有图；排队路径把 images 一起交给它自己的
            // dispatch）。**这里不再需要清空**——images 是本次调用的局部数组。
            return;
        }
        await this.ctx.dispatchFollowup(chatId, final, role, nickname, images, userId);
    }
    /** W2-②: (chatId, message_id) sliding-window dedup against OneBot
     * re-delivery (reconnect replay / ws retry). Runs before every other gate
     * so a redelivered message can neither re-trigger a command nor reset the
     * loop residue; only events that normalize to processable chat messages
     * reach this — notice/meta/request events never enter the pipeline (see
     * docs/m1-characterization/pipeline-hooks.md #1/#3). Events without a
     * message_id are not deduped (nothing to key on). Window entries live in
     * an LRU-capped map: hits refresh recency (keeping the first-seen time, so
     * the window opens at first delivery), the oldest entry is evicted beyond
     * the cap. Returns true when the delivery must be silently skipped. */
    duplicated(inbound) {
        const windowSeconds = this.ctx.config.dedupWindowSeconds ?? DEFAULT_DEDUP_WINDOW_SECONDS;
        if (windowSeconds <= 0)
            return false;
        if (inbound.messageId === undefined || inbound.messageId === '')
            return false;
        const now = this.now();
        const key = inbound.chatId + '#' + inbound.messageId;
        const seenAt = this.seenMessages.get(key);
        if (seenAt !== undefined && now - seenAt < windowSeconds * 1000) {
            this.seenMessages.delete(key);
            this.seenMessages.set(key, seenAt);
            this.ctx.log('debug', 'dedup hit in ' + inbound.chatId + ': message_id ' + inbound.messageId
                + ' redelivered within ' + windowSeconds + 's window, message skipped');
            currentTrace()?.emit('dedup', { ok: false, reason: TRACE_REASONS.inboundDedup });
            return true;
        }
        this.seenMessages.delete(key);
        while (this.seenMessages.size >= this.dedupMaxEntries) {
            const oldest = this.seenMessages.keys().next().value;
            if (oldest === undefined)
                break;
            this.seenMessages.delete(oldest);
        }
        this.seenMessages.set(key, now);
        return false;
    }
    /** B7: sliding-window inbound rate limit for normal (non-command) messages.
     * Commands consumed by tryHandleCommand never reach this. Returns true when
     * the message must be dropped; at most one notice is sent per window. */
    rateLimited(chatId) {
        const limit = this.ctx.config.rateLimitPerMinute ?? 30;
        if (limit <= 0)
            return false;
        const chat = this.ctx.getChat(chatId);
        if (chat === undefined)
            return false;
        const now = Date.now();
        chat.dispatchTimes = chat.dispatchTimes.filter(t => now - t < 60_000);
        if (chat.dispatchTimes.length < limit) {
            chat.dispatchTimes.push(now);
            return false;
        }
        // pipeline-hooks.md #16: the drop decision itself used to be silent (only
        // the user-facing notice text existed).
        currentTrace()?.emit('ratelimit', { ok: false, reason: TRACE_REASONS.inboundRateLimited });
        if (chat.rateLimitNoticeAt === undefined || now - chat.rateLimitNoticeAt >= 60_000) {
            chat.rateLimitNoticeAt = now;
            void this.ctx.sendToChat(chatId, '⏳ 消息太频繁，请稍后再试。').catch((error) => {
                this.ctx.log('debug', '限流提示发送失败: ' + describeError(error));
                currentTrace()?.emit('ratelimit', { ok: false, reason: TRACE_REASONS.inboundRateNoticeFailed });
            });
        }
        return true;
    }
    /**
     * Build the message body text: placeholders become annotated local paths
     * (images/voices/videos) and voice files are transcribed when enabled.
     */
    async buildBody(text, media, chatId, images, registerRecent = true, failedLabel) {
        if (media.length === 0)
            return text;
        let out = text;
        // 游标而不是每轮 `out.indexOf(placeholder)` 从头找：同一段文本里多张图片
        // 会共用同一个占位符 `[图片]`（placeholderFor 只按 kind 区分，不含序号），
        // 从头找会让每一轮都命中**第一个**仍在的占位符——前一张成功投递后其占位
        // 符已被 annotation 替换，但若某张失败（annotation 为空、占位符原样保留），
        // 后续图就会把 annotation 写到那张失败图的位置上，导致文本顺序与 image
        // 块顺序相反。游标保证「处理顺序 = 占位符出现顺序」，两者恒定一致。
        let searchFrom = 0;
        for (const ref of media) {
            const placeholder = placeholderFor(ref);
            const idx = out.indexOf(placeholder, searchFrom);
            const annotation = await this.resolveMediaRef(ref, chatId, true, images, registerRecent);
            if (idx >= 0 && annotation !== '') {
                out = out.slice(0, idx) + annotation + out.slice(idx + placeholder.length);
                searchFrom = idx + annotation.length;
            }
            else if (idx >= 0) {
                // pipeline-hooks.md #10: a failed resolution used to leave the
                // placeholder silently unresolved.
                this.ctx.log('debug', '媒体解析失败，占位符保留原文: ' + placeholder);
                currentTrace()?.emit('media', { ok: false, reason: TRACE_REASONS.mediaResolveFailed });
                if (failedLabel !== undefined) {
                    // 引用场景：投递成功时注解也是 `[图片]`，文本上无法与「失败但占位符
                    // 原样保留」区分。只有在这里换成显式标记，模型才知道这张没取到，
                    // 而不是对着一个裸占位符猜。
                    out = out.slice(0, idx) + failedLabel + out.slice(idx + placeholder.length);
                    searchFrom = idx + failedLabel.length;
                }
                else {
                    // 占位符原样留着，游标跳过它，否则下一张图会命中同一个位置。
                    searchFrom = idx + placeholder.length;
                }
            }
        }
        return out;
    }
    /** Resolve one media ref to a text annotation with a local path.
     *
     * `attach` (T15): 图片走真图片块投递——成功时把引用压入调用方传入的
     * `images` 收集器、注解降级为 `[图片]`（像素已随 image 块送达，
     * 再重复一遍路径只会浪费 token）；未投递则保持 `[图片:<路径>]` 原样。命令
     * 路由（/ocr 等）取注解时传 false，只关心路径、不必付附件投递的代价。
     *
     * T18：图片引用经形参传递，不再挂在 per-chat settings 上——`handleInbound`
     * 是 fire-and-forget，同一会话并发处理两条消息时共享可变数组会互相取走。 */
    async resolveMediaRef(ref, chatId, attach = false, images, registerRecent = true) {
        if (ref.kind === 'file') {
            return await this.resolveNasFile(ref);
        }
        const resolved = await this.ctx.media.resolve(ref, async (kind, file) => {
            if (kind === 'image') {
                const data = await this.ctx.call('get_image', { file });
                return { url: data.url, file: data.file };
            }
            if (kind === 'voice') {
                const data = await this.ctx.call('get_record', { file, out_format: 'mp3' });
                return { file: data.file };
            }
            return undefined;
        });
        if (resolved === undefined)
            return '';
        switch (resolved.kind) {
            case 'image': {
                // Remember the most recent inbound image for /ocr (survives /new);
                // consume the pre-routing pending ref so /ocr never re-resolves it.
                // registerRecent=false 用于引用/转发展开出的图：它们不该顶掉用户自己
                // 刚发的那张图，否则下一条 /ocr 会去识别别人的图。
                if (registerRecent) {
                    const settings = this.ctx.getSettings(chatId);
                    settings.lastImagePath = resolved.path;
                    settings.pendingImageRef = undefined;
                }
                if (attach && this.ctx.deliverInboundImage !== undefined) {
                    let delivered;
                    try {
                        delivered = await this.ctx.deliverInboundImage(resolved.path, chatId);
                    }
                    catch (error) {
                        // 投递是增强手段，任何异常都不得中断消息本身的可达性。
                        this.ctx.log('debug', '入站图片投递附件库失败: ' + describeError(error));
                        currentTrace()?.emit('media', { ok: false, reason: '附件投递异常: ' + describeError(error) });
                    }
                    if (delivered !== undefined) {
                        // 收集器由调用方按消息新建（见 processInbound 里的 images）；
                        // 缺席时（命令路由 /ocr 等传 attach=false）这条分支不会走到。
                        images?.push(delivered);
                        return '[图片]';
                    }
                }
                return '[图片:' + resolved.path + ']';
            }
            case 'voice': {
                // M3-D4c: dispatch must not wait on STT — the [语音] placeholder ships
                // now and the transcript steers into the turn when it completes. A
                // failure/timeout keeps the placeholder as the final state.
                if (this.ctx.transcriber.enabled) {
                    void this.transcribeLater(resolved.path, chatId);
                }
                return '[语音]';
            }
            case 'video':
                return '[视频:' + resolved.path + ']';
            default:
                return '[文件:' + resolved.path + ']';
        }
    }
    /** M3-D4c: transcribe in the background and deliver the labeled transcript
     * into the chat's turn (steer at the running turn's nearest step boundary,
     * or a new turn when the agent is idle). Failure keeps [语音] as final. */
    async transcribeLater(path, chatId) {
        try {
            const text = await this.ctx.transcriber.transcribe(path);
            if (transcriptLabel(text) === '') {
                this.ctx.log('debug', '语音转写结果为空: ' + path);
                currentTrace()?.emit('transcribe', { ok: false, reason: TRACE_REASONS.sttEmpty });
                return;
            }
            this.ctx.steerTranscript(chatId, text);
        }
        catch (error) {
            this.ctx.log('warn', 'STT failed: ' + describeError(error));
            currentTrace()?.emit('transcribe', { ok: false, reason: '语音转写失败: ' + describeError(error) });
        }
    }
    /** Memo shared by the mention gate (needs the author) and the quote
     * expansion (needs the text + images) so one reply costs a single get_msg. */
    quoteMemo = new Map();
    /** Fetch a quoted message once: flattened [引用] text, the author's QQ, and
     * the quoted images (parsed but **not** downloaded — the mention gate calls
     * this for every un-@'d reply and must not pay for media I/O). */
    async fetchQuote(messageId) {
        const cached = this.quoteMemo.get(messageId);
        if (cached !== undefined)
            return cached;
        let entry = { text: '', author: '', media: [] };
        const startedAt = Date.now();
        try {
            const data = await this.ctx.call('get_msg', { message_id: Number(messageId) });
            const segments = Array.isArray(data.message) ? data.message : undefined;
            const raw = typeof data.raw_message === 'string' ? data.raw_message : '';
            // 阶段 0 取证探针（只观测，不改变行为）：回答「引用消息里的图片段到底带
            // 什么字段、url 是否可作为下载主路径」。故意不带 reason —— trace 的同
            // cause 5 分钟限频按 stage+reason 去重，带 reason 会把第二条样本吞掉。
            currentTrace()?.emit('quote', {
                ok: true,
                ms: Date.now() - startedAt,
                data: { probe: 'quote-shape', ...this.describeQuoteShape(segments, raw) },
            });
            const parsed = parseMessage(segments, raw);
            const capped = capQuoteImages(cqUnescape(parsed.text), parsed.media);
            const text = capped.text;
            const name = data.sender?.nickname ?? '';
            const author = data.sender?.user_id !== undefined ? String(data.sender.user_id) : '';
            entry = {
                text: text.trim() === '' ? '' : '[引用]' + (name !== '' ? name + ': ' : '') + text,
                author,
                media: capped.media,
            };
        }
        catch (error) {
            this.ctx.log('debug', 'quote expansion failed: ' + describeError(error));
            currentTrace()?.emit('quote', { ok: false, reason: '引用消息展开失败，已降级为空引用: ' + describeError(error) });
        }
        // Bounded like the dedup window: a flood of distinct quoted ids cannot
        // grow memory unbounded. Failed lookups are cached too — a retry would
        // fail identically, and '' keeps the mention gate fail-closed.
        if (this.quoteMemo.size >= QUOTE_MEMO_MAX_ENTRIES) {
            this.quoteMemo.delete(this.quoteMemo.keys().next().value);
        }
        this.quoteMemo.set(messageId, entry);
        return entry;
    }
    /**
     * 阶段 0 取证探针的形状摘要：只描述 get_msg 返回的段结构，不解析、不下载。
     *
     * 脱敏约束：trace 文件会长期留在 mediaDir 并被打进 `/doctor export` 诊断包，
     * 所以**绝不落完整 URL**（QQ 图片链接带 rkey 签名）。这里只保留 host、query
     * 参数名集合（能看出有没有 rkey/term）、file 的形态分类与扩展名——足够回答
     * 「url 能不能直接用」「只有 file 时是什么形状」，又不会泄签名。
     */
    describeQuoteShape(segments, raw) {
        const list = segments !== undefined && segments.length > 0 ? segments : parseCqString(raw);
        const images = list.filter(seg => seg.type === 'image').map(seg => {
            const data = seg.data;
            const url = data.url ?? '';
            const file = data.file ?? '';
            let host = '';
            let queryKeys = [];
            if (url !== '') {
                try {
                    const parsed = new URL(url);
                    host = parsed.host;
                    queryKeys = [...parsed.searchParams.keys()];
                }
                catch {
                    host = 'unparsable';
                }
            }
            return {
                urlPresent: url !== '',
                urlHost: host,
                urlQueryKeys: queryKeys,
                fileKind: file === ''
                    ? 'empty'
                    : file.startsWith('file://')
                        ? 'file'
                        : file.startsWith('base64://')
                            ? 'base64'
                            : file.startsWith('http')
                                ? 'http'
                                : 'name',
                fileExt: (/\.([a-z0-9]{1,6})$/i.exec(file)?.[1] ?? '').toLowerCase(),
                fileLen: file.length,
                fileSize: String(data.file_size ?? ''),
                subType: data.sub_type ?? data['sub-type'] ?? '',
            };
        });
        return {
            messageIsArray: segments !== undefined && segments.length > 0,
            segmentCount: list.length,
            segmentTypes: list.map(seg => seg.type),
            rawLen: raw.length,
            imageCount: images.length,
            images,
        };
    }
    /** Author QQ of the quoted message ('' when unknown or the fetch failed).
     * The mention gate uses this because OneBot's reply segment only carries an
     * id — an unknown author must never be mistaken for the bot itself. */
    async resolveReplyTarget(messageId) {
        return (await this.fetchQuote(messageId)).author;
    }
    /** Expand a quoted (reply) message into [引用] text + its images via get_msg. */
    async expandQuote(messageId) {
        const quote = await this.fetchQuote(messageId);
        return { text: quote.text, media: quote.media };
    }
    /**
     * Fetch an inbound QQ file to a local path. NapCat's get_file may return
     * container-internal paths unreachable from this host, so:
     *   1. prefer the private-file direct link (get_private_file_url → HTTP
     *      CDN download, works for private chats);
     *   2. fall back to get_file base64 / http-url payloads.
     * Returns the [文件:path] annotation, or '' when disabled/failed.
     */
    async resolveNasFile(ref) {
        const name = ref.name !== undefined && ref.name !== '' ? ref.name : 'file';
        // The sender-controlled name never becomes the on-disk path (it could
        // otherwise overwrite chat-sessions.json etc.); only a whitelisted
        // extension survives into the fresh media_* name.
        const ext = extForInboundName(name);
        // Streaming size cap for both URL branches below (0 = uncapped).
        const maxBytes = this.ctx.config.maxInboundFileBytes > 0 ? this.ctx.config.maxInboundFileBytes : undefined;
        const fid = ref.fileId ?? ref.file ?? '';
        if (fid === '')
            return '';
        try {
            // 1. Private-chat direct link (works without any container access).
            const direct = await this.ctx.call('get_private_file_url', { file_id: fid });
            if (direct.url !== undefined && direct.url !== '') {
                try {
                    const localPath = await this.ctx.media.downloadUrl(direct.url, ext, maxBytes);
                    this.ctx.log('info', 'qq file fetched via direct link: ' + localPath);
                    return '[文件:' + localPath + ']';
                }
                catch (error) {
                    this.ctx.log('warn', 'qq file direct download failed: ' + describeError(error));
                }
            }
        }
        catch (error) {
            this.ctx.log('debug', 'get_private_file_url failed (falling back to get_file): ' + describeError(error));
        }
        // 2. get_file: with NapCat's file server enabled it returns a `base64`
        //    payload or an http(s) `url`; otherwise a container path we cannot reach.
        try {
            const data = await this.ctx.call('get_file', { file: fid });
            const size = Number(data.file_size ?? 0);
            if (this.ctx.config.maxInboundFileBytes > 0 && size > this.ctx.config.maxInboundFileBytes) {
                this.ctx.log('warn', 'qq file too large (' + size + 'B), skipping fetch');
                currentTrace()?.emit('media', { ok: false, reason: TRACE_REASONS.nasFileTooLarge });
                return '';
            }
            if (data.base64 !== undefined && data.base64 !== '') {
                const localPath = await this.writeMediaFile(Buffer.from(data.base64, 'base64'), ext);
                if (localPath !== '') {
                    this.ctx.log('info', 'qq file fetched via get_file base64: ' + localPath);
                    return '[文件:' + localPath + ']';
                }
            }
            if (data.url !== undefined && /^https?:\/\//.test(data.url)) {
                try {
                    const localPath = await this.ctx.media.downloadUrl(data.url, ext, maxBytes);
                    this.ctx.log('info', 'qq file fetched via get_file url: ' + localPath);
                    return '[文件:' + localPath + ']';
                }
                catch (error) {
                    this.ctx.log('warn', 'qq file direct download failed: ' + describeError(error));
                }
            }
        }
        catch (error) {
            this.ctx.log('debug', 'get_file base64/url path failed: ' + describeError(error));
        }
        this.ctx.log('warn', 'qq file fetch failed: no direct link / base64 / http url available for ' + fid);
        currentTrace()?.emit('media', { ok: false, reason: TRACE_REASONS.nasFileFailed });
        return '';
    }
    /** Write bytes into the media dir under a fresh unpredictable name; returns the path or ''. */
    async writeMediaFile(buffer, ext) {
        try {
            // freshPath mints media_<ts>_<uuid><ext>: inbound data can never land
            // on a known name (chat-sessions.json etc.) no matter what the sender
            // chose as the file name.
            await this.ctx.media.ensure();
            const localPath = this.ctx.media.freshPath(ext);
            await writeFile(localPath, buffer);
            return localPath;
        }
        catch (error) {
            this.ctx.log('warn', 'media write failed: ' + describeError(error));
            return '';
        }
    }
    /**
     * Expand a combined-forward id into "name: content" lines, collecting
     * embedded image segments into the media list (they flow through the same
     * buildBody pipeline as inbound media). Failure or an empty expansion no
     * longer returns a silent placeholder: the resId plus a short reason
     * (api-error / empty-response / no-text-nodes) stays in the model context
     * so it can self-serve via the whitelisted get_forward_msg tool.
     */
    async expandForward(forwardId) {
        try {
            // NapCat's get_forward_msg accepts `message_id` or `id`; sending both
            // also covers go-cqhttp-style implementations. Its response nodes are
            // OneBot node segments: { type: 'node', data: { nickname, user_id,
            // message: [...] } } — the flat `sender`/`content` shape is kept as a
            // fallback for other implementations.
            const data = await this.ctx.call('get_forward_msg', { id: forwardId, message_id: forwardId });
            const nodes = data.messages ?? [];
            const lines = [];
            const media = [];
            for (const node of nodes) {
                const nodeData = node.data;
                const name = nodeData?.nickname ?? node.sender?.nickname
                    ?? String(nodeData?.user_id ?? node.sender?.user_id ?? '未知');
                const text = nodeContentText(nodeData?.message ?? nodeData?.content ?? node.content, name, media, lines);
                if (text !== '')
                    lines.push(name + ': ' + text);
            }
            if (lines.length === 0) {
                const reason = nodes.length === 0 ? 'empty-response' : 'no-text-nodes';
                currentTrace()?.emit('forward', { ok: false, reason: '合并转发未展开: ' + reason });
                return { text: '[合并转发 id=' + forwardId + ' 未展开: ' + reason + ']', media };
            }
            return { text: '[合并转发]\n' + lines.join('\n'), media };
        }
        catch (error) {
            this.ctx.log('info', 'forward expansion failed: resId=' + forwardId + ': ' + describeError(error));
            currentTrace()?.emit('forward', { ok: false, reason: '合并转发展开失败: ' + describeError(error) });
            return { text: '[合并转发 id=' + forwardId + ' 未展开: api-error]', media: [] };
        }
    }
}
/**
 * 把引用消息里超量的图片从 media 里截掉，并把文本里对应位置的 `[图片]`
 * 换成显式的「未展开」标记。
 *
 * 两件事必须同时做：只截 media 不截文本，会留下永远填不上的裸 `[图片]`，
 * 模型会以为图已经到了；只改文本不截 media，buildBody 的游标会继续往后找
 * 占位符，把后续图片的注解写到错误的位置。按出现顺序替换与 parseMessage 的
 * 产出顺序天然一致（它按段遍历 push）。
 *
 * 非图片媒体（语音/视频/文件）一律不进引用展开：语音要走 STT 的异步补递、
 * 文件要走 get_file 的双通道，都依赖入站正文那条路径的上下文，引用里没有。
 */
function capQuoteImages(text, media) {
    const images = media.filter(ref => ref.kind === 'image');
    if (images.length <= QUOTE_MEDIA_MAX)
        return { text, media: images };
    let seen = 0;
    const capped = text.replace(/\[图片\]/g, match => {
        seen += 1;
        return seen <= QUOTE_MEDIA_MAX ? match : '[引用图片:超过上限未展开]';
    });
    return { text: capped, media: images.slice(0, QUOTE_MEDIA_MAX) };
}
/** The placeholder a media ref contributes to the parsed text. */
function placeholderFor(ref) {
    switch (ref.kind) {
        case 'image': return '[图片]';
        case 'voice': return '[语音]';
        case 'video': return '[视频]';
        default: return ref.name !== undefined ? '[文件:' + ref.name + ']' : '[文件]';
    }
}
/**
 * Extract text from a forward-node content (segment array or CQ string).
 * Image segments are collected into `media` and contribute a '[图片]'
 * placeholder (annotated by buildBody like inbound media, `name` carries the
 * owning node's nickname). Nested node segments recurse: their text joins
 * `lines` as their own "name: text" entry instead of being swallowed as
 * '[非文本]'.
 */
function nodeContentText(content, ownerName, media, lines) {
    if (Array.isArray(content)) {
        return content
            .map(seg => {
            const s = seg;
            if (s?.type === 'text')
                return String(s.data?.text ?? '');
            if (s?.type === 'face')
                return '😀';
            if (s?.type === 'image') {
                media.push({
                    kind: 'image',
                    url: typeof s.data?.url === 'string' && s.data.url !== '' ? s.data.url : undefined,
                    file: typeof s.data?.file === 'string' && s.data.file !== '' ? s.data.file : undefined,
                    name: ownerName,
                });
                return '[图片]';
            }
            if (s?.type === 'node' && typeof s.data === 'object' && s.data !== null) {
                const nested = s.data;
                const nestedName = nested.nickname ?? String(nested.user_id ?? ownerName);
                const nestedText = nodeContentText(nested.message ?? nested.content, nestedName, media, lines);
                if (nestedText !== '')
                    lines.push(nestedName + ': ' + nestedText);
                return '';
            }
            return '[非文本]';
        })
            .join('')
            .trim();
    }
    if (typeof content === 'string')
        return content.trim();
    return '';
}
