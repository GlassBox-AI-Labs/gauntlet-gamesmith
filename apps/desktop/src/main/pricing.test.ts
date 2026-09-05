import { describe, expect, it } from 'vitest'
import { AGENT_MODEL_CHOICES } from '../shared/models'
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
    expect(estimateCostUsd('claude-opus-5-20260901', { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 })).toBeCloseTo(5)
    expect(estimateCostUsd('unknown-model', { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 })).toBeNull()
    expect(estimateCostUsd('proxy/gpt-5.6-sol', { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 })).toBeNull()
    expect(estimateCostUsd('gpt-5.6-solar', { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 })).toBeNull()
    expect(estimateCostUsd(null, { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 })).toBeNull()
  })

  it('gives Fable 5.1 its own cache-read rate, not the Fable 5 one', () => {
    // 5.1 reads cache at 2.5% of input, not the 10% every other model uses.
    // 10M cache read is $2.50 on 5.1 and $10 on 5 — the prefix match has to
    // find the longer key first or this silently bills 4x.
    const tokens = { input: 0, output: 0, cacheRead: 10_000_000, cacheWrite: 0 }
    expect(estimateCostUsd('claude-fable-5-1', tokens)).toBeCloseTo(2.5, 5)
    expect(estimateCostUsd('claude-fable-5', tokens)).toBeCloseTo(10, 5)
  })

  it('prices Fable 5.1 input and output at the Fable rate', () => {
    // 1M in ($10) + 100k out ($5) + 500k cache write at the 1h TTL ($10)
    const cost = estimateCostUsd('claude-fable-5-1', { input: 1_000_000, output: 100_000, cacheRead: 0, cacheWrite: 500_000 })
    expect(cost).toBeCloseTo(10 + 5 + 10, 5)
  })

  it('prices Sonnet 5 at the standard rate the introductory price became', () => {
    expect(estimateCostUsd('claude-sonnet-5', { input: 1_000_000, output: 1_000_000, cacheRead: 0, cacheWrite: 0 })).toBeCloseTo(12, 5)
  })

  it('has a price row for every selectable model except Astra pending verified rates', () => {
    for (const model of AGENT_MODEL_CHOICES) {
      if (model.id === 'gpt-6-astra') continue
      expect(estimateCostUsd(model.id, { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 }), model.id).not.toBeNull()
    }
  })
})


it('leaves Astra cost unavailable until its rate is verified', () => {
  expect(estimateCostUsd('gpt-6-astra', { input: 100, output: 100, cacheRead: 0, cacheWrite: 0 })).toBeNull()
})
