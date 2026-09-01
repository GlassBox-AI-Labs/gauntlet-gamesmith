import { describe, expect, it } from 'vitest'
import { estimateCostUsd } from './pricing'

describe('estimateCostUsd', () => {
  it('prices fable with 1h cache-write and cache-read rates', () => {
    // 1M uncached in ($10) + 100k out ($5) + 10M cache read ($10) + 500k cache write ($10)
    const cost = estimateCostUsd('claude-fable-5', { input: 1_000_000, output: 100_000, cacheRead: 10_000_000, cacheWrite: 500_000 })
    expect(cost).toBeCloseTo(10 + 5 + 10 + 10, 5)
  })

  it('prices the codex critic', () => {
    // 200k in ($0.80) + 50k out ($1.00) + 1M cached ($0.40)
    const cost = estimateCostUsd('gpt-5.6-sol', { input: 200_000, output: 50_000, cacheRead: 1_000_000, cacheWrite: 0 })
    expect(cost).toBeCloseTo(0.8 + 1 + 0.4, 5)
  })

  it('prices the cheaper codex subagent tiers', () => {
    // luna: 1M in ($0.20) + 1M out ($1.20)
    expect(estimateCostUsd('gpt-5.6-luna', { input: 1_000_000, output: 1_000_000, cacheRead: 0, cacheWrite: 0 })).toBeCloseTo(1.4, 5)
    expect(estimateCostUsd('gpt-5.6-terra', { input: 1_000_000, output: 1_000_000, cacheRead: 0, cacheWrite: 0 })).toBeCloseTo(14, 5)
  })

  it('matches model id variants and rejects unknown models', () => {
    expect(estimateCostUsd('claude-opus-5', { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 })).toBeCloseTo(5)
    expect(estimateCostUsd('unknown-model', { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 })).toBeNull()
    expect(estimateCostUsd(null, { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 })).toBeNull()
  })
})
