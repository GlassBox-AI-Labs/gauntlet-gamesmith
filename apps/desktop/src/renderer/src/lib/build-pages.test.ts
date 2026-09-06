import { describe, expect, it } from 'vitest'
import type { BuildSnapshot } from '../../../shared/build'
import { applySnapshotUpdate, olderAttemptPageOffset, pruneExpandedBuilds, pruneVisibleRoundCounts, selectSnapshotInList } from './build-pages'

function snapshot(offset: number, attemptIds: string[], totalAttempts = 500): BuildSnapshot {
  return {
    build: {
      id: '123e4567-e89b-42d3-a456-426614174000', title: 'Build', prompt: 'Goal', workspaceDir: '/tmp/project',
      maxRounds: 100, budgetUsd: null, models: { orchestratorModel: 'claude-opus-5', orchestratorEffort: 'high', subagentModel: null, subagentEffort: 'medium', criticModel: 'gpt-5.6-sol', criticEffort: 'high', researchModel: null, researchEffort: 'medium', assetModel: null, assetEffort: 'medium' },
      status: 'running', round: 100, totalCostUsd: 1, stopReason: null, playTrusted: true,
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    },
    attempts: attemptIds.map((id) => ({ id } as BuildSnapshot['attempts'][number])),
    attemptOffset: offset,
    totalAttempts,
    aggregate: { costUsd: 2, inputTokens: 3, outputTokens: 4 },
  }
}

describe('bounded build-page state', () => {
  it('hydrates a clicked build without promoting it to the top of the sidebar', () => {
    const newest = snapshot(0, ['newest-summary'])
    newest.build.id = 'newest'
    newest.build.createdAt = '2026-01-03T00:00:00.000Z'
    const middle = snapshot(0, [])
    middle.build.id = 'middle'
    middle.build.createdAt = '2026-01-02T00:00:00.000Z'
    const oldest = snapshot(0, ['oldest-summary'])
    oldest.build.id = 'oldest'
    oldest.build.createdAt = '2026-01-01T00:00:00.000Z'
    const selectedDetail = snapshot(0, ['middle-detail'])
    selectedDetail.build.id = 'middle'
    selectedDetail.build.createdAt = middle.build.createdAt

    const result = selectSnapshotInList([newest, middle, oldest], selectedDetail)

    expect(result.map((item) => item.build.id)).toEqual(['newest', 'middle', 'oldest'])
    expect(result[1]).toBe(selectedDetail)
    expect(result[0].attempts).toEqual([])
    expect(result[2].attempts).toEqual([])
  })

  it('preserves an older selected page across a live newest-page update', () => {
    const older = snapshot(200, ['older'])
    const live = snapshot(0, ['newest'], 501)
    live.build = { ...live.build, updatedAt: '2026-01-02T00:00:00.000Z' }
    const applied = applySnapshotUpdate(older, live)
    expect(applied.attempts.map((attempt) => attempt.id)).toEqual(['older'])
    expect(applied.totalAttempts).toBe(501)
    expect(applied.build.updatedAt).toBe('2026-01-02T00:00:00.000Z')
  })

  it('replaces the newest page and computes a bounded older-page cursor', () => {
    const current = snapshot(0, ['old-newest'])
    const live = snapshot(0, ['new-newest'], 501)
    expect(applySnapshotUpdate(current, live).attempts[0].id).toBe('new-newest')
    expect(olderAttemptPageOffset(snapshot(200, Array.from({ length: 200 }, (_, index) => String(index))))).toBe(400)
    expect(olderAttemptPageOffset(snapshot(400, Array.from({ length: 100 }, (_, index) => String(index))))).toBeNull()
  })

  it('prunes sidebar disclosure state to the bounded resident history page', () => {
    const current = snapshot(0, ['build'])
    current.build.id = 'current'
    current.attempts = Array.from({ length: 8 }, (_, index) => ({ id: `build-${index}`, round: index + 1 } as BuildSnapshot['attempts'][number]))

    expect([...pruneExpandedBuilds(new Set(['old-1', 'current', 'old-2']), [current])]).toEqual(['current'])
    expect(pruneVisibleRoundCounts({ 'old-1': 999, current: 999 }, [current], 3)).toEqual({ current: 8 })
  })
})
