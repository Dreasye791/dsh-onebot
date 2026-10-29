/**
 * Markdown parsing for the t2i card renderer (port of t2i_render.py's
 * parse_inline / MarkdownParser / _literal_n_to_newlines). Links and images
 * are intentionally left as literal text (original limitation, §6).
 * @module dsh-onebot/t2i/parser
 */

import type { InlinePart } from './measure.js'

/**
 * Convert literal "\\n" sequences in LLM output to real newlines.
 * Inline-code segments are protected first (their literal \\n becomes a
 * space, since a capsule cannot contain line breaks); a double backslash
 * before n ("\\\\n") is preserved untouched.
 * @param text - model-produced text.
 * @returns text with literal newlines converted.
 */
export function literalNToNewlines(text: string): string {
  const held: string[] = []
  const protect = (segment: string): string => {
    const fixed = segment.replace(/(?<!\\)\\n/g, ' ')
    held.push(fixed)
    return '\x00CODE' + (held.length - 1) + '\x00'
  }
  const protectedText = text.replace(/\x60[^\x60\n]*\x60/g, protect)
  const converted = protectedText.replace(/(?<!\\)\\n/g, '\n')
  return converted.replace(/\x00CODE(\d+)\x00/g, (_, index: string) => held[Number(index)] ?? '')
}

/**
 * Inline style patterns.
 *
 * `*` 类的两侧都加了 `(?<![*])` / `(?!\*)` 边界：旧写法 `\*(?!\*)([\s\S]*?)\*`
 * 会跨段配对 —— 在 `**加粗** 和 *斜体*` 里，`**加粗**` 的**尾星号**与 `*斜体*` 的
 * **首星号**会先被配成一对（匹配到 `* 和 *`），真正的斜体标记被当成已消费而丢弃，
 * 结果星号原样显示。`[^*\n]` 进一步保证标记内部不会再吃到别的星号。
 *
 * 代价：`***三重***` 这种三层嵌套不再被识别（旧实现会错误解析成 `<bold:*三重>`），
 * 现在按字面显示 —— 宁可不出样式，也不要出错的样式。
 */
const INLINE_PATTERNS: Array<{ pattern: RegExp; cls: InlinePart['cls'] }> = [
  { pattern: /(?<![*])\*\*(?!\*)([\s\S]*?)\*\*(?!\*)/g, cls: 'bold' },
  { pattern: /(?<![*])\*(?!\*)([^*\n]+?)\*(?!\*)/g, cls: 'italic' },
  { pattern: /(?<![A-Za-z0-9])__([\s\S]*?)__(?![A-Za-z0-9])/g, cls: 'bold' },
  { pattern: /(?<![A-Za-z0-9])_(?!_)([\s\S]*?)_(?![A-Za-z0-9])/g, cls: 'italic' },
  { pattern: /~~([\s\S]*?)~~/g, cls: 'strike' },
  { pattern: /\x60([^\x60\n]*)\x60/g, cls: 'code' },
]

interface InlineMarker {
  start: number
  end: number
  text: string
  cls: InlinePart['cls']
}

/**
 * Parse inline styles in one line into a part sequence. Overlapping markers
 * keep the outermost match (the original filters by non-overlapping order).
 * @param line - one line of text.
 * @returns inline parts.
 */
export function parseInline(line: string): InlinePart[] {
  const markers: InlineMarker[] = []
  for (const { pattern, cls } of INLINE_PATTERNS) {
    pattern.lastIndex = 0
    for (const match of line.matchAll(pattern)) {
      const start = match.index ?? 0
      markers.push({ start, end: start + match[0].length, text: match[1], cls })
    }
  }
  if (markers.length === 0) return [{ cls: null, content: line }]
  markers.sort((a, b) => a.start - b.start || a.end - b.end)
  const filtered: InlineMarker[] = []
  let lastEnd = 0
  for (const marker of markers) {
    if (marker.start >= lastEnd) {
      filtered.push(marker)
      lastEnd = marker.end
    }
  }
  const out: InlinePart[] = []
  let cursor = 0
  for (const marker of filtered) {
    if (marker.start > cursor) {
      const gap = line.slice(cursor, marker.start)
      if (gap !== '') out.push({ cls: null, content: gap })
    }
    out.push({ cls: marker.cls, content: marker.text })
    cursor = marker.end
  }
  if (cursor < line.length) out.push({ cls: null, content: line.slice(cursor) })
  return out
}

/** Table separator detection. */
const TABLE_SEP_RE = /^\s*\|?[\s:|-]+\|?\s*$/

function isTableSeparator(line: string): boolean {
  if (!line.includes('|') || !line.includes('-')) return false
  return TABLE_SEP_RE.test(line)
}

/** Parse one table row into cells. */
export function parseTableRow(line: string): string[] {
  let s = line.trim()
  if (s.startsWith('|')) s = s.slice(1)
  if (s.endsWith('|')) s = s.slice(0, -1)
  return s.split('|').map(cell => cell.trim())
}

/** Block element types produced by the parser. */
export type BlockElement =
  | { kind: 'text'; content: string }
  | { kind: 'header'; content: string; level: number }
  | { kind: 'quote'; content: string }
  | { kind: 'list'; content: string }
  | { kind: 'ordered'; content: string; number: number }
  | { kind: 'code'; content: string }
  | { kind: 'table'; header: string[]; rows: string[][] }

/**
 * Parse markdown text into block elements (port of MarkdownParser.parse).
 * @param text - the markdown text.
 * @returns block elements.
 */
export function parseBlocks(text: string): BlockElement[] {
  const elements: BlockElement[] = []
  const lines = text.split('\n')
  let i = 0
  let orderedCounter = 0
  while (i < lines.length) {
    const line = lines[i].replace(/\s+$/, '')

    // Table: current line has | and the next is a separator row.
    if (line.includes('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      const header = parseTableRow(line)
      i += 2
      const rows: string[][] = []
      while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') {
        rows.push(parseTableRow(lines[i]))
        i += 1
      }
      elements.push({ kind: 'table', header, rows })
      continue
    }

    if (line.trim() === '') {
      elements.push({ kind: 'text', content: '' })
      i += 1
      continue
    }

    if (line.startsWith('#')) {
      let level = 0
      while (level < line.length && line[level] === '#') level += 1
      elements.push({ kind: 'header', content: line.slice(level).trim(), level: Math.min(level, 6) })
      i += 1
      continue
    }

    if (line.startsWith('>')) {
      elements.push({ kind: 'quote', content: line.replace(/^>+/, '').trim() })
      i += 1
      continue
    }

    if (line.startsWith('\x60\x60\x60')) {
      const codeLines: string[] = []
      i += 1
      while (i < lines.length && !lines[i].startsWith('\x60\x60\x60')) {
        codeLines.push(lines[i])
        i += 1
      }
      i += 1
      elements.push({ kind: 'code', content: codeLines.join('\n') })
      continue
    }

    // 无序列表：把**连续的** `- ` 行并成一个块（`content` 用 \n 分隔多项）。
    // 逐项成块会让每一项都带上 16px 的块间距（elementHeight 的 +16），列表看起来松散；
    // 合并后项距就等于行距，与标准 Markdown 渲染一致。
    const ulMatch = /^\s*[-*+]\s+/.exec(line)
    if (ulMatch !== null) {
      const items: string[] = []
      while (i < lines.length) {
        const current = lines[i].replace(/\s+$/, '')
        const item = /^\s*[-*+]\s+(.*)$/.exec(current)
        if (item === null) break
        items.push(item[1])
        i += 1
      }
      elements.push({ kind: 'list', content: items.join('\n') })
      continue
    }

    // 有序列表同理；序号以首项为基，逐项 +1（与主流 Markdown 一致：手写 `1. 1. 1.`
    // 会被规范化为 1. 2. 3.）。
    const olMatch = /^\s*(\d+)[.)]\s+/.exec(line)
    if (olMatch !== null) {
      orderedCounter = Number(olMatch[1])
      const items: string[] = []
      while (i < lines.length) {
        const current = lines[i].replace(/\s+$/, '')
        const item = /^\s*\d+[.)]\s+(.*)$/.exec(current)
        if (item === null) break
        items.push(item[1])
        i += 1
      }
      elements.push({ kind: 'ordered', content: items.join('\n'), number: orderedCounter })
      continue
    }

    elements.push({ kind: 'text', content: line })
    i += 1
  }
  return elements
}
