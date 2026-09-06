import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { RESUME_PREFIX } from '../../shared/build'
import type { BuildRecord, AttemptMetrics, PhaseAttempt } from '../../shared/build'
import { resolveModels } from '../../shared/models'
import type { ChildStreamBoundary } from '../child-agents'
import type { Ledger } from '../ledger'
import { createCodexImplementProtocol } from './implement-codex'

const THREAD = '01a0746e-dcf6-7db1-8226-6e613b4fba02'
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-orch-'))
afterAll(() => fs.rmSync(home, { recursive: true, force: true }))

/** Codex's own running count, as it appends it to the session rollout. */
function rollout(input: number, cached: number, output: number): void {
  const dir = path.join(home, 'sessions', '2026', '09', '05')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, `rollout-2026-09-05T20-56-57-${THREAD}.jsonl`),
    `${JSON.stringify({
      type: 'event_msg',
      payload: { type: 'token_count', info: { total_token_usage: { input_tokens: input, cached_input_tokens: cached, cache_write_input_tokens: 0, output_tokens: output } } },
    })}\n`,
  )
}

/** `steps` run in order: a string is a stream line, a function mutates the rollout. */
function orchestratorAfter(prompt: string, steps: (string | (() => void))[]): AttemptMetrics['agents'][number] {
  return driveProtocol(prompt, steps).orchestrator()
}

function driveProtocol(prompt: string, steps: (string | (() => void))[]): {
  orchestrator: () => AttemptMetrics['agents'][number]
  outcomeError: () => Promise<string | null>
} {
  let metrics: AttemptMetrics | null = null
  let outcome: { error: string | null } | null = null
  let clock = 1_000_000
  const attempt = { id: 'build-1', round: 1, role: 'implement', prompt, createdAt: new Date(clock).toISOString() } as PhaseAttempt
  const parser = createCodexImplementProtocol({
    ledger: {
      getAttempt: () => attempt,
      patchAttempt: (_id: string, patch: { metrics?: AttemptMetrics }) => { if (patch.metrics) metrics = patch.metrics },
    } as unknown as Ledger,
    build: { id: 'build-1', models: resolveModels({ orchestratorModel: 'gpt-6-astra', subagentModel: 'gpt-5.6-sol' }, null) } as BuildRecord,
    attempt,
    gate: { suppress: true },
    childBoundary: {} as ChildStreamBoundary,
    now: () => clock,
    nowIso: () => new Date(clock).toISOString(),
    harnessHome: () => home,
    log: () => undefined,
    broadcast: () => undefined,
    finalize: async (_exit, collect) => { outcome = collect() },
  })
  for (const step of steps) {
    if (typeof step === 'string') parser.onLine!(step)
    else step()
  }
  clock += 60_000 // clear the 15s flush throttle
  parser.tick!()
  return {
    orchestrator: () => metrics!.agents.find((agent) => agent.id === 'orchestrator')!,
    /** Run the real finalize so the recorded outcome is the one the ledger sees. */
    outcomeError: async (): Promise<string | null> => {
      await parser.finalize!({ code: 0, timedOut: false, spawnError: null })
      return outcome?.error ?? null
    },
  }
}

const threadStarted = JSON.stringify({ type: 'thread.started', thread_id: THREAD })

describe('codex orchestrator accounting', () => {
  it('reports live usage from the session log before any turn completes', () => {
    // 24.6M tokens of real work; the stream will not report a byte of it until
    // the invocation ends, and a killed attempt never reports it at all.
    rollout(24_555_090, 24_170_368, 58_149)
    const orchestrator = orchestratorAfter('fresh prompt', [threadStarted])
    expect(orchestrator.tokens).toEqual({ input: 384_722, output: 58_149, cacheRead: 24_170_368, cacheWrite: 0 })
  })

  it('does not bill a resumed build for the tokens the interrupted build already carried', () => {
    rollout(1_000_000, 400_000, 20_000)
    const orchestrator = orchestratorAfter(`${RESUME_PREFIX}resumed prompt`, [
      threadStarted,
      // Only now does the resumed attempt add its own work to the same rollout.
      () => rollout(1_500_000, 600_000, 35_000),
    ])
    expect(orchestrator.tokens).toEqual({ input: 300_000, output: 15_000, cacheRead: 200_000, cacheWrite: 0 })
  })

  it('counts a fresh session in full, inheriting nothing', () => {
    rollout(500_000, 100_000, 9_000)
    const orchestrator = orchestratorAfter('fresh prompt', [threadStarted])
    expect(orchestrator.tokens).toEqual({ input: 400_000, output: 9_000, cacheRead: 100_000, cacheWrite: 0 })
  })

  it('does not report a reconnect the stream recovered from as the build failure', async () => {
    rollout(1_000, 0, 100)
    const driven = driveProtocol('fresh prompt', [
      threadStarted,
      // All five reconnects burn, then the CLI falls back to HTTPS and finishes.
      ...[2, 3, 4, 5].map((attempt) => JSON.stringify({
        type: 'error',
        message: `Reconnecting... ${attempt}/5 (stream disconnected before completion: websocket closed by server before response.completed)`,
      })),
      JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1_000, cached_input_tokens: 0, output_tokens: 100 } }),
    ])
    await expect(driven.outcomeError()).resolves.toBeNull()
  })
})
