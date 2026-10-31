/**
 * 记忆语义编码（第二批 2a）：工厂选择、本地实现、远程实现、统一降级。
 *
 * 本批**不接线**（tools / bridge 都不引用），所以这里只测单元行为；
 * 「编码后是否真的参与召回」属于 2b。
 * @module dsh-onebot/tests/memory-embed
 */
import { describe, expect, it, vi } from 'vitest'

import { HttpEmbedder, LocalEmbedder, createEmbedder, embedSafely } from '../src/memory-embed.js'
import type { FeaturePipeline } from '../src/memory-embed.js'

/** 假 pipeline：第 i 条返回全 i+1 的向量，便于断言顺序。 */
function fakePipeline(dim = 4): FeaturePipeline {
  return async (texts) => texts.map((_text, index) => new Array<number>(dim).fill(index + 1))
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

describe('memory-embed: 工厂按配置选择实现', () => {
  it('mode 缺省 / off → undefined（等价于纯关键词）', () => {
    expect(createEmbedder({})).toBeUndefined()
    expect(createEmbedder({ mode: 'off' })).toBeUndefined()
  })

  it('local 缺模型目录 → undefined', () => {
    expect(createEmbedder({ mode: 'local' })).toBeUndefined()
    expect(createEmbedder({ mode: 'local', model: '   ' })).toBeUndefined()
  })

  it('http 缺 url 或模型名 → undefined', () => {
    expect(createEmbedder({ mode: 'http', model: 'bge-m3' })).toBeUndefined()
    expect(createEmbedder({ mode: 'http', url: 'http://localhost:11434' })).toBeUndefined()
  })

  it('local 与 http 各自返回对应实现', () => {
    const local = createEmbedder({ mode: 'local', model: 'bge-small-zh' })
    expect(local).toBeInstanceOf(LocalEmbedder)
    const http = createEmbedder({ mode: 'http', url: 'http://localhost:11434', model: 'nomic-embed-text' })
    expect(http).toBeInstanceOf(HttpEmbedder)
  })
})

describe('memory-embed: LocalEmbedder', () => {
  it('批量编码顺序与入参一致，维度从首次结果推导', async () => {
    const pipe = vi.fn(fakePipeline(8))
    const embedder = new LocalEmbedder('models/bge', async () => pipe)
    await expect(embedder.isAvailable()).resolves.toBe(true)
    expect(embedder.dim).toBe(0) // 还没编码过

    const vectors = await embedder.embed(['一', '二', '三'])
    expect(vectors).toHaveLength(3)
    expect(vectors[0]).toHaveLength(8)
    expect(vectors[0][0]).toBe(1)
    expect(vectors[2][0]).toBe(3)
    expect(embedder.dim).toBe(8)
  })

  it('空入参不触发加载、不调用 pipeline', async () => {
    const factory = vi.fn(async () => fakePipeline(4))
    const embedder = new LocalEmbedder('models/bge', factory)
    await expect(embedder.embed([])).resolves.toEqual([])
    expect(factory).not.toHaveBeenCalled()
  })

  it('加载失败 → isAvailable false，embed 抛错，退避窗口内不重复加载', async () => {
    const factory = vi.fn(async () => { throw new Error('未安装 @xenova/transformers') })
    const embedder = new LocalEmbedder('models/bge', factory)
    await expect(embedder.isAvailable()).resolves.toBe(false)
    await expect(embedder.embed(['x'])).rejects.toThrow('本地 embedding 模型不可用')
    // 第二次 isAvailable 落在退避窗口内 → 不再尝试 import
    await expect(embedder.isAvailable()).resolves.toBe(false)
    expect(factory).toHaveBeenCalledTimes(1)
  })

  it('退避窗口过后会重试（模型目录临时不可用不该逼用户重启进程）', async () => {
    let attempts = 0
    const factory = async () => {
      attempts += 1
      if (attempts === 1) throw new Error('模型目录临时不可用（网络盘掉线/杀软锁定）')
      return fakePipeline(4)
    }
    // retryAfterMs = 0 → 立刻允许重试（生产默认 5 分钟）
    const embedder = new LocalEmbedder('models/bge', factory, 0)
    await expect(embedder.isAvailable()).resolves.toBe(false)
    await expect(embedder.isAvailable()).resolves.toBe(true)
    expect(attempts).toBe(2)
  })

  it('并发调用只加载一次模型', async () => {
    const factory = vi.fn(async () => fakePipeline(4))
    const embedder = new LocalEmbedder('models/bge', factory)
    await Promise.all([embedder.isAvailable(), embedder.isAvailable(), embedder.embed(['a'])])
    expect(factory).toHaveBeenCalledTimes(1)
  })

  it('返回条数与输入不一致 → 抛错（不能让脏数据进记忆）', async () => {
    const bad: FeaturePipeline = async () => [[1, 2, 3]]
    const embedder = new LocalEmbedder('models/bge', async () => bad)
    await expect(embedder.embed(['a', 'b'])).rejects.toThrow('不一致')
  })

  it('输出形状不可识别 → 抛错', async () => {
    const bad = (async () => ({ nope: true })) as unknown as FeaturePipeline
    const embedder = new LocalEmbedder('models/bge', async () => bad)
    await expect(embedder.embed(['a'])).rejects.toThrow('形状不可识别')
  })

  it('兼容 Tensor 风格的 tolist()', async () => {
    const tensorLike = (async () => ({ tolist: () => [[1, 2], [3, 4]] })) as unknown as FeaturePipeline
    const embedder = new LocalEmbedder('models/bge', async () => tensorLike)
    await expect(embedder.embed(['a', 'b'])).resolves.toEqual([[1, 2], [3, 4]])
  })
})

describe('memory-embed: HttpEmbedder（OpenAI 兼容）', () => {
  it('url 以 /v1 结尾 → POST /v1/embeddings + Bearer + 解析 data[].embedding', async () => {
    const doFetch = vi.fn(async () => jsonResponse({
      data: [{ embedding: [0.1, 0.2] }, { embedding: [0.3, 0.4] }],
    }))
    const embedder = new HttpEmbedder({
      url: 'https://api.example.com/v1/',
      model: 'bge-m3',
      key: 'sk-test',
      fetchImpl: doFetch as unknown as typeof fetch,
    })
    const vectors = await embedder.embed(['甲', '乙'])
    expect(vectors).toEqual([[0.1, 0.2], [0.3, 0.4]])
    expect(embedder.dim).toBe(2)

    const [endpoint, init] = doFetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(endpoint).toBe('https://api.example.com/v1/embeddings')
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer sk-test')
    expect(JSON.parse(String(init.body))).toEqual({ model: 'bge-m3', input: ['甲', '乙'] })
  })
})

describe('memory-embed: HttpEmbedder（Ollama）', () => {
  it('url 不以 /v1 结尾 → POST /api/embed + 解析 embeddings', async () => {
    const doFetch = vi.fn(async () => jsonResponse({ embeddings: [[1, 2, 3]] }))
    const embedder = new HttpEmbedder({
      url: 'http://localhost:11434',
      model: 'nomic-embed-text',
      fetchImpl: doFetch as unknown as typeof fetch,
    })
    await expect(embedder.embed(['x'])).resolves.toEqual([[1, 2, 3]])
    const [endpoint, init] = doFetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(endpoint).toBe('http://localhost:11434/api/embed')
    // 没有 key 时不应带 authorization
    expect((init.headers as Record<string, string>).authorization).toBeUndefined()
  })

  it('url 直接写完整端点 /v1/embeddings 也走 OpenAI 协议，且不重复拼接', async () => {
    // 各家文档最常见的就是让你粘完整端点；判成 Ollama 会 POST 到
    // `…/v1/embeddings/api/embed` 拿 404，而降级是静默的，极难排查。
    const doFetch = vi.fn(async () => jsonResponse({ data: [{ embedding: [0.5] }] }))
    const embedder = new HttpEmbedder({
      url: 'https://api.example.com/v1/embeddings',
      model: 'm',
      fetchImpl: doFetch as unknown as typeof fetch,
    })
    await expect(embedder.embed(['x'])).resolves.toEqual([[0.5]])
    const [endpoint] = doFetch.mock.calls[0] as unknown as [string]
    expect(endpoint).toBe('https://api.example.com/v1/embeddings')
  })

  it('Infinity 形态：url 以 /embeddings 结尾（无 /v1）也走 OpenAI 协议，且不重复拼接', async () => {
    // 实测 Infinity（michaelf34/infinity）只提供 POST /embeddings，没有
    // /v1/embeddings（404），但响应体是标准 OpenAI 形状。只认 /v1 时三种写法
    // 都会 404 —— 而且降级是静默的，只表现为「语义召回好像没用」。
    const doFetch = vi.fn(async () => jsonResponse({
      object: 'list',
      data: [{ object: 'embedding', embedding: [0.1, 0.2] }],
    }))
    const embedder = new HttpEmbedder({
      url: 'http://127.0.0.1:7997/embeddings',
      model: 'BAAI/bge-small-zh-v1.5',
      fetchImpl: doFetch as unknown as typeof fetch,
    })
    // 响应里是 512 维，这里用 2 维替身，只验证走对了端点
    await expect(embedder.embed(['x'])).resolves.toEqual([[0.1, 0.2]])
    const [endpoint] = doFetch.mock.calls[0] as unknown as [string]
    expect(endpoint).toBe('http://127.0.0.1:7997/embeddings')
  })

  it('Ollama 完整端点 /api/embed 不再被双拼', async () => {
    const doFetch = vi.fn(async () => jsonResponse({ embeddings: [[0.3]] }))
    const embedder = new HttpEmbedder({
      url: 'http://127.0.0.1:11434/api/embed',
      model: 'bge-m3',
      fetchImpl: doFetch as unknown as typeof fetch,
    })
    await expect(embedder.embed(['x'])).resolves.toEqual([[0.3]])
    const [endpoint] = doFetch.mock.calls[0] as unknown as [string]
    expect(endpoint).toBe('http://127.0.0.1:11434/api/embed')
  })

  it('非 2xx → 抛错（由 embedSafely 降级）', async () => {
    const doFetch = vi.fn(async () => jsonResponse({ error: 'boom' }, 500))
    const embedder = new HttpEmbedder({
      url: 'http://localhost:11434',
      model: 'x',
      fetchImpl: doFetch as unknown as typeof fetch,
    })
    await expect(embedder.embed(['a'])).rejects.toThrow('HTTP 500')
  })

  it('空入参不发请求', async () => {
    const doFetch = vi.fn()
    const embedder = new HttpEmbedder({
      url: 'http://localhost:11434',
      model: 'x',
      fetchImpl: doFetch as unknown as typeof fetch,
    })
    await expect(embedder.embed([])).resolves.toEqual([])
    expect(doFetch).not.toHaveBeenCalled()
  })

  it('超时会 abort（默认随批量放大到 5s + 1s/条、上限 30s；可用 timeoutMs 覆盖）', async () => {
    // 不真的等十几秒：只验证「超时到点会 abort 且错误能传出去」。
    const doFetch = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => { reject(new Error('aborted by timeout')) })
    }))
    const embedder = new HttpEmbedder({
      url: 'http://localhost:11434',
      model: 'x',
      timeoutMs: 20,
      fetchImpl: doFetch as unknown as typeof fetch,
    })
    await expect(embedder.embed(['a'])).rejects.toThrow('aborted by timeout')
  })

  it('响应条数不一致 → 抛错', async () => {
    const doFetch = vi.fn(async () => jsonResponse({ embeddings: [[1]] }))
    const embedder = new HttpEmbedder({
      url: 'http://localhost:11434',
      model: 'x',
      fetchImpl: doFetch as unknown as typeof fetch,
    })
    await expect(embedder.embed(['a', 'b'])).rejects.toThrow('不一致')
  })
})

describe('memory-embed: 编码器指纹（维度相同也要能区分模型）', () => {
  it('local 用模型目录、http 用 endpoint#模型名', () => {
    const local = new LocalEmbedder('/opt/models/bge-small-zh', async () => fakePipeline(4))
    expect(local.id).toBe('local:/opt/models/bge-small-zh')
    const http = new HttpEmbedder({ url: 'http://127.0.0.1:11434/', model: 'bge-m3' })
    // 尾部斜杠被归一化：否则同一端点写成两种形式会算出两个指纹，触发全量重编
    expect(http.id).toBe('http:http://127.0.0.1:11434#bge-m3')
  })

  it('同维度不同模型 → 指纹不同（这正是只比维度会漏掉的情形）', () => {
    const bge = new HttpEmbedder({ url: 'http://127.0.0.1:11434', model: 'bge-m3', dim: 1024 })
    const qwen = new HttpEmbedder({ url: 'http://127.0.0.1:11434', model: 'qwen3-embedding:0.6b', dim: 1024 })
    expect(bge.dim).toBe(qwen.dim)
    expect(bge.id).not.toBe(qwen.id)
  })

  it('同一模型名但不同端点也算不同指纹（权重不保证一致）', () => {
    const a = new HttpEmbedder({ url: 'http://host-a:11434', model: 'bge-m3' })
    const b = new HttpEmbedder({ url: 'http://host-b:11434', model: 'bge-m3' })
    expect(a.id).not.toBe(b.id)
  })
})

describe('memory-embed: embedSafely 统一降级', () => {
  it('没有 embedder → undefined（调用方走纯关键词）', async () => {
    await expect(embedSafely(undefined, ['x'])).resolves.toBeUndefined()
  })

  it('编码抛错 → 吞掉并返回 undefined，不向上冒泡', async () => {
    const broken: FeaturePipeline = async () => { throw new Error('服务挂了') }
    const embedder = new LocalEmbedder('models/bge', async () => broken)
    await expect(embedSafely(embedder, ['x'])).resolves.toBeUndefined()
  })

  it('成功时原样返回向量', async () => {
    const embedder = new LocalEmbedder('models/bge', async () => fakePipeline(3))
    await expect(embedSafely(embedder, ['a'])).resolves.toEqual([[1, 1, 1]])
  })

  it('失败时调用 onFailure（否则「端点配错/模型缺失」就是永久静默降级）', async () => {
    const broken: FeaturePipeline = async () => { throw new Error('服务挂了') }
    const embedder = new LocalEmbedder('models/bge', async () => broken)
    const seen: unknown[] = []
    await embedSafely(embedder, ['x'], (error) => { seen.push(error) })
    expect(seen).toHaveLength(1)
    expect((seen[0] as Error).message).toBe('服务挂了')
  })

  it('没有 embedder 时不触发 onFailure（「未启用」不是错误）', async () => {
    const seen: unknown[] = []
    await expect(embedSafely(undefined, ['x'], (error) => { seen.push(error) })).resolves.toBeUndefined()
    expect(seen).toHaveLength(0)
  })
})
