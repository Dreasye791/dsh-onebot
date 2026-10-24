/**
 * The t2i card renderer entry (port of MarkdownRenderer + render_text_image).
 * Two passes: element heights are computed first, then elements render onto
 * the card; the top bar ("To 昵称") and the footer ("Powered by <brand>")
 * frame the content.
 * @module dsh-onebot/t2i/index
 */

import { CardCanvas, COLORS } from './canvas.js'
import { FontManager } from './fonts.js'
import { FontWidthSource, elementHeight, renderElement, renderInlineParts } from './elements.js'
import type { LayoutCtx } from './elements.js'
import { literalNToNewlines, parseBlocks } from './parser.js'

/** Card geometry (fixed by the original renderer). */
export const CARD_WIDTH = 800
export const BODY_FONT_SIZE = 26
/**
 * R-05：卡片高度上限。高度随正文长度线性增长且原本无上限——一段超长回复会生成
 * 十几万像素高的 PNG（同步编码占满主线程，且远超 QQ 图片尺寸限制）。超过上限直接
 * 抛错，由调用方降级为纯文本（出站与 interim 小结都已按「t2i 失败 → 纯文本」处理）。
 */
export const MAX_CARD_HEIGHT = 12_000
const TOPBAR_H = 82
const FOOTER_H = 40

/** Render options. */
export interface RenderOptions {
  /** Top bar title (e.g. "To 昵称"); absent → no top bar. */
  title?: string
  /** Footer brand (default "dsh"). */
  footerBrand?: string
  /** Font files to register (Linux deployments). */
  fontFiles?: readonly string[]
  /** Preferred font family names. */
  fontFamilies?: readonly string[]
}

/** Draw the footer: grey "Powered by " + brand in klein blue, centered. */
function drawFooter(card: CardCanvas, brand: string, y: number): void {
  const family = card.font.familyFor('cjk')
  if (family === undefined) return
  const size = 20
  const prefix = 'Powered by '
  const pbW = card.runWidth(prefix, family, size)
  const brandW = card.runWidth(brand, family, size)
  const start = (CARD_WIDTH - pbW - brandW) / 2
  card.drawRun(prefix, start, y, family, size, COLORS.footerGrey)
  card.drawRun(brand, start + pbW, y, family, size, COLORS.footerBrand)
}

/** One cached FontManager per font configuration signature. */
let cachedManager: { key: string; manager: FontManager } | undefined

/** Resolve (and cache) the font manager for the given font options. */
function fontManagerFor(options: RenderOptions): FontManager {
  const key = JSON.stringify([options.fontFiles ?? [], options.fontFamilies ?? []])
  if (cachedManager !== undefined && cachedManager.key === key) return cachedManager.manager
  const manager = FontManager.create({ fontFiles: options.fontFiles, fontFamilies: options.fontFamilies })
  cachedManager = { key, manager }
  return manager
}

/**
 * Render markdown text as a styled PNG card (synchronous; the original was
 * also synchronous PIL work). Throws when no usable CJK font family exists.
 * @param text - markdown text (literal \\n sequences are converted).
 * @param options - title/footer/fonts.
 * @returns PNG bytes.
 */
export function renderTextImage(text: string, options: RenderOptions = {}): Buffer {
  const font = fontManagerFor(options)
  if (!font.usable) {
    throw new Error('t2i: no usable CJK font family (set t2i fontFiles/fontFamilies)')
  }
  const normalized = literalNToNewlines(text ?? '')
  const blocks = parseBlocks(normalized)
  const ctx: LayoutCtx = {
    width: CARD_WIDTH,
    size: BODY_FONT_SIZE,
    widthSource: new FontWidthSource(font),
  }

  let total = 20 + (options.title !== undefined && options.title !== '' ? TOPBAR_H : 0)
  for (const el of blocks) total += elementHeight(el, ctx)
  total += 20 + FOOTER_H
  const height = Math.max(100, total)
  if (height > MAX_CARD_HEIGHT) {
    throw new Error('t2i: card too tall (' + height + 'px > ' + MAX_CARD_HEIGHT + 'px); fall back to plain text')
  }

  const card = new CardCanvas(CARD_WIDTH, height, font)
  let y = 10
  if (options.title !== undefined && options.title !== '') {
    card.fillRoundRect(10, 10, CARD_WIDTH - 20, 72, 8, COLORS.topbar)
    const family = card.font.familyFor('cjk')
    if (family !== undefined) {
      // Vertical centering on the font's metric box (PIL anchor="lm").
      const center = 10 + 36
      const ascent = card.font.ascent(family, 52)
      const descent = card.font.descent(family, 52)
      card.drawBodyRuns(options.title, 24, center - (ascent + descent) / 2, 52, COLORS.white)
    }
    y = 10 + TOPBAR_H
  }
  for (const el of blocks) {
    y = renderElement(el, card, ctx, 10, y)
  }
  drawFooter(card, options.footerBrand ?? 'dsh', total - FOOTER_H)
  return card.toPng()
}

export { FontManager, CardCanvas }
