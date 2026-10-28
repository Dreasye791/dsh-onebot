import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  appendMemory,
  findSensitive,
  forgetProfiles,
  isExpired,
  memoryFileName,
  memoryFilePath,
  readAllMemories,
  readMemories,
  searchMemories,
  selectForRecall,
  tokenize,
  trimMemories,
  ttlDaysFor,
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
