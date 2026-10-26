import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'

import { apply, Config, name, defaultMediaDir } from '../src/index.js'

/** A stubbed cordis service registry carrying the injected surface. */
function makeCtx() {
  const ctx = new Context()
  const tools: Array<{ name: string }> = []
  const sections: Array<{ name: string; order?: number; text?: string }> = []
  const followups: Array<{ text: string }> = []
  const sessionIds: string[] = []
  ctx.provide('tools' as never, {
    register: (tool: { name: string }) => {
      tools.push(tool)
      return () => {
        const idx = tools.indexOf(tool)
        if (idx >= 0) tools.splice(idx, 1)
      }
    },
    // T20：apply() 在启动期探测宿主是否提供 tools.guard（MCP 白名单闸门依赖它），
    // 桩里必须有该方法，否则插件会认为宿主能力缺失而拒绝启动。
    guard: () => () => undefined,
  } as never)
  ctx.provide('systemPrompt' as never, {
    section: (section: { name: string; order?: number; text?: string }) => {
      sections.push(section)
      return () => {
        const idx = sections.indexOf(section)
        if (idx >= 0) sections.splice(idx, 1)
      }
    },
  } as never)
  ctx.provide('agents' as never, {
    create: async (options: { sessionId: string }) => {
      sessionIds.push(String(options.sessionId))
      return {
        agent: {
          session: { id: String(options.sessionId) },
          followup: (message: { content: Array<{ type: string; text?: string }> }) => {
            followups.push({ text: message.content.map(b => b.text ?? '').join('') })
          },
          whenIdle: async () => undefined,
        },
        dispose: async () => undefined,
      }
    },
    resume: async () => { throw new Error('no persistence') },
  } as never)
  ctx.provide('sessions' as never, {
    flush: async () => undefined,
  } as never)
  ctx.provide('agentDefaultModel' as never, {
    currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-chat' }),
  } as never)
  return { ctx, tools, sections, followups, sessionIds }
}

describe('plugin entry', () => {
  it('validates config defaults', () => {
    const config = Config({})
    expect(config.mode).toBe('reverse')
    expect(config.port).toBe(8643)
    expect(config.requireMention).toBe(true)
    expect(config.unknownCommand).toBe('intercept')
    expect(config.sttModel).toBe('small')
  })

  it('applies, registers tools and prompt, then unwinds on disposal', async () => {
    const mediaDir = mkdtempSync(join(tmpdir(), 'onebot-plugin-'))
    const { ctx, tools, sections } = makeCtx()
    const config = Config({
      mediaDir,
      port: 0,
      accessToken: 'test-token',
      botQQ: '10002',
      sttEnabled: false,
      sensitivePatterns: [],
    })
    // apply() registers its lifecycle via ctx.effect; capture the disposer.
    const effectSpy = vi.spyOn(ctx as { effect: (cb: () => unknown, label?: string) => unknown }, 'effect')
    apply(ctx as never, config)

    // New design (§3.24): channel tools and the platform section register per
    // agent scope (installChannelScope in bridge.ts); the plugin scope stays
    // clean so Web/local sessions never see the QQ channel surface.
    expect(tools).toHaveLength(0)
    expect(sections.some(s => s.name === 'channel:dsh-onebot')).toBe(false)

    // Teardown: run the plugin's effect disposer (stops bridge + connection).
    expect(effectSpy).toHaveBeenCalled()
    const disposer = effectSpy.mock.results[0].value as () => Promise<void>
    await disposer()
  })

  it('warns once at mount when workspacePath is unset; silent when configured (T3 方案 B)', () => {
    const mediaDir = mkdtempSync(join(tmpdir(), 'onebot-plugin-'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const warnLines = () => warn.mock.calls.map(call => String(call[0]))
    try {
      // Unset (schema default ''): exactly one mount-time warn naming the cwd.
      const unset = makeCtx()
      apply(unset.ctx as never, Config({ mediaDir, port: 0, accessToken: 'test-token', botQQ: '10002', sttEnabled: false, sensitivePatterns: [] }))
      const cwdWarns = warnLines().filter(line => line.includes('未配置 workspacePath'))
      expect(cwdWarns).toHaveLength(1)
      expect(cwdWarns[0]).toContain(process.cwd())
      // 启动自检（preflight）：管理员为空同样要在挂载期点名 —— 这是首装最常见
      // 的「装好了但没人能说话」，只靠 mounted 行里的 admins=0 没人会注意。
      expect(warnLines().some(line => line.includes('未配置管理员'))).toBe(true)

      // Configured: no workspacePath warn (管理员提示仍会出现，本用例未配 adminUsers)。
      warn.mockClear()
      const set = makeCtx()
      apply(set.ctx as never, Config({ mediaDir, port: 0, accessToken: 'test-token', botQQ: '10002', sttEnabled: false, sensitivePatterns: [], workspacePath: mediaDir }))
      expect(warnLines().some(line => line.includes('未配置 workspacePath'))).toBe(false)
    } finally {
      warn.mockRestore()
    }
  })

  it('管理员已配置时不再提示（preflight 不制造噪声）', () => {
    const mediaDir = mkdtempSync(join(tmpdir(), 'onebot-plugin-'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const ctx = makeCtx()
      apply(ctx.ctx as never, Config({
        mediaDir, port: 0, accessToken: 'test-token', botQQ: '10002', sttEnabled: false,
        sensitivePatterns: [], workspacePath: mediaDir, adminUsers: ['10001'],
      }))
      expect(warn.mock.calls.map(call => String(call[0])).some(line => line.includes('未配置管理员'))).toBe(false)
    } finally {
      warn.mockRestore()
    }
  })

  it('宿主缺少 tools.guard 时启动期就停用通道（不进入每会话抛错循环）', () => {
    const mediaDir = mkdtempSync(join(tmpdir(), 'onebot-plugin-'))
    // 只提供 register，不提供 guard —— 模拟旧版/裁剪过的宿主。
    const bare = new Context()
    bare.provide('tools' as never, { register: () => () => undefined } as never)
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const effect = vi.spyOn(bare as { effect: (cb: () => unknown, label?: string) => unknown }, 'effect')
    try {
      apply(bare as never, Config({ mediaDir, port: 0, accessToken: 'test-token', botQQ: '10002', sttEnabled: false, sensitivePatterns: [] }))
      // 一次可读的 error 说明原因，而不是把失败推迟到每个会话的 create 里
      // （那样会被 registry 的 retire + 重建循环放大约 2 倍，且每条消息都新增
      //   一条 retired id）。
      expect(error).toHaveBeenCalled()
      const line = String(error.mock.calls[0]?.[0])
      expect(line).toContain('tools.guard')
      expect(line).toContain('已停止启动')
      // 提前返回：不注册任何生命周期，通道完全不启动。
      expect(effect).not.toHaveBeenCalled()
    } finally {
      error.mockRestore()
    }
  })

  it('derives a sensible default media dir', () => {
    const home = mkdtempSync(join(tmpdir(), 'onebot-home-'))
    const saved = process.env.DSH_HOME
    process.env.DSH_HOME = home
    try {
      // 只断言「含 media / 含 onebot」对任意 home 都恒成立，等于没测：把实现改成
      // 返回 `<home>/media/onebot` 之外的任何路径（甚至返回 home 本身）也全绿。
      // 这里钉住确切形状。
      expect(defaultMediaDir()).toBe(join(home, 'media', 'onebot'))
    } finally {
      if (saved === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = saved
    }
  })
})
