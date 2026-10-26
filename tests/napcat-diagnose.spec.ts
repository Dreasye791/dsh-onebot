/**
 * NapCat 判定矩阵（纯函数 judgeNapcat）。
 *
 * 用例来自真实事故（2026-10-26）：QQ 在 12:25 被手动启动，插件 15:35 两次拉起
 * 注入器都失败，而旧判定先走「注入器不在 → 根本没启动」分支，把真原因（QQ 已
 * 占用、注入器无法接管）完全盖住。这里把「卡在哪一步」的每个分支钉死。
 */
import { describe, expect, it } from 'vitest'

import { formatDiagnosis, judgeNapcat } from '../src/napcat-diagnose.js'
import type { NapcatFacts } from '../src/napcat-diagnose.js'

const base: NapcatFacts = {
  napcatProcess: false,
  qqProcesses: 0,
  port: 8643,
  wsConnected: false,
  qrcodeAgeMinutes: null,
  riskHint: null,
}

const judge = (patch: Partial<NapcatFacts>) => judgeNapcat({ ...base, ...patch })

describe('judgeNapcat — 卡在哪一步', () => {
  it('已连接 → ok，且不因其它事实改判', () => {
    const result = judge({ wsConnected: true, qqProcesses: 7, napcatProcess: true })
    expect(result.stage).toBe('ok')
  })

  it('日志出现风控关键词时优先报 risk-control', () => {
    const result = judge({ riskHint: '疑似异常登录', qqProcesses: 7 })
    expect(result.stage).toBe('risk-control')
  })

  it('QQ 在跑但注入器不在 → qq-conflict，并给出「先退出 QQ」的下一步（本次事故）', () => {
    const result = judge({ qqProcesses: 7 })
    expect(result.stage).toBe('qq-conflict')
    expect(result.summary).toContain('请完全退出 QQ')
    expect(result.summary).toContain('7 个进程')
  })

  it('QQ 与注入器都不在 → no-process', () => {
    expect(judge({}).stage).toBe('no-process')
  })

  it('注入器在跑 + 二维码新鲜 → not-logged-in（卡在扫码）', () => {
    const result = judge({ napcatProcess: true, qrcodeAgeMinutes: 2 })
    expect(result.stage).toBe('not-logged-in')
    expect(result.summary).toContain('扫码')
  })

  it('注入器在跑 + 二维码过期 → not-connected（卡在 OneBot 配置）', () => {
    const result = judge({ napcatProcess: true, qrcodeAgeMinutes: 12 })
    expect(result.stage).toBe('not-connected')
    expect(result.summary).toContain('8643')
    expect(result.summary).toContain('token')
  })

  it('注入器在跑 + 无二维码 → not-connected', () => {
    expect(judge({ napcatProcess: true }).stage).toBe('not-connected')
  })
})

describe('formatDiagnosis', () => {
  it('QQ 进程数文案不再暗示实例数/多开，也不再提「托管」', () => {
    const text = formatDiagnosis({
      ...base,
      qqProcesses: 7,
      stage: 'qq-conflict',
      summary: 'QQ 已在运行',
    })
    expect(text).toContain('一个 QQ 通常有多个进程')
    expect(text).not.toContain('无托管实例')
    expect(text).toContain('8643')
  })
})
