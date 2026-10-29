/**
 * Block element layout and rendering (port of t2i_render.py's element
 * classes). Element heights are pure functions of (element, layout context);
 * rendering draws onto a CardCanvas and returns the next y.
 * @module dsh-onebot/t2i/elements
 */

import type { CardCanvas } from './canvas.js'
import { COLORS, codeFontSize } from './canvas.js'
import type { FontManager } from './fonts.js'
import { classifyChar } from './fonts.js'
import type { InlinePart, WidthSource } from './measure.js'
import { codeWidth, segWidth, splitInlineLines, splitToFit, textWidth } from './measure.js'
import { parseInline } from './parser.js'
import type { BlockElement } from './parser.js'

/** Layout context shared by height and render passes. */
export interface LayoutCtx {
  width: number
  size: number
  widthSource: WidthSource
}

/** Width source backed by the font manager (measure == draw). */
export class FontWidthSource implements WidthSource {
  constructor(private readonly font: FontManager) {}

  charWidth(ch: string, size: number, code: boolean): number {
    if (ch === '') return 0
    const cls = classifyChar(ch)
    if (cls === 'zwj') return 0
    if (cls === 'emoji') {
      const target = code ? codeFontSize(size) : size
      const width = this.font.emojiWidth(target)
      if (width > 0) return width
      const family = this.font.familyFor('cjk')
      return family !== undefined ? this.font.charWidth(ch, family, target) : target
    }
    if (code) {
      const family = this.font.codeFamilyFor(cls)
      const runSize = cls === 'ascii' ? size : codeFontSize(size)
      return family !== undefined ? this.font.charWidth(ch, family, runSize) : runSize
    }
    const family = this.font.familyFor('cjk')
    return family !== undefined ? this.font.charWidth(ch, family, size) : size
  }
}

/** Split an inline-part list into lines for an element's width budget. */
function linesFor(content: string, ctx: LayoutCtx, budget: number, size?: number): InlinePart[][] {
  const parts = parseInline(content)
  return splitInlineLines(parts, budget, ctx.widthSource, size ?? ctx.size)
}

/**
 * Render one inline part sequence at the ascender line y (the
 * render_inline_parts port).
 * @param card - the card.
 * @param x - left edge.
 * @param y - ascender line.
 * @param parts - inline parts.
 * @param size - font size.
 * @param fill - color.
 * @param ctx - layout context (width source).
 * @returns the advanced x.
 */
export function renderInlineParts(
  card: CardCanvas,
  x: number,
  y: number,
  parts: InlinePart[],
  size: number,
  fill: string,
  ctx: LayoutCtx,
): number {
  let cx = x
  for (const part of parts) {
    const cls = part.cls
    if (cls === null) {
      card.drawBodyRuns(part.content, cx, y, size, fill)
      cx += textWidth(ctx.widthSource, part.content, size)
    } else if (cls === 'bold') {
      card.drawBodyRuns(part.content, cx, y, size, fill)
      card.drawBodyRuns(part.content, cx + 1, y, size, fill, true)
      cx += textWidth(ctx.widthSource, part.content, size) + 1
    } else if (cls === 'italic') {
      // AFFINE shear (1, 0.2, 0, 1) around the segment origin.
      const w = textWidth(ctx.widthSource, part.content, size)
      card.withTransform(cx, y, () => {
        card.drawBodyRuns(part.content, 0, 0, size, fill)
      })
      cx += w + 8
    } else if (cls === 'strike') {
      card.drawBodyRuns(part.content, cx, y, size, fill)
      const w = textWidth(ctx.widthSource, part.content, size)
      card.hLine(cx, y + Math.floor(size / 2), cx + w, fill, 1)
      cx += w
    } else if (cls === 'code') {
      const w = codeWidth(ctx.widthSource, part.content, size)
      const padX = 6
      // 胶囊高度跟随字号并在行内垂直居中。
      //
      // 原来写死 padY = 5（高度 size + 11），而 list / quote 的行高只有 size + 10 ——
      // 相邻两行都有行内代码时胶囊互相挤压，视觉上就是「行距忽大忽小」。这里取
      // size + 8 并在 y 上方留 4px，任何行高（最小 size + 10）都放得下。
      const capsuleH = size + 8
      const capsuleY = y - 4
      card.fillRoundRect(cx, capsuleY, w + padX * 2, capsuleH, 5, COLORS.codeCapsuleBg)
      card.strokeRoundRect(cx, capsuleY, w + padX * 2, capsuleH, 5, COLORS.codeCapsuleOutline)
      // 代码文字与正文共用同一条 ascender line。
      //
      // 原来传的是 `y + padY + 3`（+8px），代码比同一行的汉字低半个字高 —— 截图里
      // 「CreateFileMapping … 」明显沉在汉字基线以下就是这个原因。drawCodeRuns
      // 内部已对 ASCII 做 +1 的基线微调，这里不能再额外下移。
      card.drawCodeRuns(part.content, cx + padX, y, size, COLORS.codeCapsuleText)
      cx += w + padX * 2 + 2
    }
  }
  return cx
}

// ---------------------------------------------------------------- elements

/** Height of a block element (the calculate_height port). */
export function elementHeight(el: BlockElement, ctx: LayoutCtx): number {
  switch (el.kind) {
    case 'text': {
      if (el.content.trim() === '') return 10
      return linesFor(el.content, ctx, ctx.width - 20).length * (ctx.size + 12)
    }
    case 'header': {
      const headerSize = headerFontSize(el.level)
      const lines = linesFor(el.content, ctx, ctx.width - 20, headerSize)
      return Math.max(1, lines.length) * headerSize + 30
    }
    case 'quote': {
      const lines = linesFor(el.content, ctx, ctx.width - 35)
      return lines.length * (ctx.size + 10) + 12
    }
    case 'list': {
      // content 是多项（\n 分隔）：每项单独折行，行数累加。
      let total = 0
      for (const item of el.content.split('\n')) total += linesFor(item, ctx, ctx.width - 45).length * (ctx.size + 10)
      return total + 16
    }
    case 'ordered': {
      let total = 0
      for (const item of el.content.split('\n')) total += linesFor(item, ctx, ctx.width - 55).length * (ctx.size + 10)
      return total + 16
    }
    case 'code': {
      const wrapped = wrapCodeLines(el.content, ctx)
      if (el.content.trim() === '') return 40
      return wrapped.length * (ctx.size + 4) + 40
    }
    case 'table':
      return tableLayout(el, ctx).height
  }
}

/** Header font size for a level (42 - (level-1)*4, level capped at 6). */
export function headerFontSize(level: number): number {
  return 42 - (level - 1) * 4
}

/** Wrap code-block lines at the code budget. */
function wrapCodeLines(content: string, ctx: LayoutCtx): string[] {
  const wrapped: string[] = []
  for (const line of content.split('\n')) {
    wrapped.push(...splitToFit(line, ctx.width - 40, ch => ctx.widthSource.charWidth(ch, ctx.size, true)))
  }
  return wrapped
}

/** Render a block element; returns the next y. */
export function renderElement(el: BlockElement, card: CardCanvas, ctx: LayoutCtx, x: number, y: number): number {
  switch (el.kind) {
    case 'text': {
      if (el.content.trim() === '') return y + 10
      for (const line of linesFor(el.content, ctx, ctx.width - 20)) {
        renderInlineParts(card, x, y, line, ctx.size, COLORS.ink, ctx)
        y += ctx.size + 12
      }
      return y
    }
    case 'header': {
      const headerSize = headerFontSize(el.level)
      const lines = linesFor(el.content, ctx, ctx.width - 20, headerSize)
      y += 10
      if (lines.length > 0) {
        renderInlineParts(card, x, y, lines[0], headerSize, COLORS.ink, ctx)
        y += headerSize + 12
      }
      card.hLine(x, y, ctx.width - 10, COLORS.titleLine, 3)
      return y + 10
    }
    case 'quote': {
      const lines = linesFor(el.content, ctx, ctx.width - 35)
      const total = lines.length * (ctx.size + 10)
      card.vLine(x + 3, y + 6, y + total + 6, COLORS.quote, 5)
      let ty = y + 6
      for (const line of lines) {
        renderInlineParts(card, x + 15, ty, line, ctx.size, COLORS.quote, ctx)
        ty += ctx.size + 10
      }
      return y + total + 12
    }
    case 'list': {
      y += 8
      // 项目符号用几何圆点，不画 `•` 字符：CJK 首选字体（SimHei）的 cmap 里没有
      // U+2022，Skia 命中不到字形会画 notdef 空心方框（实测 U+25CF 才靠运气命中，
      // 换字体就复发）。圆心按「首行基线 − 0.3em」定位，与 `•` 在正常字体里的
      // 视觉位置一致；半径 0.11em（14px 下约 1.5px）与常见项目符号粗细相当。
      const family = card.font.familyFor('cjk')
      const radius = Math.max(1.4, ctx.size * 0.11)
      let ty = y
      // 每一项各画一个符号（content 是 \n 分隔的多项）；项内折行仍从 x + 25 起，
      // 与首行文字左对齐。
      for (const item of el.content.split('\n')) {
        const baseline = family !== undefined ? ty + card.font.ascent(family, ctx.size) : ty + ctx.size * 0.8
        card.fillCircle(x + 8, baseline - ctx.size * 0.3, radius, COLORS.ink)
        for (const line of linesFor(item, ctx, ctx.width - 45)) {
          renderInlineParts(card, x + 25, ty, line, ctx.size, COLORS.ink, ctx)
          ty += ctx.size + 10
        }
      }
      return ty + 8
    }
    case 'ordered': {
      y += 8
      const family = card.font.familyFor('cjk')
      const items = el.content.split('\n')
      let ty = y
      for (let index = 0; index < items.length; index += 1) {
        const marker = String(el.number + index) + '.'
        if (family !== undefined) card.drawRun(marker, x + 5, ty, family, ctx.size, COLORS.ink)
        // 文字起点按序号实际宽度推进，而不是固定 x + 35：`10.` 比 `1.` 宽一个字符，
        // 固定缩进会让两位数序号贴住正文（`10.两位数序号`）。
        const textX = family !== undefined
          ? Math.max(x + 35, x + 5 + card.runWidth(marker, family, ctx.size) + 12)
          : x + 35
        for (const line of linesFor(items[index], ctx, ctx.width - 55)) {
          renderInlineParts(card, textX, ty, line, ctx.size, COLORS.ink, ctx)
          ty += ctx.size + 10
        }
      }
      return ty + 8
    }
    case 'code': {
      const wrapped = wrapCodeLines(el.content, ctx)
      const contentHeight = wrapped.length * (ctx.size + 4)
      const total = contentHeight + 30
      card.fillRoundRect(x, y + 5, ctx.width - 10 - x, total, 5, COLORS.codeBlockBg)
      let ty = y + 15
      for (const line of wrapped) {
        card.drawCodeRuns(line, x + 15, ty, ctx.size, COLORS.ink)
        ty += ctx.size + 4
      }
      return y + total + 10
    }
    case 'table': {
      const layout = tableLayout(el, ctx)
      return renderTable(el, layout, card, ctx, x, y)
    }
  }
}

// ------------------------------------------------------------------ table

const TABLE_COL_GAP = 4

interface TableLayout {
  colWidths: number[]
  /** rows × cells × lines × parts. */
  cellLines: InlinePart[][][][]
  rowHeights: number[]
  nCols: number
  height: number
}

/** Two-pass column layout (the TableElement._layout port). */
function tableLayout(el: BlockElement & { kind: 'table' }, ctx: LayoutCtx): TableLayout {
  const width = ctx.width
  const size = ctx.size
  const nCols = Math.max(el.header.length, ...el.rows.map(r => r.length), 1)
  const padX = 10
  const maxContentW = width - 30 - TABLE_COL_GAP * (nCols - 1) - padX * 2 * nCols

  const splitCells = (colWidths: number[]): InlinePart[][][][] => {
    const out: InlinePart[][][][] = []
    for (const row of [el.header, ...el.rows]) {
      const cells = [...row, ...Array(Math.max(0, nCols - row.length)).fill('')]
      const rowLines: InlinePart[][][] = []
      for (let ci = 0; ci < nCols; ci += 1) {
        const cell = cells[ci] ?? ''
        rowLines.push(splitInlineLines(parseInline(cell.trim()), Math.max(20, (colWidths[ci] ?? 0) - padX * 2), ctx.widthSource, size))
      }
      out.push(rowLines)
    }
    return out
  }

  const measureCols = (cellLines: InlinePart[][][][]): number[] => {
    const widths: number[] = []
    for (let ci = 0; ci < nCols; ci += 1) {
      let maxW = 0
      for (const rowLines of cellLines) {
        for (const line of rowLines[ci] ?? []) {
          let w = 0
          for (const part of line) w += segWidth(part, ctx.widthSource, size)
          if (w > maxW) maxW = w
        }
      }
      widths.push(Math.floor(maxW) + padX * 2)
    }
    return widths
  }

  // Pass 1: equal split, measure.
  let cellLines = splitCells(Array(nCols).fill(Math.floor(maxContentW / nCols)))
  let colWidths = measureCols(cellLines)
  // Compress proportionally when the total exceeds the card, then re-wrap.
  const total = colWidths.reduce((a, b) => a + b, 0) + TABLE_COL_GAP * (nCols - 1)
  if (total > width - 30) {
    const avail = width - 30 - TABLE_COL_GAP * (nCols - 1)
    const ratio = avail / colWidths.reduce((a, b) => a + b, 0)
    colWidths = colWidths.map(w => Math.max(30, Math.floor(w * ratio)))
    cellLines = splitCells(colWidths)
    colWidths = measureCols(cellLines)
  }
  // Stretch to fill the available card width (remainder to the last column).
  const avail = width - 30 - TABLE_COL_GAP * (nCols - 1)
  const current = colWidths.reduce((a, b) => a + b, 0)
  if (current < avail) {
    const extra = avail - current
    const per = Math.floor(extra / nCols)
    colWidths = colWidths.map(w => w + per)
    colWidths[nCols - 1] += extra - per * nCols
  }
  const rowHeights = cellLines.map(rowLines => {
    const maxLines = Math.max(...rowLines.map(l => l.length), 1)
    return maxLines * (size + 14) + 12
  })
  const height = rowHeights.reduce((a, b) => a + b, 0) + 20
  return { colWidths, cellLines, rowHeights, nCols, height }
}

/** Render the table (the TableElement.render port). */
function renderTable(
  el: BlockElement & { kind: 'table' },
  layout: TableLayout,
  card: CardCanvas,
  ctx: LayoutCtx,
  x: number,
  y: number,
): number {
  void el
  const size = ctx.size
  const tableX = x + 10
  const tableW = layout.colWidths.reduce((a, b) => a + b, 0) + TABLE_COL_GAP * (layout.nCols - 1)
  let cy = y + 10

  // Header row.
  const headerLines = layout.cellLines[0] ?? []
  const headerH = Math.max(...headerLines.map(l => l.length), 1) * (size + 14) + 12
  card.fillRect(tableX, cy, tableW, headerH, COLORS.tableHeaderBg)
  let hx = tableX
  for (let ci = 0; ci < layout.nCols; ci += 1) {
    let ty = cy + 6
    for (const line of headerLines[ci] ?? []) {
      const lineW = line.reduce((acc, part) => acc + segWidth(part, ctx.widthSource, size), 0)
      const cx = hx + (layout.colWidths[ci] - lineW) / 2
      renderInlineParts(card, cx, ty, line, size, COLORS.ink, ctx)
      ty += size + 14
    }
    hx += layout.colWidths[ci] + TABLE_COL_GAP
  }
  cy += headerH

  // Data rows with alternating shading (even rows shaded).
  for (let ri = 1; ri < layout.cellLines.length; ri += 1) {
    const rowLines = layout.cellLines[ri] ?? []
    const rowH = Math.max(...rowLines.map(l => l.length), 1) * (size + 14) + 12
    if (ri % 2 === 0) {
      card.fillRect(tableX, cy, tableW, rowH, COLORS.tableAltRowBg)
    }
    hx = tableX
    for (let ci = 0; ci < layout.nCols; ci += 1) {
      let ty = cy + 6
      for (const line of rowLines[ci] ?? []) {
        const lineW = line.reduce((acc, part) => acc + segWidth(part, ctx.widthSource, size), 0)
        const cx = hx + (layout.colWidths[ci] - lineW) / 2
        renderInlineParts(card, cx, ty, line, size, COLORS.ink, ctx)
        ty += size + 14
      }
      hx += layout.colWidths[ci] + TABLE_COL_GAP
    }
    cy += rowH
  }

  // Grid lines; the right border sits at the table's real right edge.
  hx = tableX
  for (const cw of layout.colWidths) {
    card.vLine(hx, y + 10, cy, COLORS.tableGrid, 1)
    hx += cw + TABLE_COL_GAP
  }
  card.vLine(tableX + tableW, y + 10, cy, COLORS.tableGrid, 1)
  card.hLine(tableX, cy, tableX + tableW, COLORS.tableGrid, 1)
  return cy + 10
}
