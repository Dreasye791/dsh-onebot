/**
 * 引用消息里的图片（T19）：`get_msg` 拿到的图片段必须走与正文同样的
 * buildBody → deliverInboundImage 通道，否则模型只能看到一个永远填不上的
 * `[图片]` 占位符（真实症状见 DEVLOG：模型翻遍 mediaDir 也找不到图）。
 *
 * 这里用真实的 InboundPipeline，只替换 media / 附件投递 / 分发三个端口，验证：
 * 1) 引用里的图真的进了 images；2) 图块顺序与文本占位符顺序一致；
 * 3) 取不到时文本显式标 `[引用图片:不可用]`；4) 超过 QUOTE_MEDIA_MAX 的
 * 张数被截断且文本同步标注。
 * @module dsh-onebot/tests/quote-media
 */
import { describe, expect, it } from 'vitest'

import type { MediaRef } from '../src/cq.js'
import type { NormalizedInbound } from '../src/inbound.js'
import { InboundPipeline, QUOTE_MEDIA_MAX, normalizeOneBot11 } from '../src/inbound.js'

interface Dispatch {
  text: string
  images: unknown[]
}

/** 一张图片段（get_msg 返回的形状：url + 36 字符 file 名）。 */
function imageSeg(name: string): { type: string, data: Record<string, string> } {
  return { type: 'image', data: { url: 'https://cdn.example/' + name, file: name } }
}

/**
 * 最小管线装配：`get_msg` 由用例提供，其余端口用固定假实现。
 * buildBody/expandQuote 指回真实实例方法——它们才是被测对象。
 */
function makeHarness(getMsg: () => unknown, options: { resolveOk?: boolean } = {}) {
  const dispatched: Dispatch[] = []
  const resolveCalls: MediaRef[] = []
  const resolveOk = options.resolveOk ?? true
  let pipeline: InboundPipeline
  const ctx = {
    call: async (action: string) => {
      if (action === 'get_msg') return getMsg()
      throw new Error('unexpected action: ' + action)
    },
    selfId: () => '10002',
    policy: {
      dmPolicy: 'open', groupPolicy: 'open', allowFrom: [], groupAllowFrom: [],
      adminUsers: [], allowAllUsers: true, requireMention: false,
    },
    getChat: () => ({ loopBuffer: [], loopPending: null, dispatchTimes: [], rateLimitNoticeAt: undefined }),
    getSettings: () => ({}),
    sweepIdleChats: async () => undefined,
    media: {
      cleanupExpired: async () => undefined,
      resolve: async (ref: MediaRef) => {
        resolveCalls.push(ref)
        if (!resolveOk) return undefined
        return { path: 'C:/tmp/' + (ref.file ?? 'x.png'), kind: ref.kind }
      },
    },
    transcriber: { enabled: false, transcribe: async () => '' },
    steerTranscript: () => undefined,
    tryHandleCommand: async () => false,
    buildBody: (
      text: string,
      media: MediaRef[],
      chatId: string,
      images?: unknown[],
      registerRecent?: boolean,
      failedLabel?: string,
    ) => pipeline.buildBody(text, media, chatId as never, images as never, registerRecent, failedLabel),
    expandQuote: (messageId: string) => pipeline.expandQuote(messageId),
    deliverInboundImage: async () => ({ attachmentId: 'sha256:test' }),
    dispatchFollowup: async (_chatId: string, text: string, _role: string, _nickname?: string, images?: unknown[]) => {
      dispatched.push({ text, images: images ?? [] })
    },
    sendToChat: async () => [],
    log: () => undefined,
    config: {
      botQQ: '', ignoreSelf: false, requireMention: false, rateLimitPerMinute: 0, restrictedMemberPrefix: false,
    },
  }
  pipeline = new InboundPipeline(ctx as never)
  return { pipeline, dispatched, resolveCalls }
}

/** 一条「引用 + 可选正文段」的群消息（requireMention=false，直接进管线）。 */
function groupReply(
  messageId: number,
  extra: Array<{ type: string, data: Record<string, string> }> = [],
): NormalizedInbound {
  const normalized = normalizeOneBot11({
    post_type: 'message', message_type: 'group', user_id: 10001, group_id: 888, self_id: 10002,
    message_id: messageId,
    message: [{ type: 'reply', data: { id: '777' } }, ...extra],
    raw_message: '[CQ:reply,id=777] 看看',
    sender: { user_id: 10001, nickname: '小明' },
  })
  return normalized as NormalizedInbound
}

describe('引用消息里的图片（T19）', () => {
  it('把引用里的图投递成图片块，文本仍是 [图片]', async () => {
    const h = makeHarness(() => ({
      message: [imageSeg('a.png'), { type: 'text', data: { text: '原图' } }],
      raw_message: '[CQ:image,file=a.png]原图',
      sender: { user_id: 10001, nickname: '某人' },
    }))

    await h.pipeline.processInbound(groupReply(9001, [{ type: 'text', data: { text: '看看' } }]))

    expect(h.dispatched).toHaveLength(1)
    expect(h.dispatched[0].text).toContain('[引用]某人: [图片]原图')
    expect(h.dispatched[0].images).toHaveLength(1)
    expect(h.resolveCalls.map(ref => ref.file)).toEqual(['a.png'])
  })

  it('图块顺序与文本占位符顺序一致（引用图在正文图之前）', async () => {
    const h = makeHarness(() => ({
      message: [imageSeg('a.png'), imageSeg('b.png')],
      raw_message: '[CQ:image,file=a.png][CQ:image,file=b.png]',
      sender: { user_id: 10001, nickname: '某人' },
    }))

    await h.pipeline.processInbound(groupReply(9002, [
      imageSeg('c.png'),
      { type: 'text', data: { text: '正文图' } },
    ]))

    // 文本里引用在正文之前（[引用]...行 + 正文行），所以图块也必须是引用在前。
    expect(h.resolveCalls.map(ref => ref.file)).toEqual(['a.png', 'b.png', 'c.png'])
    expect(h.dispatched[0].images).toHaveLength(3)
  })

  it('引用图取不到时文本显式标注 [引用图片:不可用]', async () => {
    const h = makeHarness(() => ({
      message: [imageSeg('gone.png')],
      raw_message: '[CQ:image,file=gone.png]',
      sender: { user_id: 10001, nickname: '某人' },
    }), { resolveOk: false })

    await h.pipeline.processInbound(groupReply(9003, [{ type: 'text', data: { text: '还在吗' } }]))

    expect(h.dispatched[0].text).toContain('[引用图片:不可用]')
    expect(h.dispatched[0].text).not.toContain('[图片]')
    expect(h.dispatched[0].images).toHaveLength(0)
  })

  it('超过 QUOTE_MEDIA_MAX 的张数被截断并在文本里标注', async () => {
    const total = QUOTE_MEDIA_MAX + 2
    const segments = Array.from({ length: total }, (_unused, index) => imageSeg('p' + index + '.png'))
    const h = makeHarness(() => ({
      message: segments,
      raw_message: '',
      sender: { user_id: 10001, nickname: '某人' },
    }))

    await h.pipeline.processInbound(groupReply(9004, [{ type: 'text', data: { text: '这么多' } }]))

    expect(h.resolveCalls).toHaveLength(QUOTE_MEDIA_MAX)
    expect(h.dispatched[0].images).toHaveLength(QUOTE_MEDIA_MAX)
    const over = h.dispatched[0].text.split('[引用图片:超过上限未展开]').length - 1
    expect(over).toBe(2)
  })
})
