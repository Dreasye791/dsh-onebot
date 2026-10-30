#!/usr/bin/env node
/**
 * 校验本地 embedding 模型目录是否完整，缺什么就说缺什么。
 *
 * 为什么**不做自动下载**：模型分发源不稳定（HF 官方 / 国内镜像 / 代理各人不同），
 * 压缩包还要解压依赖，而下载地址一旦写死在脚本里就会随时失效 —— 一个猜地址的
 * 下载器比一个说清「缺什么」的检查器更糟。所以这里只做校验 + 指引。
 *
 * 用法：
 *   node scripts/check-embedding-model.mjs                    # 默认 <mediaDir>/models/<model>
 *   node scripts/check-embedding-model.mjs --dir <模型目录>
 *   node scripts/check-embedding-model.mjs --model bge-small-zh
 *
 * 退出码：0 = 可用；1 = 缺失或不完整；2 = 参数错误。
 */
import { existsSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

function parseArgs(argv) {
  const options = { dir: '', model: '', dataHome: '' }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--dir') options.dir = argv[index + 1] ?? ''
    else if (token === '--model') options.model = argv[index + 1] ?? ''
    else if (token === '--data-home') options.dataHome = argv[index + 1] ?? ''
    else if (token === '--help' || token === '-h') {
      console.log('用法：node scripts/check-embedding-model.mjs [--dir <模型目录>] [--model <目录名>] [--data-home <DSH_HOME>]')
      process.exit(0)
    }
  }
  return options
}

/** 与 src/paths.ts 同口径：$DSH_HOME 优先，否则 ~/.dsh。 */
function dshHome(override) {
  if (override !== '') return override
  const fromEnv = process.env.DSH_HOME ?? ''
  return fromEnv !== '' ? fromEnv : join(homedir() || '/tmp', '.dsh')
}

function mediaDir(home) {
  return join(home, 'media', 'onebot')
}

function humanSize(bytes) {
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
}

/** transformers.js 的本地模型目录：onnx 可在根目录，也可能在 `onnx/` 子目录。 */
function findOnnxFiles(dir) {
  const found = []
  const scan = (current, prefix) => {
    let names
    try {
      names = readdirSync(current)
    } catch {
      return
    }
    for (const name of names) {
      const full = join(current, name)
      if (/\.onnx$/i.test(name)) found.push({ path: join(prefix, name), size: statSync(full).size })
      else if (name === 'onnx') scan(full, join(prefix, name))
    }
  }
  scan(dir, '')
  return found
}

const options = parseArgs(process.argv.slice(2))
const home = dshHome(options.dataHome)
const target = options.dir !== ''
  ? resolve(options.dir)
  : join(mediaDir(home), 'models', options.model !== '' ? options.model : 'bge-small-zh')

console.log('模型目录：' + target)
if (!existsSync(target)) {
  console.error('  ✗ 目录不存在')
  console.error('')
  console.error('要放什么：transformers.js 格式的 ONNX 模型目录（不是 PyTorch 的 .bin / .safetensors）')
  console.error('  config.json         模型结构')
  console.error('  tokenizer.json      分词器')
  console.error('  *.onnx              权重（onnx/ 子目录也可以；int8 量化版约 25MB）')
  console.error('')
  console.error('放好后可在设置页把「语义召回方式」设为「本地模型」，模型名填目录名（如 ' + (options.model || 'bge-small-zh') + '）。')
  process.exit(1)
}

const stat = statSync(target)
if (!stat.isDirectory()) {
  console.error('  ✗ 不是目录')
  process.exit(2)
}

const required = ['config.json']
const recommended = ['tokenizer.json', 'tokenizer_config.json']
const missing = []
for (const name of required) {
  const full = join(target, name)
  if (existsSync(full)) console.log('  ✓ ' + name.padEnd(24) + humanSize(statSync(full).size))
  else {
    console.log('  ✗ ' + name.padEnd(24) + '缺失')
    missing.push(name)
  }
}
let tokenizerFound = false
for (const name of recommended) {
  const full = join(target, name)
  if (!existsSync(full)) continue
  tokenizerFound = true
  console.log('  ✓ ' + name.padEnd(24) + humanSize(statSync(full).size))
}
if (!tokenizerFound) {
  console.log('  ✗ ' + 'tokenizer.json'.padEnd(24) + '缺失')
  missing.push('tokenizer.json')
}

const onnx = findOnnxFiles(target)
if (onnx.length === 0) {
  console.log('  ✗ ' + '*.onnx'.padEnd(24) + '缺失')
  missing.push('*.onnx')
} else {
  for (const file of onnx) console.log('  ✓ ' + file.path.padEnd(24) + humanSize(file.size))
}

console.log('')
if (missing.length === 0) {
  console.log('结论：可用。设置页把「语义召回方式」设为「本地模型」，模型名填 "' + (options.model || target.split(/[\\/]/).pop()) + '"。')
  console.log('提示：首次使用需要安装可选的 @xenova/transformers（未安装时插件会自动退回纯关键词，不会报错）。')
  process.exit(0)
}
console.log('结论：不完整，缺 ' + missing.join('、') + '。补齐后重跑本脚本。')
console.log('提示：缺少 @xenova/transformers 时插件会自动退回纯关键词，不会报错；模型不全同理。')
process.exit(1)
