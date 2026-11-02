import { describe, expect, it } from 'vitest'
// 取本地：本地的表情标签函数叫 faceToLabel（上游这版改名为 faceToEmoji）。
import { cqUnescape, parseMessage, detectExplicitMention, detectMention, parseCqString, faceToLabel } from '../src/cq.js'

describe('cqUnescape', () => {
  it('reverses CQ attribute escaping', () => {
    expect(cqUnescape('a&amp;b')).toBe('a&b')
    expect(cqUnescape('&#91;x&#93;')).toBe('[x]')
    expect(cqUnescape('&#44;')).toBe(',')
    expect(cqUnescape('plain')).toBe('plain')
  })
})

describe('parseMessage', () => {
  it('parses a segment array with text and image', () => {
    const parsed = parseMessage(
      [
        { type: 'text', data: { text: '你好 ' } },
        { type: 'image', data: { url: 'https://example.com/a.jpg?x=1&amp;y=2' } },
      ],
      '',
    )
    expect(parsed.text).toBe('你好 [图片]')
    expect(parsed.media).toHaveLength(1)
    expect(parsed.media[0].kind).toBe('image')
  })

  it('falls back to CQ string parsing', () => {
    const parsed = parseMessage(undefined, 'hi [CQ:face,id=0] [CQ:image,url=https://x/y.png]')
    expect(parsed.text).toContain('hi')
    expect(parsed.text).toContain('[表情:惊讶]')
    expect(parsed.media).toHaveLength(1)
  })

  it('extracts reply and forward ids', () => {
    const parsed = parseMessage(
      [
        { type: 'reply', data: { id: '123' } },
        { type: 'text', data: { text: '看看' } },
        { type: 'forward', data: { id: 'fwd-1' } },
      ],
      '',
    )
    expect(parsed.replyId).toBe('123')
    expect(parsed.forwardId).toBe('fwd-1')
  })

  it('falls back to resId when a forward segment carries no id', () => {
    const parsed = parseMessage(
      [{ type: 'forward', data: { resId: 'res-9' } }],
      '',
    )
    expect(parsed.forwardId).toBe('res-9')
    expect(parsed.text).toBe('[合并转发]')
  })

  it('handles at and poke segments', () => {
    const parsed = parseMessage(
      [
        { type: 'at', data: { qq: 'all' } },
        { type: 'text', data: { text: ' ' } },
        { type: 'poke', data: {} },
      ],
      '',
    )
    expect(parsed.text).toContain('@全体成员')
    expect(parsed.text).toContain('[戳一戳]')
  })
})

describe('parseCqString', () => {
  it('unescapes attribute values', () => {
    const segments = parseCqString('[CQ:image,url=https://x/a.jpg?a=1&amp;b=2]')
    expect(segments[0].data.url).toBe('https://x/a.jpg?a=1&b=2')
  })
})

describe('detectMention', () => {
  it('detects at via segments', () => {
    expect(detectMention([{ type: 'at', data: { qq: '10001' } }], '', '10001', '')).toBe(true)
    expect(detectMention([{ type: 'at', data: { qq: '999' } }], '', '10001', '')).toBe(false)
  })
  it('T14: a bare reply (no qq in the segment) is NOT a mention — OneBot 11 reply carries only id', () => {
    // 引用作者由门禁的 get_msg 校验决定；这里只覆盖「段内自带 qq 扩展」这种
    // 同步可判的情况，避免把「引用别人」也当唤醒。
    expect(detectMention([{ type: 'reply', data: { id: '1' } }], '', '10001', '')).toBe(false)
    // 上游补的两条边界：CQ 字符串里的裸 reply，以及 reply 段 + 别人的 @。
    expect(detectMention(undefined, '[CQ:reply,id=1] hello', '10001', '')).toBe(false)
    expect(detectMention(undefined, '[CQ:reply,id=1][CQ:at,qq=999] hello', '10001', '')).toBe(false)
  })
  it('A8: reply mentions only when it determinably replies to the bot itself', () => {
    // Replied-to user qq == learned selfId → mention.
    expect(detectMention([{ type: 'reply', data: { id: '1', qq: '10001' } }], '', '10001', '')).toBe(true)
    // selfId unknown but qq == configured botQQ → mention (same bot-id resolution).
    expect(detectMention([{ type: 'reply', data: { id: '1', qq: '10002' } }], '', '', '10002')).toBe(true)
    // Replied-to user is someone else → not a mention.
    expect(detectMention([{ type: 'reply', data: { id: '1', qq: '999' } }], '', '10001', '')).toBe(false)
  })
  it('falls back to CQ strings', () => {
    expect(detectMention(undefined, '[CQ:at,qq=10001] hi', '10001', '')).toBe(true)
    expect(detectMention(undefined, 'hi', '10001', '')).toBe(false)
  })
  it('T14: a CQ-string reply without an author is not a mention', () => {
    expect(detectMention(undefined, '[CQ:reply,id=42] 你好', '10001', '')).toBe(false)
  })
  it('fails closed when bot id unknown', () => {
    expect(detectMention([{ type: 'at', data: { qq: '10001' } }], '', '', '')).toBe(false)
    expect(detectMention([{ type: 'reply', data: { id: '1' } }], '', '', '')).toBe(false)
  })
})

describe('detectExplicitMention', () => {
  it('never treats a reply as an explicit @, even when its qq names the bot', () => {
    expect(detectExplicitMention([{ type: 'reply', data: { id: '1', qq: '10001' } }], '', '10001', '')).toBe(false)
  })
  it('preserves explicit @bot and @all triggers in both message formats', () => {
    for (const qq of ['10001', 'all']) {
      expect(detectExplicitMention([{ type: 'at', data: { qq } }], '', '10001', '')).toBe(true)
      expect(detectExplicitMention(undefined, `[CQ:at,qq=${qq}] hi`, '', '10001')).toBe(true)
    }
  })
})

describe('detectExplicitMention', () => {
  it('counts only at / at-all, never a reply segment', () => {
    expect(detectExplicitMention([{ type: 'at', data: { qq: '10001' } }], '', '10001', '')).toBe(true)
    expect(detectExplicitMention([{ type: 'at', data: { qq: 'all' } }], '', '10001', '')).toBe(true)
    // 引用机器人自己的消息 ≠ 显式 @：门禁要单独校验作者，两者不能混为一谈。
    expect(detectExplicitMention([{ type: 'reply', data: { id: '1', qq: '10001' } }], '', '10001', '')).toBe(false)
  })
  it('falls back to the raw CQ string, including an EMPTY segment array', () => {
    // 531f07a 的回归守卫：normalizeOneBot11 在 event.message 为 [] 时给的是空数组
    // 而不是 undefined，只判 `!== undefined` 会把真实的 @ 丢掉。
    expect(detectExplicitMention([], '[CQ:at,qq=10001] hi', '10001', '')).toBe(true)
    expect(detectExplicitMention(undefined, '[CQ:at,qq=10001] hi', '10001', '')).toBe(true)
  })
  it('fails closed when the bot id is unknown', () => {
    expect(detectExplicitMention([{ type: 'at', data: { qq: '10001' } }], '', '', '')).toBe(false)
    expect(detectExplicitMention(undefined, '[CQ:at,qq=10001]', '', '')).toBe(false)
  })
})

describe('faceToLabel', () => {
  it('names the id from the QQ panel table', () => {
    // id=289 是「睁眼」——旧表把同一 id 映射成 🐛，这条用例守住那次回归。
    expect(faceToLabel('289')).toBe('[表情:睁眼]')
    expect(faceToLabel('0')).toBe('[表情:惊讶]')
    expect(faceToLabel('14')).toBe('[表情:微笑]')
  })
  it('keeps an unknown id diagnosable instead of guessing a face', () => {
    expect(faceToLabel('999999')).toBe('[表情:id=999999]')
    expect(faceToLabel('')).toBe('[表情]')
  })
})
