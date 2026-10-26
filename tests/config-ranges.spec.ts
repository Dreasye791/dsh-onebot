/**
 * 守卫：版本区间必须成组维护。
 *
 * 动机（2026-10-26 实测）：0.9.4 的 69d17f3 只把 `|| >=0.2.1-0 <0.3.0-0` 加进
 * engines.dsh，7 个 `@deepseek-ai/dsh-*` peer 漏改 → 宿主换到 0.2.1-rc.3 后
 * peer 声明不承认正在跑的版本（semver.satisfies = false），安装期兼容门会拒装。
 * 这类漏改的特征就是「一处改了、另一处没改」，因此断言三处分支集合完全相同。
 *
 * 另一条：`@deepseek-ai/schemastery` 走的是自身 3.18.x 版本线（宿主 3.18.5），
 * 不能套 dsh 的 0.1.5/0.2.x 区间 —— 套错的后果是 npm ETARGET，锁文件无法生成。
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

interface RangeManifest {
  engines?: { dsh?: string }
  peerDependencies?: Record<string, string>
}

const readManifest = (relative: string): RangeManifest =>
  JSON.parse(readFileSync(new URL(relative, import.meta.url), 'utf8')) as RangeManifest

/** Split an `||` range into trimmed branches, order preserved. */
const branches = (range: string): string[] =>
  range.split('||').map(part => part.trim()).filter(part => part !== '')

describe('version range guards', () => {
  const pkg = readManifest('../package.json')
  const pluginManifest = readManifest('../dsh.plugin.json')

  it('7 个 @deepseek-ai/dsh-* peer 与 engines.dsh 声明同一组分支', () => {
    const engine = branches(pkg.engines?.dsh ?? '')
    expect(engine.length).toBeGreaterThan(0)

    const dshPeers = Object.entries(pkg.peerDependencies ?? {})
      .filter(([name]) => name.startsWith('@deepseek-ai/dsh-'))
    // dsh-agent / dsh-llm / dsh-session / dsh-system-prompt / dsh-tools /
    // dsh-typert-protocol / dsh-util-values —— 新增 dsh-* peer 时同步这条断言。
    expect(dshPeers).toHaveLength(7)

    for (const [name, range] of dshPeers) {
      expect(branches(range), name + ' 的分支集合必须与 engines.dsh 一致').toEqual(engine)
    }
  })

  it('dsh.plugin.json 的 engines.dsh 与 package.json 一致', () => {
    expect(branches(pluginManifest.engines?.dsh ?? '')).toEqual(branches(pkg.engines?.dsh ?? ''))
  })

  it('@deepseek-ai/schemastery 走自身 3.18 线，不套 dsh 版本区间', () => {
    const peer = pkg.peerDependencies?.['@deepseek-ai/schemastery']
    expect(peer).toBeDefined()
    expect(peer).not.toContain('0.1.5-rc.1')
    expect(peer).toBe('^3.18.0')
  })
})
