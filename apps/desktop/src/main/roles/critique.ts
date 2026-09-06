import type { AgentMetric, BuildRecord, PhaseAttempt } from '../../shared/build'
import { buildCriticPrompt } from '../../shared/prompts'
import { harnessFor } from '../../shared/models'
import { createArtifactPhaseStream } from '../artifact-phase-stream'
import type { Ledger } from '../ledger'
import { estimateCostUsd, PRICE_TABLE_VERSION } from '../pricing'
import { scanCritiqueArtifacts } from '../report'
import { planCompletion } from '../round-planner'
import { workspaceMatchesRevision } from '../round-revision'
import { commitRunningAttempt } from '../attempt-transition'
import { readVerdictArtifact } from '../verdict'
import type { ExitInfo, LogGate, StreamParser } from './types'

interface CritiqueRoleRuntime {
  ledger: Ledger
  build: BuildRecord
  attempt: PhaseAttempt
  gate: LogGate
  referenceDir: string
  maxAttempts: number
  now(): number
  nowIso(): string
  log(kind: string, text: string, agentId?: string): void
  persistLog(kind: string, text: string): void
  notifyPersistedLog(kind: string, text: string): void
  broadcast(): void
  finishCancelled(exit: ExitInfo, reason: string, terminalLog: { kind: string; text: string }): boolean
  verifyReference(terminalLog: { kind: string; text: string }): boolean
  failOrRetry(error: string, label: string, maxAttempts: number, prompt: string, terminalLog: { kind: string; text: string }): Promise<void>
  overBudget(): boolean
  finishBuild(status: 'passed' | 'exhausted' | 'stopped' | 'failed', reason: string): void
  persistBuildTerminal(status: 'passed' | 'exhausted' | 'stopped' | 'failed', reason: string): void
  implementPrompt(round: number, verdict: NonNullable<PhaseAttempt['verdict']>): string
}

function trunc(value: string, max: number): string {
  const flat = value.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

function bestScore(ledger: Ledger, buildId: string): number {
  return ledger.bestVerdictScore(buildId)
}

/** Owns the complete critic stream, verdict validation, and next-round protocol. */
export function createCritiqueProtocol(runtime: CritiqueRoleRuntime): StreamParser {
  const { ledger, build, attempt, gate } = runtime
  const models = build.models
  const startedAtMs = Date.parse(ledger.getAttempt(attempt.id)?.startedAt ?? attempt.createdAt)
  const plog = (kind: string, text: string, agentId?: string): void => {
    if (!gate.suppress) runtime.log(kind, text, agentId)
  }
  const stream = createArtifactPhaseStream({
    harness: attempt.harness,
    phase: 'critique',
    defaultModel: models.criticModel,
    startedAtMs,
    initialSessionId: ledger.getAttempt(attempt.id)?.sessionId,
    now: runtime.now,
    log: plog,
    onIdentity: (sessionId, reportedModel) => {
      ledger.patchAttempt(attempt.id, { sessionId, ...(reportedModel ? { model: reportedModel } : {}) })
    },
    onUsage: () => flush(),
  })

  function flush(): void {
    const state = stream.snapshot()
    const billedModel = state.reportedModel ?? models.criticModel
    ledger.patchAttempt(attempt.id, {
      inputTokens: state.tokens.input + state.tokens.cacheRead + state.tokens.cacheWrite,
      outputTokens: state.tokens.output,
      costUsd: estimateCostUsd(billedModel, state.tokens),
      costSource: `price_table:${PRICE_TABLE_VERSION}`,
      metrics: {
        agents: [
          {
            id: 'critic',
            label: 'critic (fresh eyes)',
            model: billedModel,
            messages: state.messages,
            tokens: state.tokens,
            firstTs: new Date(startedAtMs).toISOString(),
            lastTs: runtime.nowIso(),
          },
        ],
        perModel: {},
      },
    })
    runtime.broadcast()
  }

  const finalize = async (exit: ExitInfo): Promise<void> => {
    if (ledger.getAttempt(attempt.id)?.status !== 'running') return
    const artifact = attempt.revision
      ? readVerdictArtifact(build.workspaceDir, attempt.round, attempt.id, startedAtMs, attempt.revision, runtime.now())
      : { verdict: null, error: 'Critique attempt has no implementation revision binding.' }
    const verdict = artifact.verdict
    const state = stream.snapshot()
    const billedModel = state.reportedModel ?? models.criticModel
    const verdictText = verdict?.summary ?? state.summary
    if (artifact.error) plog('error', `Verdict artifact rejected: ${artifact.error}`)
    else plog('system', `Validated fresh verdict artifact for revision ${attempt.revision?.slice(0, 12)}.`)
    const durationMs = runtime.now() - startedAtMs
    const criticAgent: AgentMetric = {
      id: 'critic',
      label: 'critic (fresh eyes)',
      model: billedModel,
      messages: state.messages,
      tokens: state.tokens,
      firstTs: new Date(startedAtMs).toISOString(),
      lastTs: runtime.nowIso(),
    }
    const criticCost = state.sawUsage ? estimateCostUsd(billedModel, state.tokens) : null
    ledger.patchAttempt(attempt.id, {
      metrics: {
        agents: [criticAgent],
        perModel: state.sawUsage ? { [billedModel]: { costUsd: criticCost, tokens: state.tokens } } : {},
        ...(ledger.getAttempt(attempt.id)?.metrics?.projection ? { projection: ledger.getAttempt(attempt.id)!.metrics!.projection } : {}),
      },
      inputTokens: state.sawUsage ? state.tokens.input + state.tokens.cacheRead + state.tokens.cacheWrite : null,
      outputTokens: state.sawUsage ? state.tokens.output : null,
      costUsd: criticCost,
      costSource: criticCost === null ? null : `price_table:${PRICE_TABLE_VERSION}`,
      durationMs,
      summary: verdictText ? verdictText.slice(0, 4000) : null,
      verdict: null,
      finishedAt: runtime.nowIso(),
    })
    const terminalMetric = {
      kind: 'metric',
      text: `▤ critique metrics: ${criticCost != null ? `$${criticCost.toFixed(2)} equivalent API cost (price_table:${PRICE_TABLE_VERSION}) · ` : 'equivalent API cost n/a · '}in ${formatTokens(state.tokens.input + state.tokens.cacheRead)} · out ${formatTokens(state.tokens.output)} · ${Math.round(durationMs / 60_000)}m`,
    }

    if (runtime.finishCancelled(exit, 'Critique attempt timed out.', terminalMetric)) return
    if (state.failure || exit.spawnError || (exit.code !== 0 && exit.code !== null) || !verdict) {
      const error = exit.spawnError ?? state.rateLimitNotice ?? state.failure ?? (verdict ? `${attempt.harness} exited ${exit.code}` : `${artifact.error ?? 'invalid verdict artifact'} (exit ${exit.code})`)
      await runtime.failOrRetry(error, 'Critique', runtime.maxAttempts, buildCriticPrompt(build.prompt, attempt.round, runtime.referenceDir, attempt.revision ?? '<missing-revision>', 'verdict.json', '', build.models.referenceMode), terminalMetric)
      return
    }
    if (!runtime.verifyReference(terminalMetric)) return
    if (!attempt.revision || !workspaceMatchesRevision(build.workspaceDir, build.id, attempt.revision)) {
      runtime.log('error', `Stale verdict rejected: workspace changed while critic judged revision ${attempt.revision ?? 'unknown'}.`)
      const applied = commitRunningAttempt(ledger, build.id, attempt.id, { status: 'failed', verdict: null, error: 'Workspace changed during critique.' }, () => {
        runtime.persistLog(terminalMetric.kind, terminalMetric.text)
        runtime.persistBuildTerminal('failed', `Round ${attempt.round} changed during critique; its verdict was not applied.`)
      })
      if (applied) {
        runtime.notifyPersistedLog(terminalMetric.kind, terminalMetric.text)
        runtime.finishBuild('failed', `Round ${attempt.round} changed during critique; its verdict was not applied.`)
      }
      return
    }

    const latestBuild = ledger.getBuild(build.id)
    const projectedCost = (latestBuild?.totalCostUsd ?? 0) + (criticCost ?? 0)
    const budgetExceeded = !!latestBuild?.budgetUsd && projectedCost >= latestBuild.budgetUsd
    const plan = planCompletion({ role: 'critique', round: attempt.round, maxRounds: build.maxRounds, budgetExceeded, verdictPass: verdict.pass })
    const terminalReason = plan.kind === 'finish-passed'
      ? `Critic passed the build with score ${verdict.score.toFixed(2)} after round ${attempt.round}.`
      : plan.kind === 'finish-exhausted'
        ? `Max rounds (${build.maxRounds}) reached. Best score: ${Math.max(bestScore(ledger, build.id), verdict.score).toFixed(2)}.`
        : plan.kind === 'finish-budget'
          ? `Budget ceiling hit: $${projectedCost.toFixed(2)} of $${latestBuild!.budgetUsd!.toFixed(2)} (equivalent API cost).`
          : null
    const verdictLines = [
      `★ score ${verdict.score.toFixed(2)}/1.00 ${verdict.pass ? '— PASS' : '— not there yet'} · ${trunc(verdict.summary, 300)}`,
      ...verdict.findings.slice(0, 12).map((finding) => `  · [${finding.severity}] ${trunc(finding.text, 240)}`),
      ...(verdict.findings.length > 12 ? [`  · …and ${verdict.findings.length - 12} more findings`] : []),
    ]
    const applied = commitRunningAttempt(ledger, build.id, attempt.id, { status: 'succeeded', verdict }, () => {
      runtime.persistLog(terminalMetric.kind, terminalMetric.text)
      if (plan.kind === 'queue-implement') {
        ledger.patchBuild(build.id, { round: plan.round })
        ledger.createAttempt({
          buildId: build.id,
          round: plan.round,
          role: 'implement',
          harness: harnessFor(build.models.orchestratorModel),
          prompt: runtime.implementPrompt(plan.round, verdict),
        })
      } else if (terminalReason) {
        runtime.persistBuildTerminal(
          plan.kind === 'finish-passed' ? 'passed' : plan.kind === 'finish-exhausted' ? 'exhausted' : 'stopped',
          terminalReason,
        )
      }
      for (const line of verdictLines) runtime.persistLog('verdict', line)
    })
    if (!applied) return
    runtime.notifyPersistedLog(terminalMetric.kind, terminalMetric.text)
    for (const line of verdictLines) runtime.notifyPersistedLog('verdict', line)

    const evidence = scanCritiqueArtifacts(build.workspaceDir, build).find((item) => item.round === attempt.round)
    if (evidence && (evidence.shots.length > 0 || evidence.refs.length > 0)) {
      runtime.log('shot', `▦ evidence saved: ${evidence.shots.length} shots · ${evidence.refs.length} refs · ${evidence.videos.length} videos${evidence.pairs ? ` · ${evidence.pairs.length} pairs` : evidence.pairsMd ? ' · pairs.md' : ''} → critique/round-${attempt.round}/`)
      for (const file of [...evidence.shots, ...evidence.refs].slice(0, 10)) runtime.log('shot', `  ${file}`)
    }
    if (plan.kind === 'finish-passed') {
      runtime.finishBuild('passed', terminalReason!)
    } else if (plan.kind === 'finish-exhausted') {
      runtime.finishBuild('exhausted', terminalReason!)
    } else if (plan.kind === 'finish-budget') {
      runtime.overBudget()
    } else {
      runtime.log('system', `Verdict fed forward — round ${plan.round} queued.`)
      runtime.broadcast()
    }
  }

  return { onLine: stream.onLine, onStderr: stream.onStderr, progressAt: stream.progressAt, finalize }
}
