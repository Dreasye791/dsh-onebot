/**
 * A8: findCommand must probe PATH by direct access() checks — no `sh -c`
 * involved, so the configured name is never shell-interpreted. Every case
 * points PATH at temp dirs, keeping the probe hermetic regardless of what
 * the host has installed (the x-bit cases need POSIX semantics).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { chmod, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { findCommand } from '../src/stt.js'

afterEach(() => {
  vi.unstubAllEnvs()
})

// POSIX 语义：无扩展名程序 + 可执行位。Windows 两者都不成立，见下面的 win32 块。
describe.skipIf(process.platform === 'win32')('findCommand (A8 PATH scan, no shell)', () => {
  it('returns the absolute path of an executable match on PATH', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stt-find-hit-'))
    const program = join(dir, 'fake-whisper')
    await writeFile(program, '#!/bin/sh\nexit 0\n')
    await chmod(program, 0o755)
    vi.stubEnv('PATH', dir)
    await expect(findCommand('fake-whisper')).resolves.toBe(program)
  })

  it('returns undefined when PATH points at an empty dir', async () => {
    vi.stubEnv('PATH', mkdtempSync(join(tmpdir(), 'stt-find-empty-')))
    await expect(findCommand('fake-whisper')).resolves.toBeUndefined()
  })

  // Windows 没有 POSIX 可执行位（chmod 无效），该语义无法在 win32 上构造。2026-10-24 审计。
  it.skipIf(process.platform === 'win32')('skips a non-executable file and keeps scanning the next dir', async () => {
    const noExec = mkdtempSync(join(tmpdir(), 'stt-find-noexec-'))
    const exec = mkdtempSync(join(tmpdir(), 'stt-find-exec-'))
    await writeFile(join(noExec, 'fake-whisper'), 'plain data, no x bit')
    await chmod(join(noExec, 'fake-whisper'), 0o644)
    const program = join(exec, 'fake-whisper')
    await writeFile(program, '#!/bin/sh\nexit 0\n')
    await chmod(program, 0o755)

    // A dir holding only a non-executable match must not satisfy the probe...
    vi.stubEnv('PATH', noExec)
    await expect(findCommand('fake-whisper')).resolves.toBeUndefined()

    // ...but the scan must continue into later dirs and find the real one.
    vi.stubEnv('PATH', noExec + ':' + exec)
    await expect(findCommand('fake-whisper')).resolves.toBe(program)
  })
})

// Windows：只认不带 shell 能启动的 .com/.exe（按 libuv 的解析规则）。PATHEXT 里的
// .bat/.cmd 不带 shell 会抛 EINVAL（CVE-2024-27980），无扩展名的 npm shim 是 sh 脚本，
// 两者都不该算「找到」——否则转写会在 spawn 阶段失败而不是报 not found。
describe.runIf(process.platform === 'win32')('findCommand on Windows (.com/.exe, no PATHEXT)', () => {
  it('finds ffmpeg.exe when asked for ffmpeg', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stt-find-win-'))
    const program = join(dir, 'ffmpeg.exe')
    await writeFile(program, '')
    vi.stubEnv('PATH', dir)
    await expect(findCommand('ffmpeg')).resolves.toBe(program)
  })

  it('takes a name that already has an extension as given', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stt-find-win-exact-'))
    await writeFile(join(dir, 'whisper-cli.exe'), '')
    vi.stubEnv('PATH', dir)
    await expect(findCommand('whisper-cli.exe')).resolves.toBe(join(dir, 'whisper-cli.exe'))
  })

  it('ignores .bat/.cmd and the extensionless npm shim even when PATHEXT lists them', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stt-find-win-shim-'))
    for (const f of ['whisper', 'whisper.cmd', 'whisper.bat', 'whisper.ps1']) await writeFile(join(dir, f), '')
    vi.stubEnv('PATH', dir)
    vi.stubEnv('PATHEXT', '.CMD;.BAT;.COM;.EXE')
    // 旧实现会把无扩展名的 'whisper'（sh 脚本）当命中，spawn 随后失败；
    // 现在只有 .cmd 的工具读作「不在 PATH 上」，而不是 EINVAL。
    await expect(findCommand('whisper')).resolves.toBeUndefined()

    await writeFile(join(dir, 'whisper.exe'), '')
    await expect(findCommand('whisper')).resolves.toBe(join(dir, 'whisper.exe'))
  })

  it('tries .com before .exe in a dir, and an earlier PATH dir before a later one', async () => {
    const first = mkdtempSync(join(tmpdir(), 'stt-find-win-first-'))
    const later = mkdtempSync(join(tmpdir(), 'stt-find-win-later-'))
    await writeFile(join(first, 'ffmpeg.exe'), '')
    await writeFile(join(later, 'ffmpeg.com'), '')
    vi.stubEnv('PATH', first + ';' + later)
    await expect(findCommand('ffmpeg')).resolves.toBe(join(first, 'ffmpeg.exe'))

    await writeFile(join(first, 'ffmpeg.com'), '')
    await expect(findCommand('ffmpeg')).resolves.toBe(join(first, 'ffmpeg.com'))
  })
})
