/**
 * 路径口径的唯一来源（插件入口与设置页服务共用）。
 *
 * 为什么要独立成模块：`settings-remote.ts` 需要解析 `<mediaDir>/memory`，而 mediaDir
 * 的默认值（`$DSH_HOME` → `<dsh-home>/media/onebot`）原先只写在 `index.ts` 里。若在
 * 设置页服务里重写一份，两处一旦漂移就会出现「模型写进 A 目录、面板读 B 目录」的
 * 静默错位 —— 这类问题不会报错，只会表现为「面板里什么都没有」。
 *
 * 也不能直接 `import './index.js'`：那是插件入口，带顶层 await 与整份模块初始化。
 *
 * @module dsh-onebot/paths
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

const ENV = (name: string): string => process.env[name] ?? ''

/** The dsh data home ($DSH_HOME or ~/.dsh); source of the .agent-presets dir. */
export function dshHome(): string {
  // os.homedir() reads $HOME first and falls back to the passwd entry — the
  // systemd service runs without HOME, so `?? '/tmp'` used to resolve to
  // /tmp/.dsh and preset enumeration hit ENOENT (web log line 14429).
  return ENV('DSH_HOME') !== '' ? ENV('DSH_HOME') : join(homedir() || '/tmp', '.dsh')
}

/** Default media dir: <dsh-home>/media/onebot (dsh-home = $DSH_HOME or ~/.dsh). */
export function defaultMediaDir(): string {
  return join(dshHome(), 'media', 'onebot')
}

/** 生效的媒体目录：显式 `mediaDir` 优先，留空回落到默认值。 */
export function resolveMediaDir(raw: string): string {
  return raw !== '' ? raw : defaultMediaDir()
}

/** 记忆目录：`<mediaDir>/memory`（工具写入与设置页读取必须指向同一处）。 */
export function memoryDirFor(rawMediaDir: string): string {
  return join(resolveMediaDir(rawMediaDir), 'memory')
}
