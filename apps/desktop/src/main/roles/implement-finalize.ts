import type { LoopRecord, RunMetrics, RunRecord } from '../../shared/loop'
import { buildCriticPrompt } from '../../shared/prompts'
import { harnessFor } from '../../shared/models'
import type { Ledger } from '../ledger'
import { planCompletion } from '../round-planner'
import { captureRoundRevision } from '../round-revision'
import { commitRunningAttempt } from '../run-transition'
import type { ExitInfo } from './types'

export interface ImplementOutcome {
  metrics: RunMetrics
  costUsd: number | null
  costSource: string | null
  tokens: { input: number; output: number } | null
  numTurns: number | null
  sessionId: string | null
  summary: string | null
  error: string | null
  logResult: Record<string, unknown> | null
}

interface TerminalLog {
  kind: string
  text: string
}

export interface ImplementFinalizeRuntime {
  ledger: Ledger
  loop: LoopRecord
  run: RunRecord
  now(): number
  nowIso(): string
  /** null when the loop skipped the Reference Study. */
  referenceDir: string
  awaitChildren(): Promise<void>
  isStopRequested(): boolean
  finishCancelled(exit: ExitInfo, reason: string, terminalLog: TerminalLog): boolean
  verifyCritiqueTree(terminalLog: TerminalLog): boolean
  retryRateLimit(error: string, terminalLog: TerminalLog): Promise<boolean>
  failAttempt(error: string, reason: string, terminalLog: TerminalLog): void
  verifyReference(terminalLog: TerminalLog): boolean
  persistLog(kind: string, text: string): void
  notifyPersistedLog(kind: string, text: string): void
  persistLoopTerminal(status: 'exhausted' | 'stopped', reason: string): void
  finishLoop(status: 'exhausted' | 'stopped', reason: string): void
  broadcast(): void
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

/** One bounded terminal accounting record, including every visible agent/model row. */
function metricsText(outcome: ImplementOutcome): string {
  const durationMs = nonNegativeInteger(outcome.logResult?.duration_ms)
  const turnCount = nonNegativeInteger(outcome.logResult?.num_turns)
  const duration = durationMs === null ? '?' : `${Math.round(durationMs / 60_000)}m`
  const turns = turnCount ?? '?'
  const lines = [
    `▤ implement metrics: ${outcome.costUsd !== null ? `$${outcome.costUsd.toFixed(2)} equivalent API cost (${outcome.costSource ?? 'source unavailable'})` : 'equivalent API cost n/a'} · ${turns} turns · ${duration}`,
  ]
  for (const agent of outcome.metrics.agents) {
    const tokens = agent.tokens
    const indent = agent.id === 'orchestrator' ? '  ' : agent.parentId && agent.parentId !== 'orchestrator' ? '        ↳ ' : '    ↳ '
    lines.push(
      `${indent}${agent.label} (${agent.model ?? '?'}): ${agent.messages} msgs · in ${formatTokens(tokens.input)} · out ${formatTokens(tokens.output)} · cache r/w ${formatTokens(tokens.cacheRead)}/${formatTokens(tokens.cacheWrite)}`,
    )
  }
  for (const [model, usage] of Object.entries(outcome.metrics.perModel)) {
    lines.push(
      `  ${model}: ${usage.costUsd !== null ? `$${usage.costUsd.toFixed(2)}` : '$?'} · in ${formatTokens(usage.tokens.input)} · out ${formatTokens(usage.tokens.output)}`,
    )
  }
  return lines.join('\n')
}

/**
 * Own the complete implement terminal protocol: final accounting, boundary
 * checks, immutable revision capture, and the next critique/terminal row.
 */
export async function finalizeImplement(
  runtime: ImplementFinalizeRuntime,
  exit: ExitInfo,
  collect: () => ImplementOutcome,
): Promise<void> {
  const { ledger, loop, run } = runtime
  if (ledger.getRun(run.id)?.status !== 'running') return
  let outcome = collect()
  if (!outcome.error && !runtime.isStopRequested() && !exit.timedOut) {
    await runtime.awaitChildren()
    outcome = collect()
  }
  const projection = ledger.getRun(run.id)?.metrics?.projection
  ledger.patchRun(run.id, {
    metrics: { ...outcome.metrics, ...(projection ? { projection } : {}) },
    costUsd: outcome.costUsd,
    costSource: outcome.costSource,
    inputTokens: outcome.tokens?.input,
    outputTokens: outcome.tokens?.output,
    numTurns: outcome.numTurns,
    durationMs: runtime.now() - Date.parse(ledger.getRun(run.id)?.startedAt ?? run.createdAt),
    sessionId: outcome.sessionId,
    summary: outcome.summary,
    finishedAt: runtime.nowIso(),
  })
  const terminalMetric = { kind: 'metric', text: metricsText(outcome) }

  if (runtime.finishCancelled(exit, 'Implement run timed out.', terminalMetric)) return
  if (!runtime.verifyCritiqueTree(terminalMetric)) return
  if (outcome.error) {
    if (await runtime.retryRateLimit(outcome.error, terminalMetric)) return
    runtime.failAttempt(outcome.error, `Implement run failed: ${outcome.error}`, terminalMetric)
    return
  }
  if (!runtime.verifyReference(terminalMetric)) return

  let revision: string
  try {
    const parentRevision = ledger.previousImplementRevision(loop.id, run.round)
    revision = captureRoundRevision({ workspaceDir: loop.workspaceDir, loopId: loop.id, round: run.round, parentRevision })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    runtime.failAttempt(
      `Could not commit round revision: ${message}`,
      `Round ${run.round} finished, but its Git revision could not be saved: ${message}`,
      terminalMetric,
    )
    return
  }

  const latestLoop = ledger.getLoop(loop.id)
  const projectedCost = (latestLoop?.totalCostUsd ?? 0) + (outcome.costUsd ?? 0)
  const budgetExceeded = !!latestLoop?.budgetUsd && projectedCost >= latestLoop.budgetUsd
  const plan = planCompletion({ role: 'implement', round: run.round, maxRounds: loop.maxRounds, budgetExceeded })
  const terminalReason = plan.kind === 'finish-budget'
    ? `Budget ceiling hit: $${projectedCost.toFixed(2)} of $${latestLoop!.budgetUsd!.toFixed(2)} (equivalent API cost).`
    : plan.kind === 'finish-exhausted'
      ? `Max rounds (${loop.maxRounds}) reached after round ${run.round} — no critique, since no round is left for it to gate.`
      : null
  const revisionMessage = `Round ${run.round} committed at revision ${revision}.`
  const applied = commitRunningAttempt(ledger, loop.id, run.id, { status: 'succeeded', revision }, () => {
    runtime.persistLog(terminalMetric.kind, terminalMetric.text)
    runtime.persistLog('artifact', revisionMessage)
    if (plan.kind === 'queue-critique') {
      const critique = ledger.createRun({
        loopId: loop.id,
        round: plan.round,
        role: 'critique',
        harness: harnessFor(loop.models.criticModel),
        prompt: buildCriticPrompt(loop.prompt, plan.round, runtime.referenceDir, revision, 'verdict.json', '', loop.models.referenceMode),
      })
      ledger.patchRun(critique.id, { revision })
    } else if (terminalReason) {
      runtime.persistLoopTerminal(plan.kind === 'finish-exhausted' ? 'exhausted' : 'stopped', terminalReason)
    }
  })
  if (!applied) return
  runtime.notifyPersistedLog(terminalMetric.kind, terminalMetric.text)
  runtime.notifyPersistedLog('artifact', revisionMessage)
  if (plan.kind === 'finish-budget') runtime.finishLoop('stopped', terminalReason!)
  else if (plan.kind === 'finish-exhausted') runtime.finishLoop('exhausted', terminalReason!)
  else runtime.broadcast()
}
