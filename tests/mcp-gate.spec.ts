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
  MCP_ALLOW_ITEM_MAX_LEN,
  MCP_ALLOW_MAX_ENTRIES,
  MCP_TOOL_PREFIX,
  NATIVE_TOOL_DENY_PREFIXES,
  describeDroppedEntries,
  describeMcpDenial,
  describeNativeDenial,
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
      ambiguous: false,
    })
    // 段数 > 2 时边界有歧义：mcp__dbx__prod__query 既可能是 server='dbx' +
    // tool='prod__query'，也可能是 server='dbx__prod' + tool='query'。这里给出
    // 的是「server 取第一段」的口径，ambiguous=true 提醒调用方按段放宽的判定
    // 必须放弃（见后续 matchMcpTool 的用例）。
    expect(parseMcpToolName('mcp__dbx__prod__query')).toEqual({
      server: 'dbx',
      tool: 'prod__query',
      ambiguous: true,
    })
    expect(parseMcpToolName('mcp__srv__a__b__c')).toEqual({
      server: 'srv',
      tool: 'a__b__c',
      ambiguous: true,
    })
    // tool 以单下划线开头同样歧义：mcp__dbx___query 去掉前缀是 dbx___query，
    // 按 __ 切得 server='dbx' / tool='_query'，但真实切分也可以是
    // server='dbx_' + tool='query'（服务器名允许单下划线）。
    expect(parseMcpToolName('mcp__dbx___query')).toEqual({
      server: 'dbx',
      tool: '_query',
      ambiguous: true,
    })
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
  it('mcp__<server>__* 只放行该服务器的单段工具名', () => {
    const allow = ['mcp__akasha__*']
    expect(matchMcpTool('mcp__akasha__akasha_read', allow)).toBe(true)
    // 通配只覆盖单段工具名：mcp__akasha__nested__tool 的余段含 __，边界歧义，
    // 不能用服务器通配放行（否则真实服务器 akasha__nested 会被连带授权）。
    expect(matchMcpTool('mcp__akasha__nested__tool', allow)).toBe(false)
    expect(matchMcpTool('mcp__dbx__dbx_execute_query', allow)).toBe(false)
    expect(matchMcpTool('mcp__dbx__prod__query', allow)).toBe(false)
    expect(matchMcpTool('mcp__akasha2__x', allow)).toBe(false)
  })

  it('服务器名含 __ 时不会越权，且可用显式通配授权', () => {
    // 关键回归：这条曾以为已修但实际没修 —— 旧实现按 parts[0] 比 server，
    // 于是 mcp__dbx__* 会把真实服务器 dbx__prod 的工具一并放行。
    expect(matchMcpTool('mcp__dbx__prod__query', ['mcp__dbx__*'])).toBe(false)
    // 显式写全服务器名仍可整体授权（余段 query 是单段）。
    expect(matchMcpTool('mcp__dbx__prod__query', ['mcp__dbx__prod__*'])).toBe(true)
    // 歧义名不能靠服务器名简写或裸工具名授权（段边界不可判定）。
    expect(matchMcpTool('mcp__dbx__prod__query', ['dbx'])).toBe(false)
    expect(matchMcpTool('mcp__dbx__prod__query', ['query'])).toBe(false)
    expect(matchMcpTool('mcp__dbx__prod__query', ['prod__query'])).toBe(false)
    // 完整名与 * 始终可用。
    expect(matchMcpTool('mcp__dbx__prod__query', ['mcp__dbx__prod__query'])).toBe(true)
    expect(matchMcpTool('mcp__dbx__prod__query', ['*'])).toBe(true)
  })

  it('服务器名以单个下划线结尾时也不会越权', () => {
    // 与上一条同一类边界，只是从 `__` 缩到尾部单个 `_`：
    // mcp__dbx___query 去掉前缀是 dbx___query，真实切分可以是
    // server='dbx_' + tool='query'（mcp__ + dbx_ + __ + query），于是
    // mcp__dbx__* 的前缀匹配会命中它、余段 '_query' 既非空又不含 '__'，
    // 旧实现因此放行了一个属于 dbx_ 这个服务器的工具。
    expect(matchMcpTool('mcp__dbx___query', ['mcp__dbx__*'])).toBe(false)
    // 显式写全服务器名仍可整体授权（余段是单段 query）。
    expect(matchMcpTool('mcp__dbx___query', ['mcp__dbx___*'])).toBe(true)
    // 歧义名不能靠服务器名简写或裸工具名授权。
    expect(matchMcpTool('mcp__dbx___query', ['dbx'])).toBe(false)
    expect(matchMcpTool('mcp__dbx___query', ['_query'])).toBe(false)
    // 完整名与 * 始终可用。
    expect(matchMcpTool('mcp__dbx___query', ['mcp__dbx___query'])).toBe(true)
    expect(matchMcpTool('mcp__dbx___query', ['*'])).toBe(true)
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
    // 只报原因与计数，**不回显条目原文**（条目可能误粘 token，而这条 warn 会
    // 落进插件日志、还会被 /doctor 的诊断包带走）。
    const dropped = describeDroppedEntries(['akasha*', 'mcp__akasha__*', '', '  ', '*search*', 42])
    expect(dropped).toEqual(['3 条写法无法识别'])
    for (const line of dropped) {
      expect(line).not.toContain('akasha*')
      expect(line).not.toContain('*search*')
    }
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

  it('空字符串工具名同样拒绝（与「取不到名字」同义）', () => {
    // 曾漏掉这一条：空串能过 typeof === 'string' 检查，随后 isMcpToolName('') 为
    // false 而被当成「非 MCP 工具」放行，使 describeMcpDenial('') 的专用文案成为
    // 生产路径不可达的死分支。
    const verdict = empty({ name: '' })
    expect(typeof verdict).toBe('string')
    expect(verdict).toContain('无法确定')
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

/**
 * 运行时加载的是 `lib/`（`package.json` 的 `main: lib/index.js`，且 `lib/bridge.js`
 * 里 import 的是 `./mcp-gate.js`），而上面的用例全部指向 `../src/mcp-gate.js`。
 * 也就是说：src 与 lib 是手工双写的两份实现，只测 src 时 lib 漂了也全绿 —— 闸门在
 * 生产里可能压根不生效。这一组直接加载 lib 产物，并对两侧做同输入对比。
 */
describe('原生第三方工具前缀黑名单（不受 mcpToolAllow 管控）', () => {
  it('mnemon_* 一律拒绝，即使 mcpToolAllow 放开全部', () => {
    // 背景：mnemon_* 不带 mcp__ 前缀，早期实现里 `isMcpToolName → false` 就直接放行了，
    // 等于 QQ 会话能直接读写宿主全局记忆库（G:\dsh-home\.mnemon）。
    const guard = makeMcpToolGuard(['*'])
    for (const name of ['mnemon_recall', 'mnemon_remember', 'mnemon_forget', 'mnemon_document_search', 'mnemon_view_route']) {
      const verdict = guard({ name })
      expect(typeof verdict).toBe('string')
      expect(verdict).toContain('第三方插件')
    }
  })

  it('不影响本插件工具、宿主内置与已放行的 MCP', () => {
    const guard = makeMcpToolGuard(['mcp__dbx__*'])
    expect(guard({ name: 'qq_memory_recall' })).toBeUndefined()
    expect(guard({ name: 'qq_send_image' })).toBeUndefined()
    expect(guard({ name: 'read' })).toBeUndefined()
    expect(guard({ name: 'mcp__dbx__query' })).toBeUndefined()
  })

  it('按前缀匹配，不做模糊包含', () => {
    const guard = makeMcpToolGuard(['*'])
    // 名字里含 mnemon_ 但不是开头 → 不归本闸门管（仍走原有 MCP 判定）
    expect(guard({ name: 'qq_mnemon_probe' })).toBeUndefined()
    expect(guard({ name: 'my_mnemon_recall' })).toBeUndefined()
  })

  it('第二参可覆盖；空数组 = 只按 MCP 白名单管控', () => {
    const guard = makeMcpToolGuard(['*'], [])
    expect(guard({ name: 'mnemon_recall' })).toBeUndefined()
    const custom = makeMcpToolGuard([], ['other_'])
    expect(custom({ name: 'other_tool' })).toContain('第三方插件')
    expect(custom({ name: 'mnemon_recall' })).toBeUndefined()
  })

  it('空字符串前缀不会吞掉所有工具', () => {
    const guard = makeMcpToolGuard(['*'], [''])
    expect(guard({ name: 'read' })).toBeUndefined()
    expect(guard({ name: 'qq_send_image' })).toBeUndefined()
  })

  it('拒绝文案点名工具但不回显接入清单', () => {
    const text = describeNativeDenial('mnemon_recall')
    expect(text).toContain('mnemon_recall')
    expect(text).toContain('第三方插件')
    expect(text).not.toContain('mcpToolAllow')
    expect(NATIVE_TOOL_DENY_PREFIXES).toEqual(['mnemon_'])
  })
})

describe('T20 lib 产物与 src 双写一致', () => {
  it('lib 产物的判定语义与 src 完全一致', async () => {
    const lib = await import('../lib/mcp-gate.js')
    const cases: Array<[string, string[]]> = [
      ['mcp__akasha__akasha_search', ['mcp__akasha__*']],
      ['mcp__akasha__akasha_search', ['akasha']],
      ['mcp__akasha__akasha_search', ['akasha_search']],
      ['mcp__akasha__akasha_search', ['mcp__dbx__*']],
      ['mcp__dbx__prod__query', ['mcp__dbx__*']],
      ['mcp__dbx__prod__query', ['mcp__dbx__prod__*']],
      ['mcp__dbx__prod__query', ['mcp__dbx__prod__query']],
      ['mcp__dbx__prod__query', ['*']],
      ['mcp__akasha__nested__tool', ['mcp__akasha__*']],
      ['qq_send_image', ['*']],
      ['mcp__a__b', []],
    ]
    for (const [name, allow] of cases) {
      expect(lib.matchMcpTool(name, allow), name + ' / ' + JSON.stringify(allow)).toBe(
        matchMcpTool(name, allow),
      )
    }
  })

  it('lib 的 guard 与 src 表现一致（含放行样例与畸形 exec）', async () => {
    const lib = await import('../lib/mcp-gate.js')
    // 必须带**非空白名单**：只有拒绝样例时，把 lib 的 guard 写成「一律拒绝」
    // 也照样全绿，等于没测。这里同时比返回值本身（而非 typeof），放行与拒绝
    // 两面都钉住。
    for (const allow of [[], ['mcp__akasha__*'], ['*']]) {
      const libGuard = lib.makeMcpToolGuard(allow)
      const srcGuard = makeMcpToolGuard(allow)
      const execs = [
        undefined,
        null,
        {},
        { name: 42 },
        { name: null },
        { name: '' },
        'x',
        0,
        { name: 'read' },
        { name: 'qq_send_image' },
        { name: 'mcp__akasha__akasha_search' },
        { name: 'mcp__dbx__dbx_execute_query' },
        { name: 'mcp__dbx___query' },
      ]
      for (const exec of execs) {
        const a = srcGuard(exec as never)
        const b = libGuard(exec as never)
        expect(b, JSON.stringify(exec) + ' / ' + JSON.stringify(allow)).toBe(a)
      }
    }
  })

  it('lib 的 parse 也带 ambiguous 标记', async () => {
    const lib = await import('../lib/mcp-gate.js')
    expect(lib.parseMcpToolName('mcp__dbx__prod__query').ambiguous).toBe(true)
    expect(lib.parseMcpToolName('mcp__a__b').ambiguous).toBe(false)
    // tool 以 `_` 开头同样歧义：真实切分可能是 server=`dbx_` + tool=`query`。
    expect(lib.parseMcpToolName('mcp__dbx___query').ambiguous).toBe(true)
  })

  it('lib 的限幅与 src 一致（超长丢弃、超量截断、只报计数）', async () => {
    const lib = await import('../lib/mcp-gate.js')
    const long = 'x'.repeat(MCP_ALLOW_ITEM_MAX_LEN + 1)
    expect(lib.normalizeMcpToolAllow([long])).toEqual(normalizeMcpToolAllow([long]))
    const many = Array.from({ length: MCP_ALLOW_MAX_ENTRIES + 4 }, (_, i) => 's' + i)
    const a = lib.normalizeMcpToolAllow(many)
    expect(a).toEqual(normalizeMcpToolAllow(many))
    expect(a).toHaveLength(MCP_ALLOW_MAX_ENTRIES)
    // 只报原因与计数，不回显条目原文。
    const dropped = lib.describeDroppedEntries(['', 'a', 'a', 'akasha*', long])
    expect(dropped).toEqual(describeDroppedEntries(['', 'a', 'a', 'akasha*', long]))
    for (const line of dropped) {
      expect(line).not.toContain('akasha*')
      expect(line).not.toContain(long)
    }
  })
})
