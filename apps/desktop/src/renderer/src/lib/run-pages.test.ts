import { describe, expect, it } from 'vitest'
import type { LoopSnapshot } from '../../../shared/loop'
import { applySnapshotUpdate, olderRunPageOffset, pruneExpandedLoops, pruneVisibleRoundCounts } from './run-pages'

function snapshot(offset: number, runIds: string[], totalRuns = 500): LoopSnapshot {
  return {
    loop: {
      id: '123e4567-e89b-42d3-a456-426614174000', title: 'Loop', prompt: 'Goal', workspaceDir: '/tmp/project',
      maxRounds: 100, budgetUsd: null, models: { orchestratorModel: 'claude-opus-5', orchestratorEffort: 'high', subagentModel: null, subagentEffort: 'medium', criticModel: 'gpt-5.6-sol', criticEffort: 'high', researchModel: null, researchEffort: 'medium', assetModel: null, assetEffort: 'medium' },
      status: 'running', round: 100, totalCostUsd: 1, stopReason: null, playTrusted: true,
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    },
    runs: runIds.map((id) => ({ id } as LoopSnapshot['runs'][number])),
    runOffset: offset,
    totalRuns,
    aggregate: { costUsd: 2, inputTokens: 3, outputTokens: 4 },
  }
}

describe('bounded run-page state', () => {
  it('preserves an older selected page across a live newest-page update', () => {
    const older = snapshot(200, ['older'])
    const live = snapshot(0, ['newest'], 501)
    live.loop = { ...live.loop, updatedAt: '2026-01-02T00:00:00.000Z' }
    const applied = applySnapshotUpdate(older, live)
    expect(applied.runs.map((run) => run.id)).toEqual(['older'])
    expect(applied.totalRuns).toBe(501)
    expect(applied.loop.updatedAt).toBe('2026-01-02T00:00:00.000Z')
  })

  it('replaces the newest page and computes a bounded older-page cursor', () => {
    const current = snapshot(0, ['old-newest'])
    const live = snapshot(0, ['new-newest'], 501)
    expect(applySnapshotUpdate(current, live).runs[0].id).toBe('new-newest')
    expect(olderRunPageOffset(snapshot(200, Array.from({ length: 200 }, (_, index) => String(index))))).toBe(400)
    expect(olderRunPageOffset(snapshot(400, Array.from({ length: 100 }, (_, index) => String(index))))).toBeNull()
  })

  it('prunes sidebar disclosure state to the bounded resident history page', () => {
    const current = snapshot(0, ['run'])
    current.loop.id = 'current'
    current.runs = Array.from({ length: 8 }, (_, index) => ({ id: `run-${index}`, round: index + 1 } as LoopSnapshot['runs'][number]))

    expect([...pruneExpandedLoops(new Set(['old-1', 'current', 'old-2']), [current])]).toEqual(['current'])
    expect(pruneVisibleRoundCounts({ 'old-1': 999, current: 999 }, [current], 3)).toEqual({ current: 8 })
  })
})
