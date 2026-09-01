import { describe, expect, it } from 'vitest'
import { implementCostUsd, implementTokens } from './loop-runner'
import type { RunMetrics } from '../shared/loop'

const perModel = (entries: Record<string, number | null>): RunMetrics['perModel'] =>
  Object.fromEntries(
    Object.entries(entries).map(([model, costUsd]) => [
      model,
      { costUsd, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
    ]),
  )

describe('implementCostUsd', () => {
  it('sums modelUsage rather than trusting total_cost_usd', () => {
    // The real round-1 numbers: the CLI reported $5.11 for a run whose own
    // per-model accounting came to $14.39, because the workflow fan-out is
    // missing from total_cost_usd.
    const cost = implementCostUsd(perModel({ 'claude-opus-5': 14.2078105, 'claude-haiku-4-5-20251001': 0.177872 }), 5.112152, null)
    expect(cost).toBeCloseTo(14.3856825, 6)
  })

  it('matches the total it itemises, so header and rows agree', () => {
    const models = perModel({ a: 1.5, b: 2.25 })
    const total = Object.values(models).reduce((sum, m) => sum + (m.costUsd ?? 0), 0)
    expect(implementCostUsd(models, 99, null)).toBe(total)
  })

  it('falls back to the CLI figure when there is no per-model breakdown', () => {
    expect(implementCostUsd({}, 5.11, 2.0)).toBe(5.11)
  })

  it('falls back to the live estimate when the run reported no cost at all', () => {
    expect(implementCostUsd({}, null, 2.0)).toBe(2.0)
  })

  it('is null when nothing reported a cost', () => {
    expect(implementCostUsd({}, null, null)).toBeNull()
  })

  it('counts a zero-cost model instead of discarding the breakdown', () => {
    expect(implementCostUsd(perModel({ a: 0, b: 3 }), 99, null)).toBe(3)
  })
})

describe('implementTokens', () => {
  const usage = { input_tokens: 100, cache_read_input_tokens: 900, cache_creation_input_tokens: 0, output_tokens: 50 }

  it('counts the whole fan-out, not just the orchestrator thread', () => {
    // The CLI's per-model figures include every agent; result.usage does not,
    // so preferring usage made the live count collapse at the end of a round.
    const perModel = {
      'claude-opus-5': { costUsd: 14, tokens: { input: 1_000, output: 2_000, cacheRead: 30_000, cacheWrite: 500 } },
      'gpt-5.6-sol': { costUsd: 3, tokens: { input: 400, output: 100, cacheRead: 0, cacheWrite: 0 } },
    }
    expect(implementTokens(perModel, usage)).toEqual({ input: 31_900, output: 2_100 })
  })

  it('falls back to the orchestrator thread when the CLI reports no per-model split', () => {
    expect(implementTokens({}, usage)).toEqual({ input: 1_000, output: 50 })
  })

  it('reports nothing rather than zero when neither source knows', () => {
    expect(implementTokens({}, undefined)).toBeNull()
  })
})
