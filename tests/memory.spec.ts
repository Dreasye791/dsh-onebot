import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  appendMemory,
  memoryFileName,
  memoryFilePath,
  readMemories,
  searchMemories,
  tokenize,
  trimMemories,
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
