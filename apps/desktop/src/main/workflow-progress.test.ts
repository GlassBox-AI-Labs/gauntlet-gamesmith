import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readWorkflowProgress, workflowDir } from './workflow-progress'

let dir: string | null = null

function withRun(run: unknown): string {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gauntlet-wf-'))
  fs.writeFileSync(path.join(dir, 'wf_abc123-def.json'), JSON.stringify(run))
  return dir
}

afterEach(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true })
  dir = null
})

// Shaped exactly like a real run file written by the workflow runtime.
const runFile = {
  runId: 'wf_abc123-def',
  workflowName: 'build-the-game',
  status: 'running',
  agentCount: 3,
  totalTokens: 900,
  totalToolCalls: 40,
  defaultModel: 'claude-opus-5',
  phases: [{ title: 'Build', detail: 'one agent per slice' }],
  workflowProgress: [
    { type: 'workflow_phase', index: 1, title: 'Build' },
    {
      type: 'workflow_agent',
      index: 1,
      label: 'rendering',
      phaseTitle: 'Build',
      agentId: 'a1',
      model: 'claude-opus-5',
      state: 'done',
      startedAt: 1787845178057,
      durationMs: 60_000,
      tokens: 500,
      toolCalls: 25,
      lastToolSummary: 'Wired up   the   deferred renderer',
    },
    {
      type: 'workflow_agent',
      index: 2,
      label: 'audio',
      phaseTitle: 'Build',
      agentId: 'a2',
      state: 'progress',
      startedAt: 1787845179000,
      tokens: 400,
      toolCalls: 15,
    },
  ],
}

describe('readWorkflowProgress', () => {
  it('turns workflow agents into metric rows', () => {
    const progress = readWorkflowProgress(withRun(runFile))
    expect(progress.runs).toEqual([
      { runId: 'wf_abc123-def', name: 'build-the-game', status: 'running', agentCount: 3, totalTokens: 900, totalToolCalls: 40 },
    ])
    expect(progress.totalTokens).toBe(900)
    expect(progress.agents).toHaveLength(2)

    const [first, second] = progress.agents
    expect(first.label).toBe('rendering')
    expect(first.phase).toBe('Build')
    expect(first.source).toBe('workflow')
    expect(first.done).toBe(true)
    expect(first.totalTokens).toBe(500)
    expect(first.toolCalls).toBe(25)
    // Collapsed whitespace, so a summary stays one line in the UI.
    expect(first.note).toBe('Wired up the deferred renderer')
    // The split has no source in this file, so it stays zeroed rather than guessed.
    expect(first.tokens).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })

    expect(second.done).toBe(false)
    expect(second.state).toBe('progress')
    // Falls back to the run's default when the entry names no model.
    expect(second.model).toBe('claude-opus-5')
  })

  it('gives every agent an id unique across workflows', () => {
    const progress = readWorkflowProgress(withRun(runFile))
    expect(new Set(progress.agents.map((a) => a.id)).size).toBe(progress.agents.length)
  })

  it('returns nothing when the orchestrator never ran a workflow', () => {
    expect(readWorkflowProgress('/no/such/dir')).toEqual({ runs: [], agents: [], totalTokens: 0 })
  })

  it('skips a file caught mid-write instead of throwing', () => {
    const d = withRun(runFile)
    fs.writeFileSync(path.join(d, 'wf_partial-write.json'), '{"runId":"wf_partial","workflowProg')
    const progress = readWorkflowProgress(d)
    expect(progress.runs).toHaveLength(1)
    expect(progress.agents).toHaveLength(2)
  })

  it('keys the directory by session id next to that session transcript', () => {
    expect(workflowDir('/home/.claude', '/Users/john/GauntletRuns/aaa-shooter', 'sess-1')).toBe(
      '/home/.claude/projects/-Users-john-GauntletRuns-aaa-shooter/sess-1/workflows',
    )
  })
})
