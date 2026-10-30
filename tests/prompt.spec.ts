import { describe, expect, it } from 'vitest'
import { buildPlatformPrompt } from '../src/prompt.js'

describe('buildPlatformPrompt', () => {
  it('forbids host Web-interaction tools and routes plan-mode exit via /plan off on QQ', () => {
    const text = buildPlatformPrompt(false)
    expect(text).toContain('ask_user_question')
    expect(text).toContain('exit_plan_mode')
    expect(text).toContain('纯文本提问并等待用户回复')
    // Host plan mode must be exit-able from QQ without the Web review card.
    expect(text).toContain('/plan off')
    // M3-D5: the user_message boundary declaration is part of the platform section.
    expect(text).toContain('<user_message')
  })

  it('keeps the restricted-member prefix note only when enabled', () => {
    expect(buildPlatformPrompt(false)).not.toContain('来自受限用户')
    expect(buildPlatformPrompt(true)).toContain('来自受限用户')
  })

  it('只有启用记忆时才提记忆工具（否则模型会去调不存在的工具）', () => {
    // 默认参数（未传）与显式 false 都必须沉默
    expect(buildPlatformPrompt(false)).not.toContain('qq_memory_recall')
    expect(buildPlatformPrompt(false, '', false)).not.toContain('qq_memory_recall')
    const on = buildPlatformPrompt(false, '', true)
    expect(on).toContain('qq_memory_remember')
    expect(on).toContain('qq_memory_recall')
    // 三条关键行为必须写进 prompt，否则模型不会主动 recall
    expect(on).toContain('先 recall')
    expect(on).toContain('字面匹配')
    // 内容边界：负评/敏感信息不记，画像只当观察
    expect(on).toContain('负面评判')
    expect(on).toContain('观察')
    expect(on).toContain('群聊里默认不建画像')
    // 主动性：没有这条，记忆就是纯响应式的（用户不说「记住」就永远不记）
    expect(on).toContain('主动记忆')
    expect(on).toContain('不要等用户开口说')
    expect(on).toContain('一轮最多记一条')
  })

  it('记忆提示与人设层共存，且人设仍在最前', () => {
    const text = buildPlatformPrompt(false, '你说话简短', true)
    expect(text.indexOf('## 角色设定')).toBe(0)
    expect(text).toContain('qq_memory_recall')
  })
})
