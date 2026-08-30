import { describe, expect, it } from 'vitest'
import { estimateCostUsd } from './pricing'

describe('estimateCostUsd', () => {
  it('prices fable with 1h cache-write and cache-read rates', () => {
    // 1M uncached in ($10) + 100k out ($5) + 10M cache read ($10) + 500k cache write ($10)
    const cost = estimateCostUsd('claude-fable-5', { input: 1_000_000, output: 100_000, cacheRead: 10_000_000, cacheWrite: 500_000 })
    expect(cost).toBeCloseTo(10 + 5 + 10 + 10, 5)
  })

  it('prices the codex critic', () => {
    // 200k in ($1.00) + 50k out ($1.50) + 1M cached ($0.50)
    const cost = estimateCostUsd('gpt-5.6-sol', { input: 200_000, output: 50_000, cacheRead: 1_000_000, cacheWrite: 0 })
    expect(cost).toBeCloseTo(1 + 1.5 + 0.5, 5)
  })

  it('matches model id variants and rejects unknown models', () => {
    expect(estimateCostUsd('claude-opus-5', { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 })).toBeCloseTo(5)
    expect(estimateCostUsd('unknown-model', { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 })).toBeNull()
    expect(estimateCostUsd(null, { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 })).toBeNull()
  })
})
