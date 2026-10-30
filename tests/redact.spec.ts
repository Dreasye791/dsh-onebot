/**
 * 出站本机路径脱敏（src/redact.ts + outbound.sendToChat 接入点）。
 *
 * 背景：模型拿绝对路径读文件后，常把路径复述进回复，群里就泄露目录结构。
 * 规则本身与接入点都在这里覆盖，避免两处改动各自漂移。
 * @module dsh-onebot/tests/redact
 */
import { describe, expect, it } from 'vitest'

import { OutboundPipeline } from '../src/outbound.js'
import { LOCAL_PATH_PLACEHOLDER, redactLocalPaths } from '../src/redact.js'

describe('redactLocalPaths', () => {
  it('替换盘符路径（反斜杠与正斜杠）', () => {
    const backslash = redactLocalPaths('素材在 G:\\dsh-home\\profiles\\vidsum_out\\BV1 里')
    expect(backslash.text).toBe(`素材在 ${LOCAL_PATH_PLACEHOLDER} 里`)
    expect(backslash.count).toBe(1)

    const forward = redactLocalPaths('见 C:/temp/a.txt')
    expect(forward.text).toBe(`见 ${LOCAL_PATH_PLACEHOLDER}`)
    expect(forward.count).toBe(1)
  })

  it('替换 UNC 路径与长路径前缀', () => {
    expect(redactLocalPaths('共享 \\\\nas\\share\\a.mp4 上').text).toBe(`共享 ${LOCAL_PATH_PLACEHOLDER} 上`)
    expect(redactLocalPaths('长 \\\\?\\D:\\x\\y 上').text).toBe(`长 ${LOCAL_PATH_PLACEHOLDER} 上`)
  })

  it('一次替换多处', () => {
    const result = redactLocalPaths('A: D:\\a\\b，B: E:\\c\\d')
    expect(result.count).toBe(2)
    expect(result.text).toBe(`A: ${LOCAL_PATH_PLACEHOLDER}，B: ${LOCAL_PATH_PLACEHOLDER}`)
  })

  it('不误伤 URL 与相对路径', () => {
    const text = 'https://example.com/a/b 与 vidsum_out/BV1/ 都不该被替换'
    const result = redactLocalPaths(text)
    expect(result.text).toBe(text)
    expect(result.count).toBe(0)
  })

  it('没有路径时原样返回', () => {
    expect(redactLocalPaths('看完了，是个安装教学')).toEqual({ text: '看完了，是个安装教学', count: 0 })
    expect(redactLocalPaths('')).toEqual({ text: '', count: 0 })
  })
})

describe('sendToChat 接入点', () => {
  /** 最小出站上下文：只在内存里记录 call 的参数，不落盘。 */
  const makeHarness = (redactLocalPaths?: boolean): { pipeline: OutboundPipeline; sent: Array<Record<string, unknown>>; logs: string[] } => {
    const sent: Array<Record<string, unknown>> = []
    const logs: string[] = []
    const pipeline = new OutboundPipeline({
      getChat: () => ({ lastNickname: '' }),
      connected: () => true,
      selfId: () => '10002',
      call: async (_action, params) => {
        sent.push(params as Record<string, unknown>)
        return { message_id: 7 }
      },
      isStopping: () => false,
      log: (level, message) => { logs.push(level + ':' + message) },
      config: {
        botQQ: '10002',
        sensitivePatterns: [],
        textImageThreshold: 0,
        maxImageBytes: 8 * 1024 * 1024,
        cardFooter: 'dsh',
        fontFiles: [],
        fontFamilies: [],
        ...(redactLocalPaths === undefined ? {} : { redactLocalPaths }),
      },
    })
    return { pipeline, sent, logs }
  }

  it('回复里的本机路径被替换后再发送', async () => {
    const { pipeline, sent, logs } = makeHarness()
    await pipeline.sendToChat('group:1', '素材在 G:\\dsh-home\\profiles\\vidsum_out\\BV16KnN6KEwo')

    const payload = JSON.stringify(sent)
    expect(payload).toContain(LOCAL_PATH_PLACEHOLDER)
    expect(payload).not.toContain('dsh-home')
    expect(logs.some((line) => line.startsWith('warn:出站文本已脱敏'))).toBe(true)
  })

  it('redactLocalPaths=false 时原样发送', async () => {
    const { pipeline, sent } = makeHarness(false)
    await pipeline.sendToChat('group:1', '素材在 G:\\dsh-home\\x')

    expect(JSON.stringify(sent)).toContain('dsh-home')
  })
})
