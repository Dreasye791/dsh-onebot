/**
 * 「本轮发言者」FIFO（`pendingTurnUsers`）的语义。
 *
 * 为什么必须单独测：这条队列存在的**唯一理由**就是防串号 —— 忙时 A 的消息排队后
 * B 又发一条，若只记「最后一个发言者」，两个回合都会读到 B 的 QQ，于是 A 的偏好/
 * 画像被写到 B 头上。而此前 `bridge.spec` 的字段快照只检查了 `pendingTurnRoles`，
 * `activeTurnUser` 一条断言都没有 —— 退化成「只存最后一个」也是全绿。
 *
 * `turn/start` 是 private，但它是唯一会把队列出队的入口（`onSessionEvent` 内部按
 * `session.id` 反查 chat），所以这里反射驱动它，而不是去复制出队逻辑。
 * @module dsh-onebot/tests/turn-speaker
 */
import { describe, expect, it, vi } from 'vitest'

import { makeCmdHarness } from './helpers/bridge-harness.js'

interface ChatLike {
  agent: { session: { id: string } }
  activeTurnRole: string
  activeTurnUser: string | undefined
  pendingTurnUsers: Array<string | undefined>
  pendingTurnRoles: string[]
}

/** 反射触发 turn/start（`onSessionEvent` 只用 `session.id`）。 */
function fireTurnStart(bridge: unknown, sessionId: string): void {
  const fn = (bridge as {
    onSessionEvent: (session: { id: string }, event: { type: string }) => void
  }).onSessionEvent
  fn.call(bridge, { id: sessionId }, { type: 'turn/start' })
}

describe('本轮发言者 FIFO（忙时排队不串号）', () => {
  it('同一会话连续两条（不同人）→ 两轮依次冻结各自的发言人', async () => {
    const h = await makeCmdHarness()
    h.sendGroupTextAs('A 说的', 10001)
    await vi.waitFor(() => expect(h.chats().size).toBe(1))
    h.sendGroupTextAs('B 说的', 20002)
    await vi.waitFor(() => {
      const chat = h.chats().get('group:888') as unknown as ChatLike
      expect(chat.pendingTurnUsers).toHaveLength(2)
    })

    const chat = h.chats().get('group:888') as unknown as ChatLike
    const sessionId = chat.agent.session.id

    fireTurnStart(h.bridge, sessionId)
    expect(h.bridge.speakerFor(sessionId)).toBe('10001')

    // 第二轮必须出队 B。若实现退化成「只存最后一个」，第一轮就已经是 20002，
    // 这里也拿不到正确的顺序 —— 两条断言一起才锁住 FIFO 语义。
    fireTurnStart(h.bridge, sessionId)
    expect(h.bridge.speakerFor(sessionId)).toBe('20002')
  })

  it('角色与发言人在同一轮里成对出队（admin 轮的 role 与 user 不串）', async () => {
    const h = await makeCmdHarness()
    // 10001 在 adminUsers 里；30003 是普通成员
    h.sendGroupTextAs('管理员的', 10001)
    h.sendGroupTextAs('成员的', 30003)
    await vi.waitFor(() => expect(h.chats().size).toBe(1))

    const chat = h.chats().get('group:888') as unknown as ChatLike
    const sessionId = chat.agent.session.id

    fireTurnStart(h.bridge, sessionId)
    expect(chat.activeTurnRole).toBe('admin')
    expect(h.bridge.speakerFor(sessionId)).toBe('10001')

    fireTurnStart(h.bridge, sessionId)
    expect(chat.activeTurnRole).toBe('member')
    expect(h.bridge.speakerFor(sessionId)).toBe('30003')
  })

  it('队列空（宿主直接输入 / 重放）→ 发言者 undefined，角色 fail-closed 为 member', async () => {
    const h = await makeCmdHarness()
    h.sendGroupTextAs('A 说的', 10001)
    await vi.waitFor(() => expect(h.chats().size).toBe(1))

    const chat = h.chats().get('group:888') as unknown as ChatLike
    // 模拟「这一轮不是插件派发的」：清空队列后触发 turn/start
    chat.pendingTurnUsers.length = 0
    chat.pendingTurnRoles.length = 0
    fireTurnStart(h.bridge, chat.agent.session.id)

    expect(h.bridge.speakerFor(chat.agent.session.id)).toBeUndefined()
    expect(chat.activeTurnRole).toBe('member')
  })

  it('未知 session → undefined（不猜测、不返回空串）', async () => {
    const h = await makeCmdHarness()
    expect(h.bridge.speakerFor('session-that-does-not-exist')).toBeUndefined()
    expect(h.bridge.speakerFor(undefined)).toBeUndefined()
  })
})
