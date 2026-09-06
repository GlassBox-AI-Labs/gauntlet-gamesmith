import { describe, expect, it } from 'vitest'
import type { BuildRecord, PhaseAttempt } from '../shared/build'
import { boundedBuildSnapshot, IPC_BUILD_LIST_LIMIT, buildListPage } from './ipc-projection'

const build: BuildRecord = {
  id: '11111111-1111-4111-8111-111111111111', title: 'Test', prompt: 'goal', workspaceDir: '/tmp/project', maxRounds: 1,
  budgetUsd: null, models: { orchestratorModel: 'gpt-5.6-luna', orchestratorEffort: 'medium', subagentModel: null, subagentEffort: 'medium', criticModel: 'gpt-5.6-sol', criticEffort: 'high', researchModel: null, researchEffort: 'medium', assetModel: null, assetEffort: 'medium' },
  status: 'stopped', round: 1, totalCostUsd: 0, stopReason: null, playTrusted: true,
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
}

const attempt = (index: number, prompt = 'prompt'): PhaseAttempt => ({
  id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`, buildId: build.id, round: index, role: 'implement', harness: 'codex', status: 'succeeded', prompt,
  model: null, effort: null, cliVersion: null, priceTableVersion: null, costSource: null, promptSha256: null, accountLabel: null, machineLabel: null, authMode: null,
  summary: null, verdict: null, metrics: null, costUsd: null, inputTokens: null, outputTokens: null, numTurns: null, durationMs: null,
  sessionId: null, revision: null, error: null, createdAt: '2026-01-01T00:00:00.000Z', startedAt: null, finishedAt: null,
})

describe('IPC snapshot projection', () => {
  it('caps attempts and oversized prompt fields with a visible truncation marker', () => {
    const attempts = Array.from({ length: 250 }, (_, index) => attempt(index, index === 249 ? 'x'.repeat(100_000) : 'prompt'))
    const projected = boundedBuildSnapshot({ build, attempts })
    expect(projected.attempts).toHaveLength(200)
    expect(projected.attempts.at(-1)?.prompt).toHaveLength(64 * 1024)
    expect(projected.totalAttempts).toBe(250)
    expect(projected.hasMoreAttempts).toBe(true)
    expect(projected.projectionWarning).toMatch(/omitted/)
  })

  it('returns bounded summary-only list pages with an explicit total', () => {
    const builds = Array.from({ length: IPC_BUILD_LIST_LIMIT + 1 }, (_, index) => ({ ...build, id: `${index}` }))
    const page = buildListPage(builds.slice(0, IPC_BUILD_LIST_LIMIT), builds.length, 0, () => 50_000)
    expect(page.snapshots).toHaveLength(IPC_BUILD_LIST_LIMIT)
    expect(page.snapshots.every((snapshot) => snapshot.attempts.length === 0)).toBe(true)
    expect(page).toMatchObject({ total: IPC_BUILD_LIST_LIMIT + 1, offset: 0, hasMore: true })
  })
})
