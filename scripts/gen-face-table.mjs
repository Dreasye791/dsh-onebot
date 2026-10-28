/**
 * 从 NapCat 的 qface 静态资产生成 QQ 表情 id → 中文名表（src/face-names.ts）。
 *
 * 为什么必须用它而不是手写：OneBot face 段的 `id` 就是 QQ 表情面板的 QSid，
 * 而 QSid→名称 只存在于 QQ 客户端资产里；早先抄来的 emoji 表按 Unicode 顺序
 * 编号，与 QSid 完全不同源（id=289 是「睁眼」，表里却是 🐛）。这份生成物是
 * 唯一对得上号的数据源。
 *
 * qface 资产的两个坑：
 *  1. 文件名带构建 hash（qface-BZLvZXJ8.js），只能按 qface-*.js 通配；
 *  2. 文件是 UTF-8，但 PowerShell 5.1 的 Get-Content 默认按 ANSI(GBK) 读，
 *     会显示成「鐫佺溂」——那是解码错，不是文件编码错，别照着乱码建表。
 *
 * 用法：node scripts/gen-face-table.mjs [--napcat <assets 目录>] [--out <文件>]
 * @module scripts/gen-face-table
 */
import fs from 'node:fs'
import path from 'node:path'

const args = process.argv.slice(2)
function argOf(name, fallback) {
  const at = args.indexOf(name)
  return at >= 0 && args[at + 1] !== undefined ? args[at + 1] : fallback
}

const assetsDir = argOf(
  '--napcat',
  path.resolve(process.cwd(), '..', '..', 'napcat', 'NapCat.Shell', 'static', 'assets'),
)
const outFile = argOf('--out', path.resolve(process.cwd(), 'src', 'face-names.ts'))

const candidates = fs.existsSync(assetsDir)
  ? fs.readdirSync(assetsDir).filter(name => /^qface-.*\.js$/.test(name))
  : []
if (candidates.length === 0) {
  console.error('找不到 qface-*.js：' + assetsDir)
  console.error('传 --napcat <NapCat.Shell/static/assets 目录>，或确认 NapCat 已解压。')
  process.exit(1)
}

const source = fs.readFileSync(path.join(assetsDir, candidates[0]))
const text = new TextDecoder('utf8').decode(source)

// 条目形如 {"QSid":"289","QDes":"/睁眼","IQLid":"289",...,"EMCode":"10289","Input":[...]}
const entryRe = /\{"QSid":"(\d+)"[\s\S]*?"QDes":"\/([^"]*)"/g
const names = new Map()
for (const m of text.matchAll(entryRe)) {
  const id = Number(m[1])
  const name = m[2].trim()
  if (name === '' || names.has(id)) continue
  names.set(id, name)
}

if (names.size === 0) {
  console.error('解析到 0 条表情：' + candidates[0] + '（编码或结构变了？）')
  process.exit(1)
}

const ids = [...names.keys()].sort((a, b) => a - b)
const lines = []
for (let i = 0; i < ids.length; i += 6) {
  const chunk = ids.slice(i, i + 6).map((id) => {
    const name = names.get(id).replace(/\\/g, '\\\\').replace(/'/g, "\\'")
    return `'${id}': '${name}'`
  })
  lines.push('  ' + chunk.join(', ') + ',')
}

const banner = `/**
 * QQ 内置表情 id（OneBot face 段的 QSid）→ 中文名。
 *
 * 生成文件，勿手改：node scripts/gen-face-table.mjs
 * 数据源：NapCat 的 static/assets/${candidates[0]}（UTF-8）。
 * 覆盖 ${ids.length} 条（id ${ids[0]}–${ids[ids.length - 1]}）。
 * @module dsh-onebot/face-names
 */

export const FACE_NAMES: Record<string, string> = {
${lines.join('\n')}}
`

fs.writeFileSync(outFile, banner, 'utf8')
console.log('wrote ' + outFile + '  (' + names.size + ' 条，源 ' + candidates[0] + ')')
for (const id of [0, 14, 76, 178, 289, 291]) {
  if (names.has(id)) console.log('  ' + id + ' → ' + names.get(id))
}
