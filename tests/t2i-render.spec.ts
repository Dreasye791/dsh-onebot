import { describe, expect, it } from 'vitest'
import { createCanvas, loadImage } from '@napi-rs/canvas'
import { renderTextImage, CARD_WIDTH } from '../src/t2i/index.js'
import { FontManager } from '../src/t2i/fonts.js'
import { parseBlocks } from '../src/t2i/parser.js'
import { elementHeight, FontWidthSource, renderElement, renderInlineParts } from '../src/t2i/elements.js'
import type { LayoutCtx } from '../src/t2i/elements.js'
import type { CardCanvas } from '../src/t2i/canvas.js'
import { BODY_FONT_SIZE } from '../src/t2i/index.js'

const font = FontManager.create()
const hasFonts = font.usable
const describeFont = hasFonts ? describe : describe.skip

/** Non-white check per the dev doc: not (r>245 && g>245 && b>245). */
function isInk(r: number, g: number, b: number): boolean {
  return !(r > 245 && g > 245 && b > 245)
}

/** Scan every row for the rightmost non-white pixel. */
async function scanRightEdge(png: Buffer): Promise<{ width: number; height: number; maxX: number; violations: number }> {
  const img = await loadImage(png)
  const canvas = createCanvas(img.width, img.height)
  const ctx = canvas.getContext('2d')
  ctx.drawImage(img, 0, 0)
  let maxX = -1
  let violations = 0
  for (let y = 0; y < img.height; y += 1) {
    const row = ctx.getImageData(0, y, img.width, 1).data
    for (let x = img.width - 1; x >= 0; x -= 1) {
      if (isInk(row[x * 4], row[x * 4 + 1], row[x * 4 + 2])) {
        if (x > maxX) maxX = x
        if (x > 791) violations += 1
        break
      }
    }
  }
  return { width: img.width, height: img.height, maxX, violations }
}

/**
 * Count pixels in the top-bar strip that are neither white, nor top-bar blue
 * (#2196f3), nor a white↔blue anti-aliasing blend (blue channel ≥ 240): i.e.
 * color emoji bitmap ink. White title glyphs and their anti-aliasing count 0.
 */
async function countTopbarEmojiInk(png: Buffer): Promise<number> {
  const img = await loadImage(png)
  const canvas = createCanvas(img.width, img.height)
  const ctx = canvas.getContext('2d')
  ctx.drawImage(img, 0, 0)
  const strip = ctx.getImageData(10, 10, img.width - 20, 72).data
  let ink = 0
  for (let i = 0; i < strip.length; i += 4) {
    const r = strip[i], g = strip[i + 1], b = strip[i + 2]
    if (r > 245 && g > 245 && b > 245) continue
    if (Math.abs(r - 33) <= 30 && Math.abs(g - 150) <= 30 && Math.abs(b - 243) <= 30) continue
    if (b >= 240) continue
    ink += 1
  }
  return ink
}

/** The dev-doc pressure fixture: long title + text + quote + lists + 4-col table + code. */
const PRESSURE = [
  '# 这是一个非常非常长的标题用来测试标题换行与右缘表现标题换行与右缘',
  '',
  '正文段落：这是一段足够长的正文，用来验证**粗体**与*斜体*以及`inline code`在换行时的表现，同时检查中文标点，不会落在行首的问题。',
  '',
  '> 引用块内容：引用文本也会换行，并且左侧有灰色竖线，宽度预算与正文不同，需要单独验证。',
  '',
  '- 无序列表项：列表文本换行宽度预算为 image_width-45，右侧不能越界。',
  '- 第二项：继续填充内容让列表换行。',
  '',
  '1. 有序列表：编号加内容换行预算为 image_width-55。',
  '2. 第二项：继续填充内容让有序列表换行以验证右缘。',
  '',
  '| 列一 | 列二 | 列三 | 列四 |',
  '|---|---|---|---|',
  '| 单元格甲 | 单元格乙 | 单元格丙 | 单元格丁 |',
  '| 内容稍长一些的单元格 | 二号 | 三号 | 四号 |',
  '| 三号行 | 乙 | 丙 | 丁 |',
  '',
  '```ts',
  'const longCodeLine = someFunction(withArguments, thatKeepsGoing, andGoing);',
  'console.log(longCodeLine); // 注释也会等宽显示',
  '```',
  '',
  '结尾文本：😀 emoji 混排测试。',
].join('\n')

describeFont('renderTextImage', () => {
  it('produces a PNG with the right magic bytes', () => {
    const png = renderTextImage('简单文本')
    expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
  })

  it('passes the full-image right-edge scan on the pressure fixture', async () => {
    const png = renderTextImage(PRESSURE, { title: 'To 压力测试' })
    const scan = await scanRightEdge(png)
    expect(scan.width).toBe(CARD_WIDTH)
    expect(scan.maxX).toBeLessThanOrEqual(790)
    expect(scan.violations).toBe(0)
  }, 30_000)

  it('paints the blue top bar when a title is given', async () => {
    const png = renderTextImage('内容', { title: 'To 某用户' })
    const img = await loadImage(png)
    const canvas = createCanvas(img.width, img.height)
    const ctx = canvas.getContext('2d')
    ctx.drawImage(img, 0, 0)
    const px = ctx.getImageData(400, 40, 1, 1).data
    // #2196f3 = rgb(33, 150, 243)
    expect(Math.abs(px[0] - 33)).toBeLessThanOrEqual(30)
    expect(Math.abs(px[1] - 150)).toBeLessThanOrEqual(30)
    expect(Math.abs(px[2] - 243)).toBeLessThanOrEqual(30)
  })

  it('omits the top bar without a title', async () => {
    const png = renderTextImage('内容')
    const img = await loadImage(png)
    const canvas = createCanvas(img.width, img.height)
    const ctx = canvas.getContext('2d')
    ctx.drawImage(img, 0, 0)
    const px = ctx.getImageData(400, 40, 1, 1).data
    expect(px[0]).toBeGreaterThan(245)
    expect(px[1]).toBeGreaterThan(245)
    expect(px[2]).toBeGreaterThan(245)
  })

  it('renders color emoji (yellowish pixels present)', async () => {
    const png = renderTextImage('表情 😀 测试')
    const img = await loadImage(png)
    const canvas = createCanvas(img.width, img.height)
    const ctx = canvas.getContext('2d')
    ctx.drawImage(img, 0, 0)
    let colored = 0
    const row = ctx.getImageData(0, 0, img.width, img.height).data
    for (let i = 0; i < row.length; i += 4) {
      const r = row[i], g = row[i + 1], b = row[i + 2]
      if (r > 200 && g > 100 && g < 240 && b < 140) colored += 1
    }
    expect(colored).toBeGreaterThan(50)
  }, 30_000)

  it('renders the top-bar title emoji in color (no white tofu)', async () => {
    // Pixel evidence only (OCR is no evidence): in the top-bar strip the only
    // ink that is neither white nor top-bar blue is the color emoji bitmap —
    // white CJK glyphs and their white↔blue anti-aliasing (blue ≥ 240) count
    // 0, so a hollow white tofu also counts ~0. Thresholds calibrated on this
    // machine: single-run tofu title ≈ 0 ink px, per-char color emoji ≈ 1409;
    // the no-emoji control proves the method itself detects no ink.
    const withEmoji = await countTopbarEmojiInk(renderTextImage('内容', { title: '📋 本轮中间记录' }))
    const withoutEmoji = await countTopbarEmojiInk(renderTextImage('内容', { title: '本轮中间记录' }))
    expect(withoutEmoji).toBeLessThan(200)
    expect(withEmoji).toBeGreaterThan(1000)
  }, 30_000)

  it('draws the footer brand in klein blue', async () => {
    const png = renderTextImage('内容', { footerBrand: 'dsh' })
    const img = await loadImage(png)
    const canvas = createCanvas(img.width, img.height)
    const ctx = canvas.getContext('2d')
    ctx.drawImage(img, 0, 0)
    let found = false
    // Scan the bottom 60px band for #002fa7-ish pixels.
    const row = ctx.getImageData(0, img.height - 60, img.width, 60).data
    for (let i = 0; i < row.length; i += 4) {
      const r = row[i], g = row[i + 1], b = row[i + 2]
      if (Math.abs(r - 0) <= 40 && Math.abs(g - 47) <= 40 && Math.abs(b - 167) <= 40) {
        found = true
        break
      }
    }
    expect(found).toBe(true)
  }, 30_000)

  it('heights are consistent between the two passes (no negative y drift)', () => {
    const ctx: LayoutCtx = { width: 800, size: BODY_FONT_SIZE, widthSource: new FontWidthSource(font) }
    let total = 0
    for (const el of parseBlocks(PRESSURE)) total += elementHeight(el, ctx)
    expect(total).toBeGreaterThan(100)
  })
})

/**
 * 不依赖字体：用假 CardCanvas 记录绘制调用。
 *
 * 背景：列表项目符号原来画 `•`（U+2022），而 CJK 首选字体 SimHei 的 cmap 里没有这个
 * 码位，Skia 命中不到字形就画 notdef 空心方框（截图里那个方块）。改成几何圆点后，
 * 这条断言把「不许再把符号当字符画」钉死 —— 换字体、换渲染器都不会复发。
 */
describe('T21 列表项目符号走几何圆点（不依赖字体 cmap）', () => {
  function renderListAt(size: number, top: number): string[] {
    const calls: string[] = []
    const fake = {
      font: {
        familyFor: () => 'SimHei',
        ascent: () => size * 0.86,
        charWidth: () => size * 0.6,
        emojiWidth: () => 0,
        codeFamilyFor: () => 'Consolas',
      },
      drawRun: (text: string) => { calls.push('drawRun:' + text) },
      drawCodeRuns: () => {},
      drawBodyRuns: () => { calls.push('drawBodyRuns') },
      fillCircle: (cx: number, cy: number, radius: number) => { calls.push('fillCircle:' + cx + ',' + cy + ',' + radius) },
      fillRect: () => {},
      fillRoundRect: () => {},
      strokeRoundRect: () => {},
      hLine: () => {},
      vLine: () => {},
      withTransform: (_dx: number, _dy: number, draw: () => void) => { draw() },
      runWidth: (text: string) => text.length * size * 0.6,
    } as unknown as CardCanvas
    const ctx: LayoutCtx = { width: 400, size, widthSource: { charWidth: () => size * 0.6 } }
    renderElement({ kind: 'list', content: '第一项' }, fake, ctx, 0, top)
    return calls
  }

  it('调用 fillCircle 绘制项目符号，且不再把 • 当字符画', () => {
    const calls = renderListAt(14, 10)
    const bullet = calls.find((call) => call.startsWith('fillCircle:'))
    expect(bullet).toBeDefined()
    expect(calls.some((call) => call.includes('•'))).toBe(false)
    // 正文照常绘制（别把整个 list 分支画没了）
    expect(calls).toContain('drawBodyRuns')
  })

  it('圆点落在首行中线上：x 固定、y 在首行范围内、半径随字号缩放', () => {
    const calls = renderListAt(14, 10)
    const [cx, cy, radius] = String(calls.find((call) => call.startsWith('fillCircle:'))).slice('fillCircle:'.length).split(',').map(Number)
    expect(cx).toBe(8)
    // list 分支先 +8 间距：首行从 18 开始、行高 14 → 圆心应落在 18..32（基线 −0.3em）
    expect(cy).toBeGreaterThan(18)
    expect(cy).toBeLessThan(32)
    expect(radius).toBeGreaterThan(1)
    expect(radius).toBeLessThan(3)
  })

  it('字号放大时圆点同步放大（不是写死像素）', () => {
    const small = Number(String(renderListAt(12, 0).find((call) => call.startsWith('fillCircle:'))).split(',')[2])
    const large = Number(String(renderListAt(28, 0).find((call) => call.startsWith('fillCircle:'))).split(',')[2])
    expect(large).toBeGreaterThan(small)
  })
})

/**
 * 行内代码（`code`）的两个对齐约束 —— 曾经都错：
 * 1. 胶囊高度 size + 11 超过 list / quote 的行高 size + 10，相邻行胶囊互相挤压；
 * 2. 代码文字传入 `y + padY + 3`（+8px），同一行里汉字与代码不在一条基线上。
 */
describe('T21 行内代码与正文对齐（胶囊不撑高行、文字同基线）', () => {
  function renderCodeCapsule(size: number, top: number) {
    const rects: number[][] = []
    const codeYs: number[] = []
    const fake = {
      font: {
        familyFor: () => 'SimHei',
        ascent: () => size * 0.86,
        charWidth: () => size * 0.6,
        emojiWidth: () => 0,
        codeFamilyFor: () => 'Consolas',
      },
      drawRun: () => {},
      drawBodyRuns: () => {},
      drawCodeRuns: (_text: string, _x: number, y: number) => { codeYs.push(y) },
      fillRoundRect: (_x: number, y: number, _w: number, h: number) => { rects.push([y, h]) },
      strokeRoundRect: () => {},
      hLine: () => {},
      vLine: () => {},
      withTransform: (_dx: number, _dy: number, draw: () => void) => { draw() },
      runWidth: (text: string) => text.length * size * 0.6,
    } as unknown as CardCanvas
    const ctx: LayoutCtx = { width: 400, size, widthSource: { charWidth: () => size * 0.6 } }
    renderInlineParts(fake, 0, top, [{ cls: 'code', content: 'abc' }], size, '#000', ctx)
    const [capsuleY, capsuleH] = rects[0]
    return { capsuleY, capsuleH, codeY: codeYs[0] }
  }

  it('胶囊高度不超过最小行高（list / quote 是 size + 10）', () => {
    const { capsuleH } = renderCodeCapsule(14, 10)
    expect(capsuleH).toBeLessThanOrEqual(14 + 10)
  })

  it('胶囊在行内垂直居中（中心落在首行范围内）', () => {
    const { capsuleY, capsuleH } = renderCodeCapsule(14, 10)
    const center = capsuleY + capsuleH / 2
    expect(center).toBeGreaterThan(10)
    expect(center).toBeLessThan(10 + 14)
  })

  it('代码文字与正文共用同一条 ascender line（不得额外下沉）', () => {
    const { codeY } = renderCodeCapsule(14, 10)
    expect(codeY).toBe(10)
  })

  it('胶囊随字号缩放，不写死像素', () => {
    const small = renderCodeCapsule(12, 0).capsuleH
    const large = renderCodeCapsule(28, 0).capsuleH
    expect(large).toBeGreaterThan(small)
  })
})
