import { describe, expect, it } from 'vitest'
import { AGENT_MODEL_CHOICES } from '../shared/models'
import { equivalentCostUsd, estimateCostUsd } from './pricing'

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

  it('has a price row for every selectable model', () => {
    for (const model of AGENT_MODEL_CHOICES) {
      expect(estimateCostUsd(model.id, { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 }), model.id).not.toBeNull()
    }
  })

  it('prices grok-4.6 at the published list rate', () => {
    // $2 uncached / $0.50 cache / $6 out per MTok
    expect(
      estimateCostUsd('grok-4.6', { input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite: 0 }),
    ).toBeCloseTo(8.5, 5)
  })

  it('prices grok-4.5 cache reads cheaper than grok-4.6', () => {
    const cache = { input: 0, output: 0, cacheRead: 10_000_000, cacheWrite: 0 }
    expect(estimateCostUsd('grok-4.5', cache)).toBeCloseTo(3, 5)
    expect(estimateCostUsd('grok-4.6', cache)).toBeCloseTo(5, 5)
  })

  it('treats grok-4.6-build as grok-4.6, not as an unknown model', () => {
    expect(estimateCostUsd('grok-4.6-build', { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 })).toBeCloseTo(2, 5)
  })
})

describe('equivalentCostUsd', () => {
  it('reprices a grok run from tokens and ignores the CLI tick total', () => {
    // Real round-1 implement: CLI ticks said $6.55; list on the same split is ~$29.
    const cost = equivalentCostUsd({
      costUsd: 6.55028152,
      model: 'grok-4.6',
      metrics: {
        agents: [],
        perModel: {
          'grok-4.6-build': {
            costUsd: 6.55028152,
            tokens: { input: 2_275_530, output: 376_493, cacheRead: 44_670_080, cacheWrite: 0 },
          },
        },
      },
    })
    expect(cost).toBeCloseTo((2_275_530 * 2 + 44_670_080 * 0.5 + 376_493 * 6) / 1_000_000, 5)
  })

  it('prices agent rows when the run stored no per-model cost', () => {
    const cost = equivalentCostUsd({
      costUsd: null,
      model: 'grok-4.6',
      metrics: {
        perModel: {},
        agents: [
          {
            id: 'orchestrator',
            label: 'orchestrator',
            model: 'grok-4.6',
            messages: 1,
            tokens: { input: 100_000, output: 10_000, cacheRead: 0, cacheWrite: 0 },
            firstTs: null,
            lastTs: null,
            costUsd: null,
          },
        ],
      },
    })
    expect(cost).toBeCloseTo((100_000 * 2 + 10_000 * 6) / 1_000_000, 5)
  })
})
