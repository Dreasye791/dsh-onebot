/**
 * `buildLauncherCommand` —— 拉起命令的拼接与转义。
 *
 * 为什么值得单独测：参数来自 patch config（管理员手写），最终交给 `cmd /c` 执行。
 * 含 `& | < > ^ % !` 的参数会被 cmd 当作命令分隔/重定向/变量展开 —— 轻则拉起失败，
 * 重则执行配置里根本没写的命令。这里钉死「丢弃 + 不回显」的 fail-closed 行为。
 */
import { describe, expect, it } from 'vitest'

import { buildLauncherCommand } from '../src/napcat-watch.js'

const LAUNCHER = 'G:\\napcat\\NapCat.Shell\\launcher-user.bat'

describe('buildLauncherCommand', () => {
  it('无参数时只包路径，且保留 chcp 65001（否则中文控制台乱码）', () => {
    const { command, dropped } = buildLauncherCommand(LAUNCHER)
    expect(command).toBe('chcp 65001 >nul & "' + LAUNCHER + '"')
    expect(dropped).toEqual([])
  })

  it('-q 与 QQ 号作为两个独立参数追加（NapCat 只认这种形态）', () => {
    const { command, dropped } = buildLauncherCommand(LAUNCHER, ['-q', '10002'])
    expect(command).toBe('chcp 65001 >nul & "' + LAUNCHER + '" -q 10002')
    expect(dropped).toEqual([])
  })

  it('含空格的参数自动加引号', () => {
    const { command } = buildLauncherCommand(LAUNCHER, ['--title', 'my bot'])
    expect(command).toContain(' --title "my bot"')
  })

  it('cmd 元字符参数被丢弃，且不进入命令（fail-closed）', () => {
    const { command, dropped } = buildLauncherCommand(LAUNCHER, [
      '-q',
      '10002',
      '& calc',
      'a|b',
      '>out.txt',
      '100%',
      'x!y',
    ])
    expect(command).toBe('chcp 65001 >nul & "' + LAUNCHER + '" -q 10002')
    expect(dropped).toHaveLength(5)
    // 命令里绝不能出现被丢弃的片段
    expect(command).not.toContain('calc')
    expect(command).not.toContain('out.txt')
  })

  it('空字符串与纯空白参数被跳过，不留下多余空格', () => {
    const { command, dropped } = buildLauncherCommand(LAUNCHER, ['', '   ', '-q', '10001'])
    expect(command).toBe('chcp 65001 >nul & "' + LAUNCHER + '" -q 10001')
    expect(dropped).toEqual([])
  })

  it('参数顺序保持原样', () => {
    const { command } = buildLauncherCommand(LAUNCHER, ['--a', '--b'])
    expect(command.endsWith(' --a --b')).toBe(true)
  })
})
