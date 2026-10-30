/**
 * 记忆向量后台补齐（第二批 2b′）：幂等、可中断、不抛错。
 * @module dsh-onebot/tests/memory-backfill
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { appendMemory, readAllMemories } from '../src/memory.js'
import { backfillChat } from '../src/memory-backfill.js'
import type { Embedder } from '../src/memory-embed.js'

function makeDir(): string {
  return mkdtempSync(join(tmpdir(), 'onebot-backfill-'))
}

interface FakeEmbedder extends Embedder {
  /** 每次调用的入参（用来断言分批与幂等） */
  calls: string[][]
}

function fakeEmbedder(dim: number, behavior: { fail?: boolean } = {}): FakeEmbedder {
  const calls: string[][] = []
  return {
    dim,
    calls,
    async isAvailable(): Promise<boolean> {
      return behavior.fail !== true
    },
    async embed(texts: readonly string[]): Promise<number[][]> {
      if (behavior.fail === true) throw new Error('boom')
      calls.push([...texts])
      return texts.map(() => new Array<number>(dim).fill(1))
    },
  }
}

describe('memory-backfill: 基本流程', () => {
  it('没有缺失向量时不做任何编码', async () => {
    const dir = makeDir()
    appendMemory(dir, 'private:10001', { ts: 1, text: 'A', emb: [1, 1], dim: 2 })
    const embedder = fakeEmbedder(2)
    const result = await backfillChat({ memoryDir: dir, chatId: 'private:10001', embedder })
    expect(result).toEqual({ embedded: 0, pending: 0, remaining: 0, cancelled: false })
    expect(embedder.calls).toHaveLength(0)
  })

  it('补齐全部缺失向量并写回', async () => {
    const dir = makeDir()
    appendMemory(dir, 'private:10001', { ts: 1, text: 'A' })
    appendMemory(dir, 'private:10001', { ts: 2, text: 'B' })
    const embedder = fakeEmbedder(3)
    const result = await backfillChat({ memoryDir: dir, chatId: 'private:10001', embedder })
    expect(result).toMatchObject({ embedded: 2, pending: 2, remaining: 0, cancelled: false })
    const entries = readAllMemories(dir, 'private:10001')
    expect(entries.every((entry) => entry.emb?.length === 3)).toBe(true)
    expect(entries.every((entry) => entry.dim === 3)).toBe(true)
  })

  it('按 batchSize 分批提交', async () => {
    const dir = makeDir()
    for (let index = 0; index < 12; index += 1) {
      appendMemory(dir, 'private:10001', { ts: index + 1, text: 't' + index })
    }
    const embedder = fakeEmbedder(2)
    await backfillChat({ memoryDir: dir, chatId: 'private:10001', embedder, batchSize: 5, budget: 100 })
    expect(embedder.calls.map((batch) => batch.length)).toEqual([5, 5, 2])
  })

  it('budget 限制本轮处理量，剩余留给下一轮', async () => {
    const dir = makeDir()
    for (let index = 0; index < 10; index += 1) {
      appendMemory(dir, 'private:10001', { ts: index + 1, text: 't' + index })
    }
    const first = await backfillChat({ memoryDir: dir, chatId: 'private:10001', embedder: fakeEmbedder(2), budget: 4 })
    expect(first).toMatchObject({ embedded: 4, pending: 10, remaining: 6 })
    const second = await backfillChat({ memoryDir: dir, chatId: 'private:10001', embedder: fakeEmbedder(2), budget: 100 })
    expect(second).toMatchObject({ embedded: 6, pending: 6, remaining: 0 })
  })
})

describe('memory-backfill: 幂等与维度迁移', () => {
  it('已有正确维度向量的条目不会被重复编码（跑两遍结果一致）', async () => {
    const dir = makeDir()
    appendMemory(dir, 'private:10001', { ts: 1, text: 'A' })
    const first = fakeEmbedder(2)
    await backfillChat({ memoryDir: dir, chatId: 'private:10001', embedder: first })
    expect(first.calls).toHaveLength(1)

    const second = fakeEmbedder(2)
    const again = await backfillChat({ memoryDir: dir, chatId: 'private:10001', embedder: second })
    expect(again.pending).toBe(0)
    expect(second.calls).toHaveLength(0)
  })

  it('维度变了（换过模型）→ 重新编码，而不是永久失效', async () => {
    const dir = makeDir()
    appendMemory(dir, 'private:10001', { ts: 1, text: 'A', emb: [1, 1], dim: 2 })
    const wider = fakeEmbedder(4)
    const result = await backfillChat({ memoryDir: dir, chatId: 'private:10001', embedder: wider })
    expect(result).toMatchObject({ embedded: 1, pending: 1, remaining: 0 })
    expect(readAllMemories(dir, 'private:10001')[0].dim).toBe(4)
  })

  it('embedder.dim 未知（0）时不误伤已有向量', async () => {
    const dir = makeDir()
    appendMemory(dir, 'private:10001', { ts: 1, text: 'A', emb: [1, 1], dim: 2 })
    const unknown = fakeEmbedder(0)
    const result = await backfillChat({ memoryDir: dir, chatId: 'private:10001', embedder: unknown })
    expect(result.pending).toBe(0)
    expect(unknown.calls).toHaveLength(0)
  })
})

describe('memory-backfill: 失败与中断', () => {
  it('编码抛错不向外冒泡，返回 embedded=0 且保留缺口', async () => {
    const dir = makeDir()
    appendMemory(dir, 'private:10001', { ts: 1, text: 'A' })
    const result = await backfillChat({
      memoryDir: dir,
      chatId: 'private:10001',
      embedder: fakeEmbedder(2, { fail: true }),
    })
    expect(result).toMatchObject({ embedded: 0, pending: 1, remaining: 1 })
    expect(readAllMemories(dir, 'private:10001')[0].emb).toBeUndefined()
  })

  it('isCancelled 返回 true 时提前停止（新回合开始就让路）', async () => {
    const dir = makeDir()
    for (let index = 0; index < 10; index += 1) {
      appendMemory(dir, 'private:10001', { ts: index + 1, text: 't' + index })
    }
    let checks = 0
    const result = await backfillChat({
      memoryDir: dir,
      chatId: 'private:10001',
      embedder: fakeEmbedder(2),
      batchSize: 2,
      budget: 100,
      // 第一次检查放行，之后取消 —— 模拟「补到一半用户又发了一条消息」
      isCancelled: () => { checks += 1; return checks > 1 },
    })
    expect(result.cancelled).toBe(true)
    expect(result.embedded).toBe(2)
    expect(result.remaining).toBe(8)
  })

  it('会话没有记忆文件时安全返回（不建目录、不抛错）', async () => {
    const dir = makeDir()
    const result = await backfillChat({ memoryDir: dir, chatId: 'private:99999', embedder: fakeEmbedder(2) })
    expect(result).toEqual({ embedded: 0, pending: 0, remaining: 0, cancelled: false })
  })
})
