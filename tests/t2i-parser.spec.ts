import { describe, expect, it } from 'vitest'
import { literalNToNewlines, parseBlocks, parseInline, parseTableRow } from '../src/t2i/parser.js'

describe('parseInline', () => {
  it('parses bold, italic, strike and code', () => {
    const parts = parseInline('a **b** c ~~f~~ g `h` i')
    const kinds = parts.map(p => p.cls)
    expect(kinds).toContain('bold')
    expect(kinds).toContain('strike')
    expect(kinds).toContain('code')
    expect(parts.find(p => p.cls === 'bold')?.content).toBe('b')
    expect(parts.find(p => p.cls === 'code')?.content).toBe('h')
    // 曾经：与 bold 相邻的 *italic* 会被吃掉 —— 旧正则 `\*(?!\*)([\s\S]*?)\*`
    // 让 `**a**` 的尾星号与 `*b*` 的首星号先配成一对，真正的斜体标记被当成已消费，
    // 结果星号原样留在正文里。现已用 `(?<![*])` / `(?!\*)` / `[^*\n]` 收紧。
    const clean = parseInline('plain *italic* here')
    expect(clean.find(p => p.cls === 'italic')?.content).toBe('italic')
    const adjacent = parseInline('**加粗** 与 *斜体*')
    expect(adjacent.map(p => p.cls)).toEqual(['bold', null, 'italic'])
    expect(adjacent.every(p => !p.content.includes('*'))).toBe(true)
  })

  it('maps __x__ to bold (per the Python code, not the doc)', () => {
    const parts = parseInline('a __b__ c')
    const bold = parts.find(p => p.cls === 'bold')
    expect(bold?.content).toBe('b')
  })

  it('does not italicize underscored identifiers', () => {
    const parts = parseInline('call get_group_member_list now')
    expect(parts.every(p => p.cls === null)).toBe(true)
  })

  it('keeps the outermost marker for overlaps', () => {
    const parts = parseInline('**bold *inner* text**')
    expect(parts.filter(p => p.cls !== null)).toHaveLength(1)
    expect(parts[0].cls).toBe('bold')
    expect(parts[0].content).toBe('bold *inner* text')
  })

  it('preserves gaps as plain text', () => {
    const parts = parseInline('x`code`y')
    expect(parts[0]).toEqual({ cls: null, content: 'x' })
    expect(parts[1]).toEqual({ cls: 'code', content: 'code' })
    expect(parts[2]).toEqual({ cls: null, content: 'y' })
  })
})

describe('parseBlocks', () => {
  it('parses headers with levels', () => {
    const blocks = parseBlocks('## 二级')
    expect(blocks[0]).toMatchObject({ kind: 'header', level: 2, content: '二级' })
  })

  it('parses quotes, lists and ordered lists', () => {
    const blocks = parseBlocks('> 引用\n- 项一\n3. 项三')
    expect(blocks[0]).toMatchObject({ kind: 'quote', content: '引用' })
    expect(blocks[1]).toMatchObject({ kind: 'list', content: '项一' })
    expect(blocks[2]).toMatchObject({ kind: 'ordered', number: 3, content: '项三' })
  })

  it('连续列表行合并成一个块（逐项成块会让每项多带 16px 块间距，列表看起来松散）', () => {
    const blocks = parseBlocks('- a\n- b\n- c\n\n1. x\n2. y')
    expect(blocks[0]).toMatchObject({ kind: 'list', content: 'a\nb\nc' })
    // 空行会生成一个空 text 块（既有行为，本次未改）
    expect(blocks[1]).toMatchObject({ kind: 'text', content: '' })
    expect(blocks[2]).toMatchObject({ kind: 'ordered', number: 1, content: 'x\ny' })
    // 3 个无序项合并成 1 块、2 个有序项合并成 1 块（不是 5 块）
    expect(blocks).toHaveLength(3)
  })

  it('有序列表以首项序号为基、逐项递增（10. / 11. 不会被重置成 1. / 2.）', () => {
    const blocks = parseBlocks('10. a\n11. b')
    expect(blocks[0]).toMatchObject({ kind: 'ordered', number: 10, content: 'a\nb' })
  })

  it('parses code fences', () => {
    const blocks = parseBlocks('```ts\nconst x = 1\n```')
    expect(blocks[0].kind).toBe('code')
    expect((blocks[0] as { content: string }).content).toBe('const x = 1')
  })

  it('parses tables with separator detection', () => {
    const blocks = parseBlocks('| a | b |\n|---|---|\n| 1 | 2 |')
    const table = blocks[0] as { kind: 'table'; header: string[]; rows: string[][] }
    expect(table.kind).toBe('table')
    expect(table.header).toEqual(['a', 'b'])
    expect(table.rows).toEqual([['1', '2']])
  })

  it('keeps a lone pipe line as text', () => {
    const blocks = parseBlocks('not | a table')
    expect(blocks[0].kind).toBe('text')
  })
})

describe('parseTableRow', () => {
  it('strips edge pipes and trims cells', () => {
    expect(parseTableRow('|  a  | b |')).toEqual(['a', 'b'])
    expect(parseTableRow('a | b')).toEqual(['a', 'b'])
  })
})

describe('literalNToNewlines', () => {
  it('converts literal backslash-n to real newlines', () => {
    expect(literalNToNewlines('a\\nb')).toBe('a\nb')
  })

  it('protects inline code segments', () => {
    const out = literalNToNewlines('`x\\ny` and a\\nb')
    expect(out).toContain('a\nb')
    expect(out.split('\n').length).toBe(2)
  })

  it('preserves double backslash before n', () => {
    expect(literalNToNewlines('a\\\\nb')).toBe('a\\\\nb')
  })
})
