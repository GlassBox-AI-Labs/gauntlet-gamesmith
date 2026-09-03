import { describe, expect, it } from 'vitest'
import { DEFAULT_CRITIC, resolveModels } from '../shared/models'
import { buildImplementMetrics, hasCliModelCost } from './implement-metrics'

const models = resolveModels(
  { orchestratorModel: 'claude-fable-5', subagentModel: 'gpt-5.6-sol', subagentEffort: 'high' },
  DEFAULT_CRITIC,
)

describe('buildImplementMetrics', () => {
  it('normalizes hostile CLI model-usage values instead of poisoning persisted totals', () => {
    const metrics = buildImplementMetrics({
      models,
      agentLabels: new Map(),
      messageUsage: new Map(),
      result: {
        modelUsage: {
          'claude-fable-5': {
            inputTokens: '9000',
            outputTokens: Number.NaN,
            cacheReadInputTokens: -4,
            cacheCreationInputTokens: Number.POSITIVE_INFINITY,
            costUSD: -10,
          },
        },
      },
    })

    expect(metrics.perModel['claude-fable-5']).toEqual({
      costUsd: null,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    })
  })

  it('accepts the bounded camelCase aggregate counters and canonicalizes model aliases', () => {
    const result = {
      modelUsage: {
        'claude-fable-5-20260801': {
          inputTokens: 11,
          outputTokens: 12,
          cacheReadInputTokens: 13,
          cacheCreationInputTokens: 14,
          costUSD: 1.25,
        },
      },
    }
    const metrics = buildImplementMetrics({ models, agentLabels: new Map(), messageUsage: new Map(), result })

    expect(metrics.perModel['claude-fable-5']).toEqual({
      costUsd: 1.25,
      tokens: { input: 11, output: 12, cacheRead: 13, cacheWrite: 14 },
    })
    expect(hasCliModelCost(result)).toBe(true)
  })

  it('caps hostile model and agent cardinality at the persisted schema limits', () => {
    const modelUsage: Record<string, { inputTokens: number; costUSD: number }> = Object.fromEntries(
      Array.from({ length: 200 }, (_, index) => [`unknown-model-${index}`, { inputTokens: 1, costUSD: 0 }]),
    )
    modelUsage['x'.repeat(257)] = { inputTokens: 99, costUSD: 99 }
    const agentLabels = new Map(
      Array.from({ length: 700 }, (_, index) => [`toolu_${index}`, { label: `agent ${index}`, model: null }]),
    )
    const metrics = buildImplementMetrics({ models, agentLabels, messageUsage: new Map(), result: { modelUsage } })

    expect(Object.keys(metrics.perModel)).toHaveLength(128)
    expect(Object.keys(metrics.perModel).every((model) => model.length <= 256)).toBe(true)
    expect(metrics.agents).toHaveLength(512)
  })

  it('derives dispatcher identity and nests a cross-harness child under its launcher', () => {
    const dispatcherId = 'toolu_dispatcher'
    const child = {
      id: 'child:gameplay',
      label: 'codex: gameplay',
      model: 'gpt-5.6-sol',
      messages: 1,
      tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
      firstTs: '2026-01-01T00:00:00.000Z',
      lastTs: '2026-01-01T00:00:01.000Z',
    }
    const metrics = buildImplementMetrics({
      models,
      agentLabels: new Map([[dispatcherId, { label: 'Gameplay', model: null }]]),
      messageUsage: new Map(),
      result: null,
      childAgents: [child],
      childParents: new Map([['gameplay', dispatcherId]]),
    })

    expect(metrics.agents.find((agent) => agent.id === dispatcherId)).toMatchObject({
      label: 'Gameplay (dispatcher)',
      model: 'claude-sonnet-5',
    })
    expect(metrics.agents.findIndex((agent) => agent.id === child.id)).toBe(
      metrics.agents.findIndex((agent) => agent.id === dispatcherId) + 1,
    )
  })
})
