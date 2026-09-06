import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { RESUME_PREFIX } from '../../shared/loop'
import type { LoopRecord, RunMetrics, RunRecord } from '../../shared/loop'
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
function orchestratorAfter(prompt: string, steps: (string | (() => void))[]): RunMetrics['agents'][number] {
  let metrics: RunMetrics | null = null
  let clock = 1_000_000
  const run = { id: 'run-1', round: 1, role: 'implement', prompt, createdAt: new Date(clock).toISOString() } as RunRecord
  const parser = createCodexImplementProtocol({
    ledger: {
      getRun: () => run,
      patchRun: (_id: string, patch: { metrics?: RunMetrics }) => { if (patch.metrics) metrics = patch.metrics },
    } as unknown as Ledger,
    loop: { id: 'loop-1', models: resolveModels({ orchestratorModel: 'gpt-6-astra', subagentModel: 'gpt-5.6-sol' }, null) } as LoopRecord,
    run,
    gate: { suppress: true },
    childBoundary: {} as ChildStreamBoundary,
    now: () => clock,
    nowIso: () => new Date(clock).toISOString(),
    harnessHome: () => home,
    log: () => undefined,
    broadcast: () => undefined,
    finalize: async () => undefined,
  })
  for (const step of steps) {
    if (typeof step === 'string') parser.onLine!(step)
    else step()
  }
  clock += 60_000 // clear the 15s flush throttle
  parser.tick!()
  return metrics!.agents.find((agent) => agent.id === 'orchestrator')!
}

const threadStarted = JSON.stringify({ type: 'thread.started', thread_id: THREAD })

describe('codex orchestrator accounting', () => {
  it('reports live usage from the session log before any turn completes', () => {
    // 24.6M tokens of real work; the stream will not report a byte of it until
    // the invocation ends, and a killed run never reports it at all.
    rollout(24_555_090, 24_170_368, 58_149)
    const orchestrator = orchestratorAfter('fresh prompt', [threadStarted])
    expect(orchestrator.tokens).toEqual({ input: 384_722, output: 58_149, cacheRead: 24_170_368, cacheWrite: 0 })
  })

  it('does not bill a resumed run for the tokens the interrupted run already carried', () => {
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
})
