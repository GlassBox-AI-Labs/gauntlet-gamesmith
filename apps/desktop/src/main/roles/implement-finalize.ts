import type { BuildRecord, AttemptMetrics, PhaseAttempt } from '../../shared/build'
import { buildCriticPrompt } from '../../shared/prompts'
import { harnessFor } from '../../shared/models'
import type { Ledger } from '../ledger'
import { planCompletion } from '../round-planner'
import { captureRoundRevision } from '../round-revision'
import { commitRunningAttempt } from '../attempt-transition'
import { LeadContinuity } from '../lead-continuity'
import type { ExitInfo } from './types'

export interface ImplementOutcome {
  metrics: AttemptMetrics
  costUsd: number | null
  costSource: string | null
  tokens: { input: number; output: number } | null
  numTurns: number | null
  sessionId: string | null
  summary: string | null
  error: string | null
  logResult: Record<string, unknown> | null
  /** Full final response is parsed into bounded memory; it is never sent over IPC verbatim. */
  leadResponse?: string | null
  sessionUnavailable?: boolean
}

interface TerminalLog {
  kind: string
  text: string
}

export interface ImplementFinalizeRuntime {
  ledger: Ledger
  build: BuildRecord
  attempt: PhaseAttempt
  now(): number
  nowIso(): string
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
  persistBuildTerminal(status: 'exhausted' | 'stopped', reason: string): void
  finishBuild(status: 'exhausted' | 'stopped', reason: string): void
  broadcast(): void
  copyRetryEvidence?(attemptId: string): void
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
  const { ledger, build, attempt } = runtime
  if (ledger.getAttempt(attempt.id)?.status !== 'running') return
  let outcome = collect()
  if (!outcome.error && !runtime.isStopRequested() && !exit.timedOut) {
    await runtime.awaitChildren()
    outcome = collect()
  }
  const projection = ledger.getAttempt(attempt.id)?.metrics?.projection
  ledger.patchAttempt(attempt.id, {
    metrics: { ...outcome.metrics, ...(projection ? { projection } : {}) },
    costUsd: outcome.costUsd,
    costSource: outcome.costSource,
    inputTokens: outcome.tokens?.input,
    outputTokens: outcome.tokens?.output,
    numTurns: outcome.numTurns,
    durationMs: runtime.now() - Date.parse(ledger.getAttempt(attempt.id)?.startedAt ?? attempt.createdAt),
    sessionId: outcome.sessionId,
    summary: outcome.summary,
    finishedAt: runtime.nowIso(),
  })
  const terminalMetric = { kind: 'metric', text: metricsText(outcome) }

  const lead = new LeadContinuity(ledger)
  const checkpoint = lead.checkpoint(attempt, outcome.leadResponse ?? outcome.summary)
  if (checkpoint) {
    const message = checkpoint.warning ?? `Saved the lead notebook for round ${attempt.round}.`
    runtime.persistLog(checkpoint.warning ? 'error' : 'system', message)
    runtime.notifyPersistedLog(checkpoint.warning ? 'error' : 'system', message)
  }

  if (runtime.finishCancelled(exit, 'Implement attempt timed out.', terminalMetric)) return
  if (!runtime.verifyCritiqueTree(terminalMetric)) return
  if (outcome.error) {
    if (lead.recoverUnavailableSession(attempt, outcome.sessionUnavailable === true, runtime.copyRetryEvidence)) {
      runtime.persistLog(terminalMetric.kind, terminalMetric.text)
      runtime.notifyPersistedLog(terminalMetric.kind, terminalMetric.text)
      const message = 'Saved lead session was unavailable. Recovery is queued from durable memory with the same frozen steering requirements.'
      runtime.persistLog('system', message)
      runtime.notifyPersistedLog('system', message)
      runtime.broadcast()
      return
    }
    if (await runtime.retryRateLimit(outcome.error, terminalMetric)) return
    runtime.failAttempt(outcome.error, `Implement build failed: ${outcome.error}`, terminalMetric)
    return
  }
  if (!runtime.verifyReference(terminalMetric)) return

  let revision: string
  try {
    const parentRevision = ledger.previousImplementRevision(build.id, attempt.round)
    revision = captureRoundRevision({ workspaceDir: build.workspaceDir, buildId: build.id, round: attempt.round, parentRevision })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    runtime.failAttempt(
      `Could not commit round revision: ${message}`,
      `Round ${attempt.round} finished, but its Git revision could not be saved: ${message}`,
      terminalMetric,
    )
    return
  }

  const latestBuild = ledger.getBuild(build.id)
  const projectedCost = (latestBuild?.totalCostUsd ?? 0) + (outcome.costUsd ?? 0)
  const budgetExceeded = !!latestBuild?.budgetUsd && projectedCost >= latestBuild.budgetUsd
  const plan = planCompletion({ role: 'implement', round: attempt.round, maxRounds: build.maxRounds, budgetExceeded })
  const terminalReason = plan.kind === 'finish-budget'
    ? `Budget ceiling hit: $${projectedCost.toFixed(2)} of $${latestBuild!.budgetUsd!.toFixed(2)} (equivalent API cost).`
    : plan.kind === 'finish-exhausted'
      ? `Max rounds (${build.maxRounds}) reached after round ${attempt.round} — no critique, since no round is left for it to gate.`
      : null
  const revisionMessage = `Round ${attempt.round} committed at revision ${revision}.`
  const applied = commitRunningAttempt(ledger, build.id, attempt.id, { status: 'succeeded', revision }, () => {
    runtime.persistLog(terminalMetric.kind, terminalMetric.text)
    runtime.persistLog('artifact', revisionMessage)
    if (plan.kind === 'queue-critique') {
      const critique = ledger.createAttempt({
        buildId: build.id,
        round: plan.round,
        role: 'critique',
        harness: harnessFor(build.models.criticModel),
        prompt: buildCriticPrompt(build.prompt, plan.round, runtime.referenceDir, revision),
      })
      ledger.patchAttempt(critique.id, { revision })
    } else if (terminalReason) {
      runtime.persistBuildTerminal(plan.kind === 'finish-exhausted' ? 'exhausted' : 'stopped', terminalReason)
    }
  })
  if (!applied) return
  runtime.notifyPersistedLog(terminalMetric.kind, terminalMetric.text)
  runtime.notifyPersistedLog('artifact', revisionMessage)
  if (plan.kind === 'finish-budget') runtime.finishBuild('stopped', terminalReason!)
  else if (plan.kind === 'finish-exhausted') runtime.finishBuild('exhausted', terminalReason!)
  else runtime.broadcast()
}
