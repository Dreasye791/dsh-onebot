/**
 * 三个记忆工具的行为测试（第二批评估后补齐）。
 *
 * 背景：`tests/tools-gate.spec.ts` 调 `registerTools` 时**没传 `memory`**，所以
 * `qq_memory_remember` / `qq_memory_recall` / `qq_memory_forget` 在任何测试里都没被
 * 注册、更没被执行过。而这三个工具的 execute 里塞满了「拒绝写入 / 拒绝删除」的权限
 * 与隐私兜底 —— 它们写错时的表现是「成员能删别人的记忆」或「模型永远记不进去」，
 * 日志里什么都没有。这个文件专门盯那条路径。
 *
 * 角色与发言者都用 bridge 的真实状态 seed（`activeTurnRole` / `activeTurnUser`），
 * 不 mock 权限判定 —— 否则测的是假接口。
 * @module dsh-onebot/tests/memory-tools
 */
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'

import { ChatBridge } from '../src/bridge.js'
import { readAllMemories } from '../src/memory.js'
import { registerTools } from '../src/tools.js'

interface MemoryTool {
  name: string
  execute: (args: unknown, exec: unknown) => Promise<unknown>
}

interface HarnessOptions {
  profileScope?: 'dm' | 'all' | 'off'
  maxEntries?: number
  recallTopK?: number
}

/** 真实 ChatBridge + 注册好的记忆工具；角色/发言者通过 seed 冻结到 chat 上。 */
async function makeHarness(options: HarnessOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), 'memory-tools-'))
  const memoryDir = join(root, 'memory')
  const mediaDir = join(root, 'media')
  mkdirSync(mediaDir, { recursive: true })

  const bridge = new ChatBridge({
    ctx: new Context(),
    connection: { call: async () => ({ message_id: 1 }) } as never,
    media: {} as never,
    transcriber: {} as never,
    agents: {} as never,
    sessions: {} as never,
    agentPresets: undefined as never,
    sessionPersistence: undefined,
    workspaceRegistry: undefined as never,
    agentDefaultModel: undefined,
    defaultModel: undefined,
    config: {
      botQQ: '10002', ignoreSelf: false, requireMention: true,
      interimMessages: true, sendErrorNotice: true, restrictedMemberPrefix: false,
      sensitivePatterns: [], mediaDir, maxImageBytes: 1_000_000, maxVoiceBytes: 1_000_000,
      maxFileBytes: 1_000_000, textImageThreshold: 0, cardFooter: 'dsh',
      fontFiles: [], fontFamilies: [], agentPreset: 'standard', workspacePath: mediaDir,
      maxInboundFileBytes: 0,
    },
    policy: {
      dmPolicy: 'open', groupPolicy: 'open', allowFrom: [], groupAllowFrom: [],
      adminUsers: ['10001'], allowAllUsers: false, requireMention: true,
    },
    log: () => undefined,
  })

  /**
   * 绑定一个会话到 QQ chat，并冻结本轮的「角色 + 发言者」。
   *
   * `activeTurnRole` 决定 `canEditFiles`（管理员判定），`activeTurnUser` 决定
   * `speakerFor`（「这话是谁说的」）—— 两者必须一起设，否则权限与主体会指向不同轮次。
   */
  const seed = (chatId: string, sessionId: string, role: 'admin' | 'member', user: string): void => {
    ;(bridge as unknown as { chats: Map<string, Record<string, unknown>> }).chats.set(chatId, {
      queue: Promise.resolve(),
      activeTurnRole: role,
      activeTurnUser: user,
      sessionId,
    })
    ;(bridge as unknown as { bySession: Map<string, string> }).bySession.set(sessionId, chatId)
  }

  const ctx = new Context()
  const tools: MemoryTool[] = []
  ctx.provide('tools' as never, {
    register: (tool: MemoryTool) => {
      tools.push(tool)
      return () => undefined
    },
  } as never)
  // 注意：`registerTools` 是**五参**签名 —— 第 4 参是媒体上限（limits），
  // 第 5 参才是 options（memeDir / mediaDir / memory）。把 `memory` 塞进第 4 参
  // 不会报错但会被忽略，于是记忆工具静默不注册（`tools-gate.spec` 就是这么漏的）。
  registerTools(ctx, bridge, { call: async () => ({ message_id: 1 }) } as never, {
    maxImageBytes: 1_000_000,
    maxVoiceBytes: 1_000_000,
    maxFileBytes: 1_000_000,
  }, {
    memory: {
      enabled: true,
      dir: memoryDir,
      maxEntriesPerChat: options.maxEntries ?? 200,
      recallTopK: options.recallTopK ?? 5,
      profileScope: options.profileScope ?? 'dm',
    },
  })

  const tool = (name: string): MemoryTool => {
    const found = tools.find(item => item.name === name)
    if (found === undefined) {
      throw new Error('tool not registered: ' + name + ' (registered: ' + tools.map(item => item.name).join(', ') + ')')
    }
    return found
  }
  const call = async (name: string, args: unknown, sessionId: string): Promise<unknown> =>
    tool(name).execute(args, { agent: { session: { id: sessionId } } })
  /** 断言抛错并返回错误文案（文案本身是产品行为的一部分）。 */
  const rejectOf = async (name: string, args: unknown, sessionId: string): Promise<string> => {
    try {
      await call(name, args, sessionId)
    } catch (error) {
      return String((error as Error).message)
    }
    throw new Error('expected ' + name + ' to reject, but it resolved')
  }

  return { bridge, call, rejectOf, tool, seed, memoryDir, mediaDir }
}

const DM_ADMIN = { chatId: 'private:10001', sessionId: 's-dm-admin', role: 'admin' as const, user: '10001' }
const GROUP_A = { chatId: 'group:20001', sessionId: 's-group-a', role: 'member' as const, user: '30003' }
const GROUP_USER = { chatId: 'group:20001', sessionId: 's-group-user', role: 'member' as const, user: '10001' }

describe('qq_memory_remember：写入规则', () => {
  it('空正文直接拒绝（不要写一条空记忆）', async () => {
    const h = await makeHarness()
    h.seed(DM_ADMIN.chatId, DM_ADMIN.sessionId, DM_ADMIN.role, DM_ADMIN.user)
    expect(await h.rejectOf('qq_memory_remember', { text: '   ' }, DM_ADMIN.sessionId)).toContain('不能为空')
  })

  it('敏感信息拒绝写入（手机号/身份证/银行卡走同一道闸）', async () => {
    const h = await makeHarness()
    h.seed(DM_ADMIN.chatId, DM_ADMIN.sessionId, DM_ADMIN.role, DM_ADMIN.user)
    const message = await h.rejectOf('qq_memory_remember', { text: '我的手机号是 13800138000' }, DM_ADMIN.sessionId)
    expect(message).toContain('手机号')
    expect(readAllMemories(h.memoryDir, DM_ADMIN.chatId)).toHaveLength(0)
  })

  it('profileScope=off 时拒绝写画像，但 note 仍可写', async () => {
    const h = await makeHarness({ profileScope: 'off' })
    h.seed(DM_ADMIN.chatId, DM_ADMIN.sessionId, DM_ADMIN.role, DM_ADMIN.user)
    expect(await h.rejectOf('qq_memory_remember', { text: '话少', kind: 'profile' }, DM_ADMIN.sessionId))
      .toContain('memoryProfileScope=off')
    await expect(h.call('qq_memory_remember', { text: '周五交周报' }, DM_ADMIN.sessionId))
      .resolves.toMatchObject({ ok: true, kind: 'note' })
  })

  it('群聊 + profileScope=dm 时拒绝写画像（默认最保守）', async () => {
    const h = await makeHarness({ profileScope: 'dm' })
    h.seed(GROUP_USER.chatId, GROUP_USER.sessionId, GROUP_USER.role, GROUP_USER.user)
    expect(await h.rejectOf('qq_memory_remember', { text: '话少', kind: 'profile' }, GROUP_USER.sessionId))
      .toContain('群聊里默认不建个人画像')
    // 群聊 note 不受影响
    await expect(h.call('qq_memory_remember', { text: '明天团建' }, GROUP_USER.sessionId))
      .resolves.toMatchObject({ ok: true, kind: 'note' })
  })

  it('非管理员显式给别人的 subject 被拒绝（防止给别人贴标签）', async () => {
    const h = await makeHarness({ profileScope: 'all' })
    h.seed(GROUP_USER.chatId, GROUP_USER.sessionId, GROUP_USER.role, GROUP_USER.user)
    expect(await h.rejectOf('qq_memory_remember', { text: '爱迟到', kind: 'profile', subject: '99999' }, GROUP_USER.sessionId))
      .toContain('只能记录你自己的画像')
  })

  it('私聊里自动把对话对方当作画像主体（不用显式 subject）', async () => {
    const h = await makeHarness({ profileScope: 'dm' })
    h.seed(DM_ADMIN.chatId, DM_ADMIN.sessionId, DM_ADMIN.role, DM_ADMIN.user)
    await h.call('qq_memory_remember', { text: '喜欢简短回答', kind: 'profile' }, DM_ADMIN.sessionId)
    const [entry] = readAllMemories(h.memoryDir, DM_ADMIN.chatId)
    expect(entry.kind).toBe('profile')
    expect(entry.subject).toBe('10001')
  })

  it('群聊里写入的 note 带 by（谁说的），供 forget 的权限判定使用', async () => {
    const h = await makeHarness()
    h.seed(GROUP_USER.chatId, GROUP_USER.sessionId, GROUP_USER.role, GROUP_USER.user)
    await h.call('qq_memory_remember', { text: '明天团建' }, GROUP_USER.sessionId)
    const [entry] = readAllMemories(h.memoryDir, GROUP_USER.chatId)
    expect(entry.by).toBe('10001')
    expect(entry.role).toBe('member')
  })

  it('超过单会话上限时裁剪最旧（dropped 回给模型）', async () => {
    const h = await makeHarness({ maxEntries: 2 })
    h.seed(DM_ADMIN.chatId, DM_ADMIN.sessionId, DM_ADMIN.role, DM_ADMIN.user)
    await h.call('qq_memory_remember', { text: '第一条' }, DM_ADMIN.sessionId)
    await h.call('qq_memory_remember', { text: '第二条' }, DM_ADMIN.sessionId)
    const result = await h.call('qq_memory_remember', { text: '第三条' }, DM_ADMIN.sessionId)
    expect(result).toMatchObject({ ok: true, stored: 2, dropped: 1 })
    expect(readAllMemories(h.memoryDir, DM_ADMIN.chatId).map(entry => entry.text)).toEqual(['第二条', '第三条'])
  })

  it('完全相同的条目只刷新「最近提及」，不新增行', async () => {
    const h = await makeHarness()
    h.seed(DM_ADMIN.chatId, DM_ADMIN.sessionId, DM_ADMIN.role, DM_ADMIN.user)
    await h.call('qq_memory_remember', { text: '要交周报' }, DM_ADMIN.sessionId)
    const again = await h.call('qq_memory_remember', { text: '要交周报' }, DM_ADMIN.sessionId)
    expect(again).toMatchObject({ ok: true, stored: 1, refreshed: true })
  })
})

describe('qq_memory_recall：召回范围（隐私边界）', () => {
  it('返回本会话的 note', async () => {
    const h = await makeHarness()
    h.seed(DM_ADMIN.chatId, DM_ADMIN.sessionId, DM_ADMIN.role, DM_ADMIN.user)
    await h.call('qq_memory_remember', { text: '周五要交周报' }, DM_ADMIN.sessionId)
    await expect(h.call('qq_memory_recall', { query: '周报' }, DM_ADMIN.sessionId))
      .resolves.toMatchObject({ total: 1, hits: [{ text: '周五要交周报' }] })
  })

  it('别人的画像永远不返回（即使关键词完全命中）', async () => {
    const h = await makeHarness({ profileScope: 'all' })
    // 管理员给 99999 建画像
    h.seed(GROUP_A.chatId, GROUP_A.sessionId, GROUP_A.role, GROUP_A.user)
    const admin = await makeHarness({ profileScope: 'all' })
    admin.seed('group:20001', 's-admin', 'admin', '10001')
    await admin.call('qq_memory_remember', { text: '爱迟到', kind: 'profile', subject: '99999' }, 's-admin')
    // 换一个普通成员来查同一件事
    admin.seed('group:20001', 's-member', 'member', '30003')
    const result = await admin.call('qq_memory_recall', { query: '迟到' }, 's-member') as { total: number }
    expect(result.total).toBe(0)
  })

  it('群聊里自己的画像能被召回（profileScope=all）—— 曾经「写得进、读不出」', async () => {
    // 回归用例：recall 的发言者原来只取 dmSubject(chatId)（群聊恒为 undefined），
    // 于是 selectForRecall 把 profile 全部过滤；写入成功但永远召回不到，且完全静默。
    const h = await makeHarness({ profileScope: 'all' })
    h.seed(GROUP_USER.chatId, GROUP_USER.sessionId, GROUP_USER.role, GROUP_USER.user)
    await h.call('qq_memory_remember', { text: '喜欢螺蛳粉', kind: 'profile' }, GROUP_USER.sessionId)
    const result = await h.call('qq_memory_recall', { query: '螺蛳粉' }, GROUP_USER.sessionId) as {
      total: number
      hits: Array<{ kind: string; text: string }>
    }
    expect(result.total).toBe(1)
    expect(result.hits[0]).toMatchObject({ kind: 'profile', text: '喜欢螺蛳粉' })
  })

  it('过期条目不再返回（软过期：文件留着，召回剔除）', async () => {
    const h = await makeHarness()
    h.seed(DM_ADMIN.chatId, DM_ADMIN.sessionId, DM_ADMIN.role, DM_ADMIN.user)
    // 直接造一条 20 天前的待办（TTL 14 天）
    const { appendMemory } = await import('../src/memory.js')
    appendMemory(h.memoryDir, DM_ADMIN.chatId, {
      ts: Date.now() - 20 * 24 * 60 * 60 * 1000,
      text: '过期的待办',
      tags: ['待办'],
    })
    await expect(h.call('qq_memory_recall', { query: '待办' }, DM_ADMIN.sessionId))
      .resolves.toMatchObject({ total: 0, hits: [] })
  })

  it('topK 生效且不超过硬上限', async () => {
    const h = await makeHarness({ recallTopK: 2 })
    h.seed(DM_ADMIN.chatId, DM_ADMIN.sessionId, DM_ADMIN.role, DM_ADMIN.user)
    for (let index = 0; index < 5; index += 1) {
      await h.call('qq_memory_remember', { text: '周报相关第 ' + index + ' 条' }, DM_ADMIN.sessionId)
    }
    const result = await h.call('qq_memory_recall', { query: '周报' }, DM_ADMIN.sessionId) as { hits: unknown[] }
    expect(result.hits.length).toBeLessThanOrEqual(2)
  })
})

describe('qq_memory_forget：删除权限', () => {
  it('既不给 ts 也不给 query 时拒绝（不做整段清空）', async () => {
    const h = await makeHarness()
    h.seed(DM_ADMIN.chatId, DM_ADMIN.sessionId, DM_ADMIN.role, DM_ADMIN.user)
    expect(await h.rejectOf('qq_memory_forget', {}, DM_ADMIN.sessionId)).toContain('不做整段清空')
  })

  it('按 ts 删掉自己写的条目', async () => {
    const h = await makeHarness()
    h.seed(GROUP_USER.chatId, GROUP_USER.sessionId, GROUP_USER.role, GROUP_USER.user)
    await h.call('qq_memory_remember', { text: '明天团建' }, GROUP_USER.sessionId)
    const [entry] = readAllMemories(h.memoryDir, GROUP_USER.chatId)
    const result = await h.call('qq_memory_forget', { ts: entry.ts }, GROUP_USER.sessionId)
    expect(result).toMatchObject({ removed: 1, items: [{ text: '明天团建' }] })
    expect(readAllMemories(h.memoryDir, GROUP_USER.chatId)).toHaveLength(0)
  })

  it('非管理员删别人写的条目 → 抛错（而不是静默返回 0）', async () => {
    const h = await makeHarness()
    h.seed(GROUP_A.chatId, GROUP_A.sessionId, GROUP_A.role, GROUP_A.user)
    await h.call('qq_memory_remember', { text: '别人的记忆' }, GROUP_A.sessionId) // by = 30003
    const [entry] = readAllMemories(h.memoryDir, GROUP_A.chatId)

    h.seed(GROUP_A.chatId, 's-other', 'member', '40004') // 换一个成员
    const message = await h.rejectOf('qq_memory_forget', { ts: entry.ts }, 's-other')
    expect(message).toContain('只能删除自己写的')
    expect(readAllMemories(h.memoryDir, GROUP_A.chatId)).toHaveLength(1)
  })

  it('管理员可以删别人的条目', async () => {
    const h = await makeHarness()
    h.seed(GROUP_A.chatId, GROUP_A.sessionId, GROUP_A.role, GROUP_A.user)
    await h.call('qq_memory_remember', { text: '别人的记忆' }, GROUP_A.sessionId)
    const [entry] = readAllMemories(h.memoryDir, GROUP_A.chatId)

    h.seed(GROUP_A.chatId, 's-admin', 'admin', '10001')
    await expect(h.call('qq_memory_forget', { ts: entry.ts }, 's-admin')).resolves.toMatchObject({ removed: 1 })
  })

  it('按 query 批量删，且权限过滤逐条生效', async () => {
    const h = await makeHarness()
    h.seed(GROUP_A.chatId, GROUP_A.sessionId, GROUP_A.role, GROUP_A.user)
    await h.call('qq_memory_remember', { text: '周报要交' }, GROUP_A.sessionId)      // by 30003
    h.seed(GROUP_A.chatId, 's-other', 'member', '40004')
    await h.call('qq_memory_remember', { text: '周报别忘了' }, 's-other')            // by 40004
    // 30003 按关键词删：只应删掉自己那条
    h.seed(GROUP_A.chatId, GROUP_A.sessionId, GROUP_A.role, GROUP_A.user)
    const result = await h.call('qq_memory_forget', { query: '周报' }, GROUP_A.sessionId) as { removed: number }
    expect(result.removed).toBe(1)
    expect(readAllMemories(h.memoryDir, GROUP_A.chatId).map(entry => entry.text)).toEqual(['周报别忘了'])
  })

  it('历史条目（无 by）由成员删除 → 抛错（刻意的安全默认）', async () => {
    const h = await makeHarness()
    const { appendMemory } = await import('../src/memory.js')
    appendMemory(h.memoryDir, GROUP_A.chatId, { ts: 1, text: '没有作者的旧条目' })
    h.seed(GROUP_A.chatId, GROUP_A.sessionId, GROUP_A.role, GROUP_A.user)
    expect(await h.rejectOf('qq_memory_forget', { ts: 1 }, GROUP_A.sessionId)).toContain('只能删除自己写的')
  })
})

describe('记忆工具：未启用时完全不注册', () => {
  it('memory.enabled=false 时三个工具都不存在', async () => {
    const root = mkdtempSync(join(tmpdir(), 'memory-tools-off-'))
    const ctx = new Context()
    const names: string[] = []
    ctx.provide('tools' as never, {
      register: (tool: MemoryTool) => {
        names.push(tool.name)
        return () => undefined
      },
    } as never)
    const bridge = new ChatBridge({
      ctx: new Context(),
      connection: { call: async () => ({ message_id: 1 }) } as never,
      media: {} as never, transcriber: {} as never, agents: {} as never, sessions: {} as never,
      agentPresets: undefined as never, sessionPersistence: undefined, workspaceRegistry: undefined as never,
      agentDefaultModel: undefined, defaultModel: undefined,
      config: {
        botQQ: '10002', ignoreSelf: false, requireMention: true, interimMessages: true,
        sendErrorNotice: true, restrictedMemberPrefix: false, sensitivePatterns: [],
        mediaDir: root, maxImageBytes: 1, maxVoiceBytes: 1, maxFileBytes: 1,
        textImageThreshold: 0, cardFooter: 'dsh', fontFiles: [], fontFamilies: [],
        agentPreset: 'standard', workspacePath: root, maxInboundFileBytes: 0,
      },
      policy: {
        dmPolicy: 'open', groupPolicy: 'open', allowFrom: [], groupAllowFrom: [],
        adminUsers: ['10001'], allowAllUsers: false, requireMention: true,
      },
      log: () => undefined,
    })
    registerTools(ctx, bridge, { call: async () => ({ message_id: 1 }) } as never, {
      maxImageBytes: 1, maxVoiceBytes: 1, maxFileBytes: 1,
    }, {
      memory: { enabled: false, dir: join(root, 'memory'), maxEntriesPerChat: 200, recallTopK: 5, profileScope: 'dm' },
    })
    expect(names).not.toContain('qq_memory_remember')
    expect(names).not.toContain('qq_memory_recall')
    expect(names).not.toContain('qq_memory_forget')
  })
})

/** 守卫：本文件必须真的读到落盘文件（否则上面的断言可能是空转）。 */
describe('测试自身有效性', () => {
  it('写入后文件真的存在且可解析', async () => {
    const h = await makeHarness()
    h.seed(DM_ADMIN.chatId, DM_ADMIN.sessionId, DM_ADMIN.role, DM_ADMIN.user)
    await h.call('qq_memory_remember', { text: '落盘校验' }, DM_ADMIN.sessionId)
    const raw = readFileSync(join(h.memoryDir, 'private_10001.jsonl'), 'utf8')
    expect(raw).toContain('落盘校验')
  })
})
