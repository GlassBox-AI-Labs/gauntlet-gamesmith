import type { AgentMetric, LoopRecord, RunMetrics, RunRecord, TokenTotals } from '../../shared/loop'
import { buildReferencePrompt } from '../../shared/prompts'
import { harnessFor } from '../../shared/models'
import { createArtifactPhaseStream } from '../artifact-phase-stream'
import { readChildAgents, type ChildStreamBoundary } from '../child-agents'
import { researchRules } from '../delegation'
import type { Ledger } from '../ledger'
import { referencePackFingerprint } from '../phase-contracts'
import { estimateCostUsd, PRICE_TABLE_VERSION } from '../pricing'
import { scanReferencePack } from '../reference-pack'
import { planCompletion } from '../round-planner'
import { commitRunningAttempt } from '../run-transition'
import type { ExitInfo, LogGate, StreamParser } from './types'

interface ReferenceRoleRuntime {
  ledger: Ledger
  loop: LoopRecord
  run: RunRecord
  gate: LogGate
  childBoundary: ChildStreamBoundary
  referenceDir: string
  maxAttempts: number
  now(): number
  nowIso(): string
  harnessHome(kind: 'claude' | 'codex'): string
  log(kind: string, text: string, agentId?: string): void
  persistLog(kind: string, text: string): void
  notifyPersistedLog(kind: string, text: string): void
  broadcast(): void
  awaitChildren(): Promise<void>
  isStopRequested(): boolean
  finishCancelled(exit: ExitInfo, reason: string, terminalLog: { kind: string; text: string }): boolean
  ensureSourceBaseline(terminalLog: { kind: string; text: string }): boolean
  failOrRetry(error: string, label: string, maxAttempts: number, prompt: string, terminalLog: { kind: string; text: string }): Promise<void>
  overBudget(): boolean
  persistLoopTerminal(status: 'stopped', reason: string): void
  implementPrompt(round: number, verdict: null): string
}

function emptyTokens(): TokenTotals {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

/** Owns the complete Reference Study stream, accounting, artifact, and handoff protocol. */
export function createReferenceProtocol(runtime: ReferenceRoleRuntime): StreamParser {
  const { ledger, loop, run, gate } = runtime
  const model = loop.models.orchestratorModel
  const startedAtMs = Date.parse(ledger.getRun(run.id)?.startedAt ?? run.createdAt)
  let lastFlushAt = 0
  const plog = (kind: string, text: string, agentId?: string): void => {
    if (!gate.suppress) runtime.log(kind, text, agentId)
  }
  const stream = createArtifactPhaseStream({
    harness: run.harness,
    phase: 'reference',
    defaultModel: model,
    startedAtMs,
    initialSessionId: ledger.getRun(run.id)?.sessionId,
    now: runtime.now,
    log: plog,
    onIdentity: (sessionId, reportedModel) => {
      ledger.patchRun(run.id, { sessionId, ...(reportedModel ? { model: reportedModel } : {}) })
    },
    onUsage: () => flush(),
  })

  const accounting = (): { metrics: RunMetrics; input: number; output: number; costUsd: number | null } => {
    const state = stream.snapshot()
    const billedModel = state.reportedModel ?? model
    const primary: AgentMetric = {
      id: 'reference',
      label: 'reference researcher',
      model: billedModel,
      messages: state.messages,
      tokens: state.tokens,
      firstTs: new Date(startedAtMs).toISOString(),
      lastTs: runtime.nowIso(),
    }
    const researchers = loop.models.researchModel
      ? readChildAgents(runtime.childBoundary, loop.models.researchModel, runtime.harnessHome('codex'))
      : []
    const agents = [primary, ...researchers]
    const perModel: RunMetrics['perModel'] = {}
    for (const agent of agents) {
      if (!agent.model) continue
      const entry = perModel[agent.model] ?? { costUsd: null, tokens: emptyTokens() }
      entry.tokens.input += agent.tokens.input
      entry.tokens.output += agent.tokens.output
      entry.tokens.cacheRead += agent.tokens.cacheRead
      entry.tokens.cacheWrite += agent.tokens.cacheWrite
      entry.costUsd = estimateCostUsd(agent.model, entry.tokens)
      perModel[agent.model] = entry
    }
    const input = agents.reduce((sum, agent) => sum + agent.tokens.input + agent.tokens.cacheRead + agent.tokens.cacheWrite, 0)
    const output = agents.reduce((sum, agent) => sum + agent.tokens.output, 0)
    const costs = Object.values(perModel).map((entry) => entry.costUsd)
    const costUsd = costs.some((cost) => cost !== null) ? costs.reduce((sum: number, cost) => sum + (cost ?? 0), 0) : null
    return { metrics: { agents, perModel }, input, output, costUsd }
  }

  function flush(force = false): void {
    if (!force && runtime.now() - lastFlushAt < 15_000) return
    lastFlushAt = runtime.now()
    const current = accounting()
    ledger.patchRun(run.id, {
      inputTokens: current.input,
      outputTokens: current.output,
      costUsd: current.costUsd,
      costSource: current.costUsd === null ? null : `price_table:${PRICE_TABLE_VERSION}`,
      metrics: current.metrics,
    })
    runtime.broadcast()
  }

  const finalize = async (exit: ExitInfo): Promise<void> => {
    if (ledger.getRun(run.id)?.status !== 'running') return
    let state = stream.snapshot()
    const processError = exit.spawnError ?? state.failure ?? (exit.code !== 0 && exit.code !== null ? `${run.harness} exited ${exit.code}` : null)
    if (!processError && !state.rateLimitNotice && !runtime.isStopRequested() && !exit.timedOut) await runtime.awaitChildren()
    state = stream.snapshot()
    const durationMs = runtime.now() - startedAtMs
    const finalAccounting = accounting()
    const hasUsage = state.sawUsage || finalAccounting.metrics.agents.length > 1
    const costUsd = hasUsage ? finalAccounting.costUsd : null
    const pack = scanReferencePack(loop.workspaceDir, runtime.referenceDir, loop)
    const artifactError = pack.ready ? null : pack.issues.join('; ')
    ledger.patchRun(run.id, {
      metrics: {
        ...finalAccounting.metrics,
        ...(ledger.getRun(run.id)?.metrics?.projection ? { projection: ledger.getRun(run.id)!.metrics!.projection } : {}),
      },
      inputTokens: hasUsage ? finalAccounting.input : null,
      outputTokens: hasUsage ? finalAccounting.output : null,
      costUsd,
      costSource: costUsd === null ? null : `price_table:${PRICE_TABLE_VERSION}`,
      durationMs,
      sessionId: state.sessionId,
      summary: state.summary ? state.summary.slice(0, 4000) : null,
      finishedAt: runtime.nowIso(),
    })
    const terminalMetric = {
      kind: 'metric',
      text: `▤ reference metrics: ${costUsd != null ? `$${costUsd.toFixed(2)} equivalent API cost (price_table:${PRICE_TABLE_VERSION}) · ` : 'equivalent API cost n/a · '}in ${formatTokens(finalAccounting.input)} · out ${formatTokens(finalAccounting.output)} · ${Math.round(durationMs / 60_000)}m · ${Math.max(0, finalAccounting.metrics.agents.length - 1)} research workers`,
    }
    if (runtime.finishCancelled(exit, 'Reference Study timed out.', terminalMetric)) return
    if (!runtime.ensureSourceBaseline(terminalMetric)) return
    if (processError || artifactError) {
      const error = exit.spawnError ?? state.rateLimitNotice ?? state.failure ?? (exit.code !== 0 && exit.code !== null ? `${run.harness} exited ${exit.code}` : artifactError!)
      await runtime.failOrRetry(
        error,
        'Reference Study',
        runtime.maxAttempts,
        buildReferencePrompt(loop.prompt, runtime.referenceDir, researchRules(loop.models, runtime.referenceDir)),
        terminalMetric,
      )
      return
    }

    const fingerprint = referencePackFingerprint(loop.workspaceDir, runtime.referenceDir)
    const latestLoop = ledger.getLoop(loop.id)
    const projectedCost = (latestLoop?.totalCostUsd ?? 0) + (costUsd ?? 0)
    const budgetExceeded = !!latestLoop?.budgetUsd && projectedCost >= latestLoop.budgetUsd
    const plan = planCompletion({ role: 'reference', round: 0, maxRounds: loop.maxRounds, budgetExceeded })
    const fingerprintMessage = `Reference Pack frozen at sha256:${fingerprint}`
    const applied = commitRunningAttempt(ledger, loop.id, run.id, { status: 'succeeded' }, () => {
      runtime.persistLog(terminalMetric.kind, terminalMetric.text)
      runtime.persistLog('artifact', fingerprintMessage)
      if (plan.kind === 'queue-implement') {
        ledger.patchLoop(loop.id, { round: plan.round })
        ledger.createRun({
          loopId: loop.id,
          round: plan.round,
          role: 'implement',
          harness: harnessFor(model),
          prompt: runtime.implementPrompt(plan.round, null),
        })
      } else if (plan.kind === 'finish-budget') {
        runtime.persistLoopTerminal(
          'stopped',
          `Budget ceiling hit: $${projectedCost.toFixed(2)} of $${latestLoop!.budgetUsd!.toFixed(2)} (equivalent API cost).`,
        )
      }
    })
    if (!applied) return
    runtime.notifyPersistedLog(terminalMetric.kind, terminalMetric.text)
    runtime.notifyPersistedLog('artifact', fingerprintMessage)
    runtime.log('shot', `▦ Reference Pack ready: ${pack.images.length} stills · ${pack.motion.length} motion frames · ${pack.journey.length} journey shots · ${pack.videos.length} video → ${pack.root}/`)
    if (plan.kind === 'finish-budget') {
      runtime.overBudget()
      return
    }
    runtime.log('system', 'Reference Pack frozen — round 1 queued.')
    runtime.broadcast()
  }

  return { onLine: stream.onLine, onStderr: stream.onStderr, tick: () => flush(), progressAt: stream.progressAt, finalize }
}
