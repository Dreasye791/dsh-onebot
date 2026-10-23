/**
 * QQ 通道 MCP 白名单闸门（T20）。
 *
 * 为什么需要这道闸门：MCP 服务器的工具注册在加载它的那个 ctx（profile 根）上，
 * 而 dsh 的作用域视图沿链**向下**继承 —— 本插件给每个 QQ 会话建的 agent 是子
 * 作用域，不设闸门时 profile 里所有 MCP 服务器（含 dbx 的数据库工具）都会出现在
 * 机器人的工具表里。这里验证的是闸门的判定语义，不是宿主本身（宿主行为由
 * dsh-tools 保证，插件只消费 tools.guard 的公开契约）。
 *
 * 关键契约（改动本文件前先读）：
 *   ① 空名单 = 禁用全部 MCP 工具（fail-closed，用户硬要求）；
 *   ② 非 MCP 工具（qq_* 与宿主内置）一律放行 —— 闸门只管 MCP；
 *   ③ 取不到工具名时拒绝 —— 契约破裂不静默放行；
 *   ④ 拒绝文案不回显白名单内容 —— 模型可能把它转述到 QQ 群。
 */
import { describe, expect, it } from 'vitest'

import {
  MCP_TOOL_PREFIX,
  describeDroppedEntries,
  describeMcpDenial,
  isMcpToolName,
  makeMcpToolGuard,
  matchMcpTool,
  mcpBareNameOf,
  mcpServerOf,
  normalizeMcpToolAllow,
  parseMcpToolName,
} from '../src/mcp-gate.js'

const NON_MCP = ['read', 'bash', 'qq_send_image', 'qq_send_meme', 'run_code']

describe('T20 工具名解析', () => {
  it('前缀是宿主约定的 mcp__', () => {
    expect(MCP_TOOL_PREFIX).toBe('mcp__')
    expect(isMcpToolName('mcp__a__b')).toBe(true)
    expect(isMcpToolName('qq_send_image')).toBe(false)
    expect(isMcpToolName('')).toBe(false)
  })

  it('按 __ 分段，服务器名含双下划线时其余归工具名', () => {
    expect(parseMcpToolName('mcp__akasha__akasha_search')).toEqual({
      server: 'akasha',
      tool: 'akasha_search',
    })
    // 关键回归：旧实现用 indexOf('__') 取第一个分隔符，mcp__dbx__prod__query
    // 会被解析成 server='dbx' 之外的错位结果，导致 mcp__dbx__* 连带放行
    // dbx__prod 的全部工具。
    expect(parseMcpToolName('mcp__dbx__prod__query')).toEqual({
      server: 'dbx',
      tool: 'prod__query',
    })
    expect(parseMcpToolName('mcp__srv__a__b__c')).toEqual({ server: 'srv', tool: 'a__b__c' })
  })

  it('缺段或空段一律 null', () => {
    expect(parseMcpToolName('mcp__onlyserver')).toBeNull()
    expect(parseMcpToolName('mcp____tool')).toBeNull()
    expect(parseMcpToolName('mcp__server__')).toBeNull()
    expect(parseMcpToolName('read')).toBeNull()
  })

  it('serverOf / bareNameOf 对不合规名有明确定义', () => {
    expect(mcpServerOf('mcp__a__b')).toBe('a')
    expect(mcpServerOf('mcp__onlyserver')).toBe('')
    expect(mcpServerOf('read')).toBe('')
    expect(mcpBareNameOf('mcp__a__b')).toBe('b')
    expect(mcpBareNameOf('mcp__onlyserver')).toBe('onlyserver')
  })
})

describe('T20 白名单匹配', () => {
  it('mcp__<server>__* 只放行该服务器', () => {
    const allow = ['mcp__akasha__*']
    expect(matchMcpTool('mcp__akasha__akasha_read', allow)).toBe(true)
    expect(matchMcpTool('mcp__akasha__nested__tool', allow)).toBe(true)
    expect(matchMcpTool('mcp__dbx__dbx_execute_query', allow)).toBe(false)
    expect(matchMcpTool('mcp__dbx__prod__query', allow)).toBe(false)
    expect(matchMcpTool('mcp__akasha2__x', allow)).toBe(false)
  })

  it('完整名只命中一个工具', () => {
    const allow = ['mcp__akasha__akasha_search']
    expect(matchMcpTool('mcp__akasha__akasha_search', allow)).toBe(true)
    expect(matchMcpTool('mcp__akasha__akasha_read', allow)).toBe(false)
    expect(matchMcpTool('mcp__other__akasha_search', allow)).toBe(false)
  })

  it('服务器名简写与裸工具名', () => {
    expect(matchMcpTool('mcp__akasha__x', ['akasha'])).toBe(true)
    expect(matchMcpTool('mcp__dbx__x', ['akasha'])).toBe(false)
    expect(matchMcpTool('mcp__a__akasha_search', ['akasha_search'])).toBe(true)
    expect(matchMcpTool('mcp__a__other', ['akasha_search'])).toBe(false)
  })

  it('* 放行全部 MCP 工具', () => {
    expect(matchMcpTool('mcp__a__b', ['*'])).toBe(true)
    expect(matchMcpTool('mcp__dbx__dbx_execute_query', ['*'])).toBe(true)
  })

  it('整段全等比较，不做前缀/子串匹配', () => {
    expect(matchMcpTool('mcp__akasha2__x', ['akasha'])).toBe(false)
    expect(matchMcpTool('mcp__akasha__akasha_search2', ['akasha_search'])).toBe(false)
    expect(matchMcpTool('mcp__Akasha__x', ['akasha'])).toBe(false)
  })

  it('非 MCP 名与不合规 MCP 名永不被命中', () => {
    for (const allow of [['*'], ['mcp__akasha__*'], ['akasha'], ['akasha_search']]) {
      for (const name of NON_MCP) expect(matchMcpTool(name, allow)).toBe(false)
    }
    expect(matchMcpTool('mcp__onlyserver', ['*'])).toBe(false)
    expect(matchMcpTool('mcp__server__', ['*'])).toBe(false)
  })

  it('空名单不命中任何 MCP 工具', () => {
    expect(matchMcpTool('mcp__a__b', [])).toBe(false)
  })
})

describe('T20 未文档化通配被丢弃（收紧方向）', () => {
  it('只有 * 与 mcp__<server>__* 两种通配', () => {
    for (const raw of ['akasha*', '*search*', 'mcp__*__x']) {
      expect(normalizeMcpToolAllow([raw])).toEqual([])
      expect(matchMcpTool('mcp__akasha__akasha_search', [raw])).toBe(false)
    }
    expect(normalizeMcpToolAllow(['mcp__srv__*'])).toEqual(['mcp__srv__*'])
  })

  it('describeDroppedEntries 列出会被忽略的条目', () => {
    expect(describeDroppedEntries(['akasha*', 'mcp__akasha__*', '', '  ', '*search*', 42])).toEqual([
      'akasha*',
      '*search*',
      '42',
    ])
  })
})

describe('T20 归一化', () => {
  it('trim、去空、去重保序', () => {
    expect(normalizeMcpToolAllow([' akasha ', 'akasha', '', '  ', '*'])).toEqual(['akasha', '*'])
  })

  it('容忍 undefined 与非字符串项', () => {
    expect(normalizeMcpToolAllow(undefined)).toEqual([])
    expect(normalizeMcpToolAllow([42, 'akasha', null])).toEqual(['akasha'])
  })
})

describe('T20 guard 语义（fail-closed）', () => {
  const empty = makeMcpToolGuard([])

  it('空名单拒绝每一个 MCP 工具', () => {
    for (const name of ['mcp__a__b', 'mcp__dbx__dbx_execute_query', 'mcp__akasha__akasha_search']) {
      const verdict = empty({ name })
      expect(typeof verdict).toBe('string')
      expect(verdict).toContain('mcpToolAllow')
    }
  })

  it('空名单放行全部非 MCP 工具', () => {
    for (const name of NON_MCP) expect(empty({ name })).toBeUndefined()
  })

  it('取不到工具名时拒绝（不静默放行）', () => {
    for (const exec of [undefined, null, {}, { name: 42 }, { name: null }, 'x', 0]) {
      expect(typeof empty(exec as never)).toBe('string')
    }
  })

  it('undefined 配置等价空名单', () => {
    const guard = makeMcpToolGuard(undefined)
    expect(typeof guard({ name: 'mcp__a__b' })).toBe('string')
    expect(guard({ name: 'read' })).toBeUndefined()
  })

  it('不依赖 this，可被解构或 guard.call 调用', () => {
    const guard = makeMcpToolGuard(['*'])
    const detached = guard
    expect(detached({ name: 'mcp__a__b' })).toBeUndefined()
  })

  it('有名单时命中放行、未命中拒绝', () => {
    const guard = makeMcpToolGuard(['mcp__akasha__*'])
    expect(guard({ name: 'mcp__akasha__akasha_search' })).toBeUndefined()
    expect(typeof guard({ name: 'mcp__dbx__dbx_execute_query' })).toBe('string')
  })
})

describe('T20 拒绝文案', () => {
  it('不回显白名单内容', () => {
    const verdict = makeMcpToolGuard(['mcp__akasha__*', 'secret_server'])({ name: 'mcp__dbx__q' })
    expect(typeof verdict).toBe('string')
    expect(verdict).not.toContain('akasha')
    expect(verdict).not.toContain('secret_server')
    expect(verdict).toContain('mcpToolAllow')
  })

  it('取不到名字时给出专用文案且无空引号', () => {
    const verdict = describeMcpDenial('')
    expect(verdict.length).toBeGreaterThan(0)
    expect(verdict).not.toContain('「」')
    expect(verdict).toContain('mcpToolAllow')
  })

  it('有名字时点名被拒工具', () => {
    expect(describeMcpDenial('mcp__dbx__x')).toContain('mcp__dbx__x')
  })
})
