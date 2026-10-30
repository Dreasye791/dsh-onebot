import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  appendMemory,
  chatIdFromFileName,
  cosineSimilarity,
  deleteMemoriesWhere,
  deleteMemory,
  findSensitive,
  forgetProfiles,
  isExpired,
  keywordScore,
  listMemoryFiles,
  memoryFileName,
  memoryFilePath,
  readAllMemories,
  readMemories,
  searchMemories,
  searchMemoriesHybrid,
  selectForRecall,
  speakerFromUserEvents,
  tokenize,
  trimMemories,
  ttlDaysFor,
  updateMemory,
  upsertMemory,
} from '../src/memory.js'
import type { MemoryEntry } from '../src/memory.js'

const makeDir = (): string => mkdtempSync(join(tmpdir(), 'onebot-memory-'))

describe('memory: 文件命名与路径', () => {
  it('chatId 里的冒号/斜杠被替换成下划线（Windows 文件名安全）', () => {
    expect(memoryFileName('private:123456')).toBe('private_123456.jsonl')
    expect(memoryFileName('group:789')).toBe('group_789.jsonl')
    // 已被替换过的名字保持不变
    expect(memoryFileName('a-b_c.d')).toBe('a-b_c.d.jsonl')
  })

  it('memoryFilePath 拼接在 memoryDir 下', () => {
    expect(memoryFilePath('G:/media/memory', 'private:1')).toBe(join('G:/media/memory', 'private_1.jsonl'))
  })
})

describe('memory: 追加与读取', () => {
  it('追加后能按原样读回，且目录会自动创建', () => {
    const dir = join(makeDir(), 'nested', 'memory')
    appendMemory(dir, 'private:1', { ts: 1000, text: '用户喜欢螺蛳粉', tags: ['偏好'] })
    appendMemory(dir, 'private:1', { ts: 2000, text: '周五要交周报' })
    const entries = readMemories(dir, 'private:1')
    expect(entries).toHaveLength(2)
    expect(entries[0]).toEqual({ ts: 1000, text: '用户喜欢螺蛳粉', tags: ['偏好'] })
    expect(entries[1]).toEqual({ ts: 2000, text: '周五要交周报' })
  })

  it('不同 chat 互不干扰', () => {
    const dir = makeDir()
    appendMemory(dir, 'private:1', { ts: 1, text: 'A 的记忆' })
    appendMemory(dir, 'group:2', { ts: 2, text: 'B 的记忆' })
    expect(readMemories(dir, 'private:1').map((e) => e.text)).toEqual(['A 的记忆'])
    expect(readMemories(dir, 'group:2').map((e) => e.text)).toEqual(['B 的记忆'])
  })

  it('坏行被跳过而不是整体失败', () => {
    const dir = makeDir()
    appendMemory(dir, 'private:1', { ts: 1, text: '好的一条' })
    const file = memoryFilePath(dir, 'private:1')
    writeFileSync(file, readFileSync(file, 'utf8') + '{坏 json\n\n' + JSON.stringify({ text: '' }) + '\n', 'utf8')
    const entries = readMemories(dir, 'private:1')
    expect(entries.map((e) => e.text)).toEqual(['好的一条'])
  })

  it('文件不存在时返回空数组', () => {
    expect(readMemories(makeDir(), 'private:404')).toEqual([])
  })

  it('max 参数只保留最近的若干条', () => {
    const dir = makeDir()
    for (let i = 1; i <= 5; i += 1) appendMemory(dir, 'private:1', { ts: i, text: '第 ' + i + ' 条' })
    expect(readMemories(dir, 'private:1', 2).map((e) => e.text)).toEqual(['第 4 条', '第 5 条'])
  })
})

describe('memory: 容量裁剪', () => {
  it('超过上限时丢弃最旧的，并在文件里真正落盘', () => {
    const dir = makeDir()
    for (let i = 1; i <= 4; i += 1) appendMemory(dir, 'private:1', { ts: i, text: '第 ' + i + ' 条' })
    const dropped = trimMemories(dir, 'private:1', 2)
    expect(dropped).toBe(2)
    expect(readMemories(dir, 'private:1').map((e) => e.text)).toEqual(['第 3 条', '第 4 条'])
  })

  it('未超上限时不裁剪（返回 0）', () => {
    const dir = makeDir()
    appendMemory(dir, 'private:1', { ts: 1, text: '唯一一条' })
    expect(trimMemories(dir, 'private:1', 10)).toBe(0)
  })
})

describe('memory: 分词', () => {
  it('中文出 2-gram 与整段，英文/数字按片段', () => {
    const tokens = tokenize('螺蛳粉好吃 2026 report')
    expect(tokens).toContain('螺蛳粉好吃')
    expect(tokens).toContain('螺蛳')
    expect(tokens).toContain('蛳粉')
    expect(tokens).toContain('2026')
    expect(tokens).toContain('report')
  })

  it('单字中文保留单字', () => {
    expect(tokenize('粉')).toEqual(['粉'])
  })
})

describe('memory: 关键词召回', () => {
  const entries: MemoryEntry[] = [
    { ts: 3, text: '用户喜欢螺蛳粉，微辣', tags: ['偏好'] },
    { ts: 2, text: '周五要交周报' },
    { ts: 1, text: '服务器部署在 10.0.0.5' },
  ]

  it('命中关键词的排在前，且能命中标签', () => {
    const hits = searchMemories(entries, '螺蛳粉')
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0]?.entry.text).toContain('螺蛳粉')
    // 标签也参与匹配
    const byTag = searchMemories(entries, '偏好')
    expect(byTag[0]?.entry.text).toContain('螺蛳粉')
  })

  it('无命中返回空数组（不抛错）', () => {
    expect(searchMemories(entries, '量子力学')).toEqual([])
  })

  it('空 query 或 topK<=0 返回空数组', () => {
    expect(searchMemories(entries, '   ')).toEqual([])
    expect(searchMemories(entries, '螺蛳粉', 0)).toEqual([])
  })

  it('topK 限制返回条数', () => {
    const many: MemoryEntry[] = [
      { ts: 3, text: '周报 甲' },
      { ts: 2, text: '周报 乙' },
      { ts: 1, text: '周报 丙' },
    ]
    expect(searchMemories(many, '周报', 2)).toHaveLength(2)
  })

  it('分数随命中词覆盖率上升', () => {
    const hits = searchMemories(entries, '螺蛳粉 微辣')
    const full = hits.find((h) => h.entry.text.includes('螺蛳粉'))
    expect(full?.score).toBeGreaterThan(0)
  })
})

describe('memory: 类型与来源字段', () => {
  it('历史条目没有 kind 字段时按 note 处理，且不丢 by/role/subject', () => {
    const dir = makeDir()
    const file = memoryFilePath(dir, 'group:1')
    appendMemory(dir, 'group:1', { ts: 1, text: '旧条目' })
    appendMemory(dir, 'group:1', { ts: 2, text: '喜欢简短回答', kind: 'profile', subject: '1001', by: '1001', role: 'member' })
    const entries = readAllMemories(dir, 'group:1')
    expect(entries[0]?.kind).toBeUndefined()
    expect(entries[1]).toEqual({ ts: 2, text: '喜欢简短回答', kind: 'profile', subject: '1001', by: '1001', role: 'member' })
    expect(file.endsWith('group_1.jsonl')).toBe(true)
  })
})

describe('memory: TTL 分档与绝对过期', () => {
  const DAY = 24 * 60 * 60 * 1000
  const now = 1_000 * DAY

  it('按标签取 TTL：待办 14 / 偏好不过期 / 事实 365 / 无标签 90', () => {
    expect(ttlDaysFor({ ts: 0, text: '', tags: ['待办'] })).toBe(14)
    expect(ttlDaysFor({ ts: 0, text: '', tags: ['偏好'] })).toBe(0)
    expect(ttlDaysFor({ ts: 0, text: '', tags: ['事实'] })).toBe(365)
    expect(ttlDaysFor({ ts: 0, text: '' })).toBe(90)
  })

  it('待办 15 天前写入 → 过期；偏好再久也不过期', () => {
    expect(isExpired({ ts: now - 15 * DAY, text: '交周报', tags: ['待办'] }, now)).toBe(true)
    expect(isExpired({ ts: now - 14 * DAY, text: '交周报', tags: ['待办'] }, now)).toBe(false)
    expect(isExpired({ ts: now - 3000 * DAY, text: '叫他小明', tags: ['偏好'] }, now)).toBe(false)
  })

  it('无标签条目 91 天过期、89 天不过期', () => {
    expect(isExpired({ ts: now - 91 * DAY, text: 'x' }, now)).toBe(true)
    expect(isExpired({ ts: now - 89 * DAY, text: 'x' }, now)).toBe(false)
  })
})

describe('memory: 召回范围', () => {
  const now = Date.now()
  const entries: MemoryEntry[] = [
    { ts: now, text: '本群规矩：先问再答' },
    { ts: now, text: '喜欢简短回答', kind: 'profile', subject: '1001', by: '1001', role: 'member' },
    { ts: now, text: '不吃香菜', kind: 'profile', subject: '1002', by: '1002', role: 'member' },
    { ts: now - 900 * 86_400_000, text: '很久以前的待办', tags: ['待办'] },
  ]

  it('note 全给，profile 只给当前发言者自己', () => {
    const forA = selectForRecall(entries, { speaker: '1001' })
    expect(forA.map((e) => e.text)).toEqual(['本群规矩：先问再答', '喜欢简短回答'])
    const forB = selectForRecall(entries, { speaker: '1002' })
    expect(forB.map((e) => e.text)).toEqual(['本群规矩：先问再答', '不吃香菜'])
  })

  it('取不到发言者时不返回任何画像', () => {
    const anonymous = selectForRecall(entries, {})
    expect(anonymous.map((e) => e.text)).toEqual(['本群规矩：先问再答'])
  })

  it('includeProfiles=false 时连自己的画像也不返回', () => {
    const onlyNotes = selectForRecall(entries, { speaker: '1001', includeProfiles: false })
    expect(onlyNotes.map((e) => e.text)).toEqual(['本群规矩：先问再答'])
  })

  it('过期条目一律排除（含 note）', () => {
    const forA = selectForRecall(entries, { speaker: '1001' })
    expect(forA.some((e) => e.text.includes('很久以前的待办'))).toBe(false)
  })
})

describe('memory: 敏感信息拦截', () => {
  it('识别手机号 / 身份证 / 银行卡', () => {
    expect(findSensitive('我的号是 13812345678')).toBe('手机号')
    expect(findSensitive('身份证 110101199003071234')).toBe('身份证号')
    expect(findSensitive('卡号 6222021234567890')).toBe('银行卡号')
  })

  it('普通文本与短数字不误伤', () => {
    expect(findSensitive('喜欢微辣，周三有空')).toBeNull()
    expect(findSensitive('群号 123456789')).toBeNull()
    // 13 位时间戳不在 16-19 位范围内
    expect(findSensitive('时间戳 1730000000000')).toBeNull()
  })
})

describe('memory: 删除画像', () => {
  it('只删指定主体，note 与别人的画像保留', () => {
    const dir = makeDir()
    appendMemory(dir, 'group:1', { ts: 1, text: '群规' })
    appendMemory(dir, 'group:1', { ts: 2, text: 'A 的偏好', kind: 'profile', subject: '1001' })
    appendMemory(dir, 'group:1', { ts: 3, text: 'B 的偏好', kind: 'profile', subject: '1002' })
    expect(forgetProfiles(dir, 'group:1', '1001')).toBe(1)
    expect(readAllMemories(dir, 'group:1').map((e) => e.text)).toEqual(['群规', 'B 的偏好'])
  })

  it('不传 subject 时删掉全部画像，note 保留', () => {
    const dir = makeDir()
    appendMemory(dir, 'group:1', { ts: 1, text: '群规' })
    appendMemory(dir, 'group:1', { ts: 2, text: 'A', kind: 'profile', subject: '1001' })
    appendMemory(dir, 'group:1', { ts: 3, text: 'B', kind: 'profile', subject: '1002' })
    expect(forgetProfiles(dir, 'group:1')).toBe(2)
    expect(readAllMemories(dir, 'group:1').map((e) => e.text)).toEqual(['群规'])
  })

  it('没有画像时返回 0 且不重写文件', () => {
    const dir = makeDir()
    appendMemory(dir, 'group:1', { ts: 1, text: '群规' })
    expect(forgetProfiles(dir, 'group:1', '1001')).toBe(0)
  })
})

describe('memory: 从会话事件取本轮发言者', () => {
  const userEvent = (text: string) => ({ type: 'user/message', data: { content: [{ type: 'text', text }] } })

  it('从 <user_message qq="…"> 取 QQ 号', () => {
    const events = [
      userEvent('[11:30 昵称(10001)][@我] <user_message qq="10001" nickname="昵称">\n@10002 🐛\n</user_message>'),
    ]
    expect(speakerFromUserEvents(events)).toBe('10001')
  })

  it('取最后一个 user/message，而不是更早的', () => {
    const events = [
      userEvent('<user_message qq="1001" nickname="A">old</user_message>'),
      { type: 'assistant/message', data: {} },
      userEvent('<user_message qq="2002" nickname="B">new</user_message>'),
    ]
    expect(speakerFromUserEvents(events)).toBe('2002')
  })

  it('引用展开的嵌套标签不会顶掉本体（取第一个）', () => {
    const text = '<user_message qq="2002" nickname="B">看这条\n<user_message qq="1001" nickname="A">原文</user_message>\n</user_message>'
    expect(speakerFromUserEvents([userEvent(text)])).toBe('2002')
  })

  it('最后一条 user/message 没有 qq 属性时返回 undefined（不往前翻历史）', () => {
    const events = [
      userEvent('<user_message qq="1001" nickname="A">上一轮</user_message>'),
      userEvent('来自宿主 Web 的输入，没有 qq 属性'),
    ]
    expect(speakerFromUserEvents(events)).toBeUndefined()
  })

  it('content 是字符串时也能解析', () => {
    const events = [{ type: 'user/message', data: { content: '<user_message qq="3003" nickname="C">hi</user_message>' } }]
    expect(speakerFromUserEvents(events)).toBe('3003')
  })

  it('空事件、坏事件、无 user/message 时返回 undefined', () => {
    expect(speakerFromUserEvents([])).toBeUndefined()
    expect(speakerFromUserEvents([null, 42, { type: 'assistant/message' }])).toBeUndefined()
    expect(speakerFromUserEvents([{ type: 'user/message', data: { content: [{ type: 'image' }] } }])).toBeUndefined()
  })
})

describe('memory: 会话文件枚举与面板编辑', () => {
  it('chatIdFromFileName 是 memoryFileName 的逆', () => {
    expect(chatIdFromFileName('private_10001.jsonl')).toBe('private:10001')
    expect(chatIdFromFileName('group_20002.jsonl')).toBe('group:20002')
    expect(chatIdFromFileName('notes.txt')).toBeUndefined()
    expect(chatIdFromFileName('random.jsonl')).toBeUndefined()
  })

  it('listMemoryFiles 只列记忆文件（忽略其他文件）且带字节数', () => {
    const dir = makeDir()
    appendMemory(dir, 'private:10001', { ts: 1, text: 'A' })
    appendMemory(dir, 'group:20002', { ts: 2, text: 'B' })
    writeFileSync(join(dir, 'notes.txt'), 'noise')
    const files = listMemoryFiles(dir)
    expect(files.map((file) => file.chatId).sort()).toEqual(['group:20002', 'private:10001'])
    expect(files.every((file) => file.bytes > 0)).toBe(true)
  })

  it('listMemoryFiles 目录不存在时返回空数组', () => {
    expect(listMemoryFiles(join(makeDir(), 'missing'))).toEqual([])
  })

  it('updateMemory 按 ts 改正文与标签', () => {
    const dir = makeDir()
    appendMemory(dir, 'private:10001', { ts: 100, text: '旧内容' })
    expect(updateMemory(dir, 'private:10001', 100, { text: '新内容', tags: ['偏好'] })).toBe(true)
    const entries = readAllMemories(dir, 'private:10001')
    expect(entries).toHaveLength(1)
    expect(entries[0].text).toBe('新内容')
    expect(entries[0].tags).toEqual(['偏好'])
  })

  it('updateMemory 传空标签数组会移除 tags', () => {
    const dir = makeDir()
    appendMemory(dir, 'private:10001', { ts: 100, text: '旧', tags: ['a'] })
    expect(updateMemory(dir, 'private:10001', 100, { tags: [] })).toBe(true)
    expect(readAllMemories(dir, 'private:10001')[0].tags).toBeUndefined()
  })

  it('updateMemory 未命中时返回 false 且不改文件', () => {
    const dir = makeDir()
    appendMemory(dir, 'private:10001', { ts: 100, text: '旧' })
    expect(updateMemory(dir, 'private:10001', 999, { text: '新' })).toBe(false)
    expect(readAllMemories(dir, 'private:10001')[0].text).toBe('旧')
  })

  it('deleteMemory 只删命中的那条', () => {
    const dir = makeDir()
    appendMemory(dir, 'private:10001', { ts: 100, text: 'A' })
    appendMemory(dir, 'private:10001', { ts: 200, text: 'B' })
    expect(deleteMemory(dir, 'private:10001', 100)).toBe(true)
    expect(readAllMemories(dir, 'private:10001').map((entry) => entry.text)).toEqual(['B'])
  })

  it('deleteMemory 未命中时返回 false', () => {
    const dir = makeDir()
    appendMemory(dir, 'private:10001', { ts: 100, text: 'A' })
    expect(deleteMemory(dir, 'private:10001', 999)).toBe(false)
    expect(readAllMemories(dir, 'private:10001')).toHaveLength(1)
  })
})

describe('memory: upsert（同一条目折叠为「最近提及」）', () => {
  it('首次写入不折叠，lastSeenAt 等于 ts', () => {
    const dir = makeDir()
    const result = upsertMemory(dir, 'private:10001', { ts: 100, text: '喜欢螺蛳粉' })
    expect(result.refreshed).toBe(false)
    const entries = readAllMemories(dir, 'private:10001')
    expect(entries).toHaveLength(1)
    expect(entries[0].lastSeenAt).toBe(100)
  })

  it('完全相同的条目只刷新 lastSeenAt，不新增行', () => {
    const dir = makeDir()
    upsertMemory(dir, 'private:10001', { ts: 100, text: '喜欢螺蛳粉' })
    const again = upsertMemory(dir, 'private:10001', { ts: 200, text: '喜欢螺蛳粉' })
    expect(again.refreshed).toBe(true)
    const entries = readAllMemories(dir, 'private:10001')
    expect(entries).toHaveLength(1)
    expect(entries[0].ts).toBe(100)          // 首次写入时间不变
    expect(entries[0].lastSeenAt).toBe(200)  // 最近提及被刷新
  })

  it('正文相同但 kind 不同 → 视为两条', () => {
    const dir = makeDir()
    upsertMemory(dir, 'group:1', { ts: 100, text: '喜欢螺蛳粉' })
    const profile = upsertMemory(dir, 'group:1', { ts: 200, text: '喜欢螺蛳粉', kind: 'profile', subject: '10001' })
    expect(profile.refreshed).toBe(false)
    expect(readAllMemories(dir, 'group:1')).toHaveLength(2)
  })

  it('正文相同但 subject 不同 → 视为两条（不同人的画像）', () => {
    const dir = makeDir()
    upsertMemory(dir, 'group:1', { ts: 100, text: '话少', kind: 'profile', subject: '10001' })
    const other = upsertMemory(dir, 'group:1', { ts: 200, text: '话少', kind: 'profile', subject: '10002' })
    expect(other.refreshed).toBe(false)
    expect(readAllMemories(dir, 'group:1')).toHaveLength(2)
  })

  it('同 subject 的画像再次提及 → 折叠并刷新', () => {
    const dir = makeDir()
    upsertMemory(dir, 'group:1', { ts: 100, text: '话少', kind: 'profile', subject: '10001' })
    const again = upsertMemory(dir, 'group:1', { ts: 300, text: '话少', kind: 'profile', subject: '10001' })
    expect(again.refreshed).toBe(true)
    const entries = readAllMemories(dir, 'group:1')
    expect(entries).toHaveLength(1)
    expect(entries[0].lastSeenAt).toBe(300)
  })

  it('不丢其他字段（tags / by / role 原样保留）', () => {
    const dir = makeDir()
    upsertMemory(dir, 'private:10001', { ts: 100, text: '要交周报', tags: ['待办'], by: '10001', role: 'admin' })
    upsertMemory(dir, 'private:10001', { ts: 200, text: '要交周报', tags: ['待办'] })
    const [entry] = readAllMemories(dir, 'private:10001')
    expect(entry.tags).toEqual(['待办'])
    expect(entry.by).toBe('10001')
    expect(entry.role).toBe('admin')
  })
})

describe('memory: 向量字段与余弦', () => {
  it('cosineSimilarity：同向 1、正交 0、负相关压到 0、维度不符 0、零向量 0', () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBe(1)
    expect(cosineSimilarity([1, 0], [0, 1])).toBe(0)
    expect(cosineSimilarity([1, 0], [-1, 0])).toBe(0)
    expect(cosineSimilarity([1, 0], [1, 0, 0])).toBe(0)
    expect(cosineSimilarity([], [])).toBe(0)
    expect(cosineSimilarity([0, 0], [1, 0])).toBe(0)
  })

  it('读取时保留 emb 并按长度补出 dim', () => {
    const dir = makeDir()
    appendMemory(dir, 'private:10001', { ts: 1, text: '带向量', emb: [0.1, 0.2, 0.3] })
    const [entry] = readAllMemories(dir, 'private:10001')
    expect(entry.emb).toEqual([0.1, 0.2, 0.3])
    expect(entry.dim).toBe(3)
  })

  it('向量里混入非数字 → 整条当未编码（半个向量比没有更糟）', () => {
    const dir = makeDir()
    writeFileSync(
      memoryFilePath(dir, 'private:10001'),
      JSON.stringify({ ts: 1, text: '坏向量', emb: [1, 'x', 3] }) + '\n',
      'utf8',
    )
    const [entry] = readAllMemories(dir, 'private:10001')
    expect(entry.text).toBe('坏向量')
    expect(entry.emb).toBeUndefined()
    expect(entry.dim).toBeUndefined()
  })

  it('空数组向量不算编码', () => {
    const dir = makeDir()
    writeFileSync(memoryFilePath(dir, 'private:10001'), JSON.stringify({ ts: 1, text: 'x', emb: [] }) + '\n', 'utf8')
    expect(readAllMemories(dir, 'private:10001')[0].emb).toBeUndefined()
  })
})

describe('memory: 编辑后向量失效（旧向量指向旧语义）', () => {
  it('改正文会删掉 emb 与 dim', () => {
    const dir = makeDir()
    appendMemory(dir, 'private:10001', { ts: 100, text: '旧内容', emb: [1, 2], dim: 2 })
    expect(updateMemory(dir, 'private:10001', 100, { text: '新内容' })).toBe(true)
    const [entry] = readAllMemories(dir, 'private:10001')
    expect(entry.text).toBe('新内容')
    expect(entry.emb).toBeUndefined()
    expect(entry.dim).toBeUndefined()
  })

  it('只改 tags 不失效（标签不进 embedding）', () => {
    const dir = makeDir()
    appendMemory(dir, 'private:10001', { ts: 100, text: '内容', emb: [1, 2], dim: 2 })
    expect(updateMemory(dir, 'private:10001', 100, { tags: ['偏好'] })).toBe(true)
    const [entry] = readAllMemories(dir, 'private:10001')
    expect(entry.emb).toEqual([1, 2])
    expect(entry.tags).toEqual(['偏好'])
  })

  it('正文传同值（未变）不失效', () => {
    const dir = makeDir()
    appendMemory(dir, 'private:10001', { ts: 100, text: '内容', emb: [1, 2], dim: 2 })
    expect(updateMemory(dir, 'private:10001', 100, { text: '内容' })).toBe(true)
    expect(readAllMemories(dir, 'private:10001')[0].emb).toEqual([1, 2])
  })
})

describe('memory: 混合召回（关键词 + 语义）', () => {
  const entries = [
    { ts: 1, text: '螺蛳粉很好吃', emb: [1, 0] },
    { ts: 2, text: '今天天气不错', emb: [0, 1] },
    { ts: 3, text: '螺蛳粉要加辣' },
  ]

  it('无 queryVector 时与纯关键词结果完全一致', () => {
    const pure = searchMemories(entries, '螺蛳粉').map((hit) => hit.entry.ts)
    const hybrid = searchMemoriesHybrid(entries, '螺蛳粉').map((hit) => hit.entry.ts)
    expect(hybrid).toEqual(pure)
  })

  it('关键词完全不命中但语义相近 → 仍被召回（语义路存在的意义）', () => {
    const hits = searchMemoriesHybrid(entries, '辣的粉丝', { queryVector: [1, 0] })
    expect(hits[0].entry.text).toBe('螺蛳粉很好吃')
  })

  it('维度不符的条目跳过语义路，但仍按关键词参与', () => {
    const mixed = [
      { ts: 1, text: '方案 A', emb: [1, 0, 0] }, // 3 维，查询 2 维
      { ts: 2, text: '方案 B', emb: [1, 0] },
    ]
    const hits = searchMemoriesHybrid(mixed, '方案', { queryVector: [1, 0] })
    expect(hits.map((hit) => hit.entry.ts)).toEqual([2, 1]) // B 有语义加权，A 只有关键词
  })

  it('weight=0 等价纯关键词；weight=1 等价纯语义', () => {
    const pureKeyword = searchMemoriesHybrid(entries, '螺蛳粉', { queryVector: [0, 1], weight: 0 })
    expect(pureKeyword[0].entry.ts).toBe(3) // 关键词最强的是「螺蛳粉很好吃」和「螺蛳粉要加辣」，同分取更新的
    const pureSemantic = searchMemoriesHybrid(entries, '螺蛳粉', { queryVector: [0, 1], weight: 1 })
    expect(pureSemantic[0].entry.ts).toBe(2) // 语义最接近 [0,1] 的是「今天天气不错」
  })

  it('权重越界被夹到 0~1（不抛错）', () => {
    expect(() => searchMemoriesHybrid(entries, '螺蛳粉', { queryVector: [1, 0], weight: 9 })).not.toThrow()
    expect(() => searchMemoriesHybrid(entries, '螺蛳粉', { queryVector: [1, 0], weight: Number.NaN })).not.toThrow()
  })

  it('关键词与语义都不命中时返回空数组', () => {
    // 查询向量取负向：与所有条目余弦都被压到 0（负相关不当作「半个命中」），
    // 而关键词也匹配不到任何 2-gram → 两条路都是 0 分，正确结果就是空。
    expect(searchMemoriesHybrid(entries, '完全无关的词', { queryVector: [-1, -1] })).toEqual([])
  })

  it('keywordScore 与 searchMemories 同口径（抽函数不改变结果）', () => {
    const tokens = tokenize('螺蛳粉')
    const score = keywordScore(entries[0], tokens)
    const hit = searchMemories(entries, '螺蛳粉').find((item) => item.entry.ts === 1)
    expect(hit?.score).toBe(score)
  })
})

describe('memory: 装配守卫（漏传 = 工具完全不注册）', () => {
  const indexSource = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')

  it('index.ts 把记忆开关与上限传给 bridge config', () => {
    // 2026-10-30 实测事故：这四个字段曾在 index.ts 的 config 对象里**整段漏传**。
    // bridge 按 `memoryEnabled === true` 判断是否注册 `qq_memory_*`，漏传即恒为
    // undefined → 三个工具从未注册 → 表现为「模型口头答应记住，设置页永远空白」，
    // 且服务端日志没有任何异常（工具不存在不会报错，模型只是不用它）。
    for (const key of ['memoryEnabled', 'memoryMaxEntriesPerChat', 'memoryRecallTopK', 'memoryProfileScope']) {
      expect(indexSource).toContain(key + ': config.' + key)
    }
  })

  it('语义编码器与权重也接上了', () => {
    expect(indexSource).toContain('memoryEmbedder: createEmbedder(')
    expect(indexSource).toContain('memorySemanticWeight: config.memorySemanticWeight')
  })

  it('local 模式的模型目录解析不会把模型名拼成路径（http 模式原样）', () => {
    // resolveEmbeddingModel 是纯函数但未导出；这里用行为断言它的存在与分支注释，
    // 避免「http 模式也被拼成 <mediaDir>/models/xxx」这类静默错误。
    expect(indexSource).toContain('if (mode !== \'local\'')
    expect(indexSource).toContain('join(mediaDir, \'models\'')
  })
})

describe('memory: 按谓词批量删除（qq_memory_forget 的底层）', () => {
  it('只删命中项，返回被删的条目内容', () => {
    const dir = makeDir()
    appendMemory(dir, 'private:10001', { ts: 100, text: '周五要交周报' })
    appendMemory(dir, 'private:10001', { ts: 200, text: '周报已经交了' })
    const removed = deleteMemoriesWhere(dir, 'private:10001', (entry) => entry.ts === 100)
    expect(removed.map((entry) => entry.text)).toEqual(['周五要交周报'])
    expect(readAllMemories(dir, 'private:10001').map((entry) => entry.text)).toEqual(['周报已经交了'])
  })

  it('无命中时返回空数组且不重写文件', () => {
    const dir = makeDir()
    appendMemory(dir, 'private:10001', { ts: 100, text: 'A' })
    expect(deleteMemoriesWhere(dir, 'private:10001', () => false)).toEqual([])
    expect(readAllMemories(dir, 'private:10001')).toHaveLength(1)
  })

  it('可一次删多条（按 by 过滤＝只删某人写的）', () => {
    const dir = makeDir()
    appendMemory(dir, 'group:1', { ts: 1, text: 'x', by: '10001' })
    appendMemory(dir, 'group:1', { ts: 2, text: 'y', by: '10001' })
    appendMemory(dir, 'group:1', { ts: 3, text: 'z', by: '20002' })
    const removed = deleteMemoriesWhere(dir, 'group:1', (entry) => entry.by === '10001')
    expect(removed).toHaveLength(2)
    expect(readAllMemories(dir, 'group:1').map((entry) => entry.text)).toEqual(['z'])
  })

  it('删空时文件保留为空（不删文件）', () => {
    const dir = makeDir()
    appendMemory(dir, 'private:10001', { ts: 100, text: 'A' })
    expect(deleteMemoriesWhere(dir, 'private:10001', () => true)).toHaveLength(1)
    expect(readAllMemories(dir, 'private:10001')).toEqual([])
  })
})
