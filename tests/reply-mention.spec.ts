/**
 * 引用（reply）触发的唤醒判定（对齐上游 0.9.7 的 #10 修复）。
 *
 * 门禁的结构：显式 @ → 直接放行；否则若带 replyId，先用 get_msg 校验被引作者。
 * 校验只在「可能丢弃」时发生，取回的**原始响应**再传给展开复用 —— 一条引用消息
 * 只付一次 get_msg，也不留任何跨消息缓存。
 *
 * 用真实的 InboundPipeline，只替换 IO 端口，覆盖：四种丢弃原因、复用（只调一次
 * get_msg）、以及显式 @ 时门禁不取数。
 * @module dsh-onebot/tests/reply-mention
 */
import { describe, expect, it } from 'vitest'

import type { NormalizedInbound } from '../src/inbound.js'
import { InboundPipeline, normalizeOneBot11 } from '../src/inbound.js'
import { TRACE_REASONS } from '../src/trace.js'

const BOT = '10002'

interface HarnessOptions {
  /** get_msg 的返回；不给 = 抛错（模拟已删除或接口失败）。 */
  getMsg?: (id: number) => unknown
  requireMention?: boolean
}

/** 一条群消息：引用 replyId，正文「这个」。 */
function groupReply(replyId: string): NormalizedInbound {
  return normalizeOneBot11({
    post_type: 'message', message_type: 'group', group_id: 20001, user_id: 10001, self_id: BOT,
    message_id: 9001,
    message: [{ type: 'reply', data: { id: replyId } }, { type: 'text', data: { text: '这个' } }],
    raw_message: '[CQ:reply,id=' + replyId + ']这个',
    sender: { user_id: 10001, nickname: '路人' },
  })!
}

/** 一条群消息：显式 @ 机器人 + 引用。 */
function groupAtAndReply(replyId: string): NormalizedInbound {
  return normalizeOneBot11({
    post_type: 'message', message_type: 'group', group_id: 20001, user_id: 10001, self_id: BOT,
    message_id: 9002,
    message: [
      { type: 'at', data: { qq: BOT } },
      { type: 'reply', data: { id: replyId } },
      { type: 'text', data: { text: '看' } },
    ],
    raw_message: '[CQ:at,qq=' + BOT + '][CQ:reply,id=' + replyId + ']看',
    sender: { user_id: 10001, nickname: '路人' },
  })!
}

function makeHarness(options: HarnessOptions = {}) {
  const dispatched: string[] = []
  const logs: string[] = []
  const getMsgCalls: number[] = []
  let pipeline: InboundPipeline
  pipeline = new InboundPipeline({
    call: async (action: string, params: unknown) => {
      if (action !== 'get_msg') throw new Error('unexpected action: ' + action)
      const id = (params as { message_id: number }).message_id
      getMsgCalls.push(id)
      if (options.getMsg === undefined) throw new Error('get_msg failed')
      return options.getMsg(id)
    },
    selfId: () => BOT,
    policy: {
      dmPolicy: 'open', groupPolicy: 'open', allowFrom: [], groupAllowFrom: [],
      adminUsers: [], allowAllUsers: true, requireMention: options.requireMention ?? true,
    },
    getChat: () => ({ loopBuffer: [], loopPending: null, dispatchTimes: [], rateLimitNoticeAt: undefined }),
    getSettings: () => ({}) as never,
    sweepIdleChats: async () => undefined,
    media: { cleanupExpired: async () => undefined } as never,
    transcriber: { enabled: false, transcribe: async () => '' } as never,
    steerTranscript: () => undefined,
    tryHandleCommand: async () => false,
    buildBody: async (text: string) => text,
    // 指回真实实现：只有这样才能验证「门禁取回的响应被展开复用」。
    expandQuote: (messageId: string, verifiedData?: unknown) => pipeline.expandQuote(messageId, verifiedData as never),
    dispatchFollowup: async (_chatId, text) => { dispatched.push(text) },
    sendToChat: async () => [],
    log: (_level, message) => { logs.push(message) },
    config: {
      botQQ: BOT, ignoreSelf: false, requireMention: options.requireMention ?? true,
      rateLimitPerMinute: 0, restrictedMemberPrefix: false, maxInboundFileBytes: 0,
    },
  })
  return { pipeline, dispatched, logs, getMsgCalls }
}

const quoteOf = (userId: string | number | undefined, text = '原文'): unknown => ({
  message: [{ type: 'text', data: { text } }],
  raw_message: text,
  ...(userId !== undefined ? { sender: { user_id: userId, nickname: '来源' } } : {}),
})

describe('引用消息的唤醒判定（reply mention gate）', () => {
  it('引用他人的消息不唤醒，记录 inboundReplyOtherAuthor', async () => {
    const h = makeHarness({ getMsg: () => quoteOf('99999') })
    await h.pipeline.processInbound(groupReply('42'))
    expect(h.dispatched).toHaveLength(0)
    expect(h.getMsgCalls).toEqual([42])
    expect(h.logs.some(line => line.includes(TRACE_REASONS.inboundReplyOtherAuthor))).toBe(true)
  })

  it('引用机器人的消息唤醒，且 get_msg 只调一次（门禁取、展开复用）', async () => {
    const h = makeHarness({ getMsg: () => quoteOf(BOT, '被引用的原文') })
    await h.pipeline.processInbound(groupReply('42'))
    expect(h.dispatched).toHaveLength(1)
    expect(h.dispatched[0]).toContain('[引用]来源: 被引用的原文')
    expect(h.getMsgCalls).toHaveLength(1)
  })

  it('无效的引用 id 不发起 get_msg，记录 quoteInvalidId', async () => {
    const h = makeHarness({ getMsg: () => quoteOf(BOT) })
    await h.pipeline.processInbound(groupReply('abc'))
    expect(h.dispatched).toHaveLength(0)
    expect(h.getMsgCalls).toEqual([])
    expect(h.logs.some(line => line.includes(TRACE_REASONS.quoteInvalidId))).toBe(true)
  })

  it('指数/十六进制写法同样不算有效 id', async () => {
    const h = makeHarness({ getMsg: () => quoteOf(BOT) })
    await h.pipeline.processInbound(groupReply('1e3'))
    await h.pipeline.processInbound(groupReply('0x10'))
    expect(h.getMsgCalls).toEqual([])
  })

  it('get_msg 失败时不唤醒，记录 inboundReplyLookupFailed', async () => {
    const h = makeHarness()
    await h.pipeline.processInbound(groupReply('42'))
    expect(h.dispatched).toHaveLength(0)
    expect(h.getMsgCalls).toEqual([42])
    expect(h.logs.some(line => line.includes(TRACE_REASONS.inboundReplyLookupFailed))).toBe(true)
  })

  it('被引消息没有作者信息时不唤醒，记录 inboundReplyAuthorUnknown', async () => {
    const h = makeHarness({ getMsg: () => quoteOf(undefined) })
    await h.pipeline.processInbound(groupReply('42'))
    expect(h.dispatched).toHaveLength(0)
    expect(h.logs.some(line => line.includes(TRACE_REASONS.inboundReplyAuthorUnknown))).toBe(true)
  })

  it('显式 @ 时门禁不取数，只有展开阶段取一次', async () => {
    const h = makeHarness({ getMsg: () => quoteOf(BOT, '被引用的原文') })
    await h.pipeline.processInbound(groupAtAndReply('42'))
    expect(h.dispatched).toHaveLength(1)
    // 门禁跳过 → 展开自己取：一共 1 次，而不是 2 次。
    expect(h.getMsgCalls).toEqual([42])
  })

  it('requireMention=false 时不校验引用作者，直接放行', async () => {
    const h = makeHarness({ getMsg: () => quoteOf('99999'), requireMention: false })
    await h.pipeline.processInbound(groupReply('42'))
    expect(h.dispatched).toHaveLength(1)
    // 只有展开取了一次；门禁根本没跑。
    expect(h.getMsgCalls).toEqual([42])
  })
})
