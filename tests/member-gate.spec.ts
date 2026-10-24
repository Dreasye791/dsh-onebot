/**
 * S-02：受限用户（member 回合）的工具闸门。
 *
 * 语义（2026-10-24 审计结论）：角色按回合冻结在 `activeTurnRole`（turn/start 时
 * 从派发队列取），所以闸门必须在 guard 内部实时判定，而不是注册时写死。member
 * 回合**默认拒绝**，只放行只读检索、通道内发送与 MCP（MCP 另有 mcpToolAllow 闸门）。
 *
 * 注意「只读」不等于安全：`Read` 能打开 `napcat/NapCat.Shell/config/*.json`
 * （含 accessToken），所以文件读取类工具对 member 同样必须拒绝 —— 本 spec 把
 * Read/Grep 与 Write/Bash 放在同一组断言里就是钉住这一点。
 *
 * @module dsh-onebot/tests/member-gate
 */
import { describe, expect, it, vi } from 'vitest'

import { makeEvent, makeHarness } from './helpers/bridge-harness.js'

type Harness = Awaited<ReturnType<typeof makeHarness>>

/** agent 作用域里装了两个 guard（MCP 白名单 + 角色闸门），按文案挑角色闸门。 */
function roleGuard(h: Harness): (exec: unknown) => string | undefined {
  const guard = h.captured.guards?.find(g => String(g({ name: 'probe_tool' })).includes('受限用户回合'))
  if (guard === undefined) throw new Error('role guard 未安装（installChannelScope 接线缺失）')
  return guard
}

/** 构造一次工具调用的 guard 入参（宿主 exec 形状：name + agent.session.id）。 */
const exec = (name: string, sessionId: string) => ({ name, agent: { session: { id: sessionId } } })

/** 群聊里的非管理员（10003）@ 机器人：member 回合必须走群聊（私聊 open = 仅管理员）。 */
function sendMemberGroupText(h: Harness, text: string): void {
  h.client.send(JSON.stringify({
    post_type: 'message', message_type: 'group', user_id: 10003, group_id: 888, self_id: 10002,
    message: [
      { type: 'at', data: { qq: '10002' } },
      { type: 'text', data: { text } },
    ],
    raw_message: '[CQ:at,qq=10002]' + text,
    sender: { user_id: 10003, nickname: '群友' },
  }))
}

/** 派发一条 member 群消息并冻结该回合角色（返回 sessionId）。 */
async function freezeMemberTurn(h: Harness): Promise<string> {
  sendMemberGroupText(h, '帮我看下这个文件')
  await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
  const sessionId = h.sessionIds[0]
  h.ctx.emit('session/event', { id: sessionId } as never, makeEvent('turn/start', { turn: 1 }))
  expect(h.bridge.canEditFiles(sessionId)).toBe(false)
  return sessionId
}

describe('S-02 member 回合工具闸门', () => {
  it('member 回合拒绝写/执行/本地读取类工具', async () => {
    const h = await makeHarness()
    const sessionId = await freezeMemberTurn(h)
    const guard = roleGuard(h)

    for (const name of ['Write', 'Edit', 'MultiEdit', 'Bash', 'write_file', 'run_command', 'Read', 'Grep', 'Glob', 'qq_napcat_api']) {
      expect(typeof guard(exec(name, sessionId)), name + ' 必须被拒').toBe('string')
    }
    // 拒绝文案要给出方向，且点名被拒工具。
    const denial = guard(exec('Write', sessionId)) as string
    expect(denial).toContain('受限用户回合')
    expect(denial).toContain('Write')

    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  })

  it('member 回合仍可发送消息、联网检索与走 MCP 白名单', async () => {
    const h = await makeHarness()
    const sessionId = await freezeMemberTurn(h)
    const guard = roleGuard(h)

    for (const name of ['qq_send_image', 'qq_send_file', 'qq_group_history', 'web_search', 'web_fetch', 'todo_write', 'mcp__akasha__akasha_search']) {
      expect(guard(exec(name, sessionId)), name + ' 应放行').toBeUndefined()
    }

    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  })

  it('admin 回合放行同一批工具（角色按回合实时判定，不是注册时写死）', async () => {
    const h = await makeHarness()
    h.sendText('建个文件') // 默认 harness 的 10001 是管理员
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    const sessionId = h.sessionIds[0]
    h.ctx.emit('session/event', { id: sessionId } as never, makeEvent('turn/start', { turn: 1 }))
    expect(h.bridge.canEditFiles(sessionId)).toBe(true)
    const guard = roleGuard(h)

    for (const name of ['Write', 'Edit', 'Bash', 'Read', 'qq_napcat_api']) {
      expect(guard(exec(name, sessionId)), name + ' 应放行').toBeUndefined()
    }

    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  })

  it('查不到 chat 映射的 session 按 member 处理（fail-closed，别把未知当管理员）', async () => {
    const h = await makeHarness()
    sendMemberGroupText(h, '你好')
    await vi.waitFor(() => expect(h.captured.followups).toHaveLength(1))
    const guard = roleGuard(h)

    // canEditFiles 对未知 session 返回 true（非 QQ 会话默认信任），闸门必须
    // 先要求它映射到真实 chat，否则这里会 fail-open。
    expect(typeof guard(exec('Write', 'no-such-session'))).toBe('string')
    expect(typeof guard(exec('Read', 'no-such-session'))).toBe('string')
    // 取不到名字 / 取不到 exec 同样拒绝。
    expect(typeof guard({ name: '', agent: { session: { id: h.sessionIds[0] } } })).toBe('string')
    expect(typeof guard({})).toBe('string')

    h.client.close()
    await h.bridge.stop()
    await h.connection.stop()
  })
})
