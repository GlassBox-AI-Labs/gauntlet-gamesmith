import type { AgentMetric, LoopRecord, RunMetrics, RunRecord, TokenTotals } from '../../shared/loop'
import { isCrossHarness } from '../../shared/models'
import { effectivePromptForRun } from '../../shared/prompts'
import { readChildAgents, type ChildStreamBoundary } from '../child-agents'
import { codexTokens, readCodexUsage, usageForThread } from '../codex-usage'
import type { Ledger } from '../ledger'
import { estimateCostUsd, PRICE_TABLE_VERSION } from '../pricing'
import { rateLimitPause } from '../rate-limit'
import { translateCodexLine } from '../streams/codex-stream'
import type { ImplementOutcome } from './implement-finalize'
import type { ExitInfo, LogGate, StreamParser } from './types'

interface CodexImplementRuntime {
  ledger: Ledger
  loop: LoopRecord
  run: RunRecord
  gate: LogGate
  childBoundary: ChildStreamBoundary
  now(): number
  nowIso(): string
  harnessHome(kind: 'claude' | 'codex'): string
  log(kind: string, text: string, agentId?: string): void
  broadcast(): void
  finalize(exit: ExitInfo, collect: () => ImplementOutcome): Promise<void>
}

function emptyTokens(): TokenTotals {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
}

function implementTokens(perModel: RunMetrics['perModel']): { input: number; output: number } | null {
  const models = Object.values(perModel)
  if (!models.length) return null
  return {
    input: models.reduce((sum, model) => sum + model.tokens.input + model.tokens.cacheRead + model.tokens.cacheWrite, 0),
    output: models.reduce((sum, model) => sum + model.tokens.output, 0),
  }
}

/** Owns Codex implement stream parsing, live worker accounting, and outcome construction. */
export function createCodexImplementProtocol(runtime: CodexImplementRuntime): StreamParser {
  const { ledger, loop, run, gate } = runtime
  const plog = (kind: string, text: string, agentId?: string): void => {
    if (!gate.suppress) runtime.log(kind, text, agentId)
  }
  const models = loop.models
  const startedAtMs = Date.parse(ledger.getRun(run.id)?.startedAt ?? run.createdAt)
  const tokens = emptyTokens()
  let threadId: string | null = null
  let lastAgentMessage = ''
  let failure: string | null = null
  let rateLimitNotice: string | null = null
  let turns = 0
  /**
   * Codex reports the orchestrator's own usage exactly once, in the
   * `turn.completed` that ends the whole invocation. Mid-run the row therefore
   * reads zero however hard the agent is working, and a run that is killed
   * loses the figure for good — one real 43-minute run finished recording its
   * orchestrator as 0 messages and 0 tokens. The session log carries a running
   * count the whole time, which is already how every worker is counted.
   */
  let liveTokens: TokenTotals | null = null
  /**
   * A resumed run appends to the earlier attempt's rollout, so the session's
   * cumulative count opens with tokens an earlier run already reported.
   * Subtract that inheritance instead of billing it to both runs. A fresh
   * session inherits nothing.
   */
  let inherited: TokenTotals | null = effectivePromptForRun(run.prompt).resumeRequested ? null : emptyTokens()
  let workers: AgentMetric[] = []
  let workerLimitReported = false
  let lastFlush = runtime.now()
  let lastProgressAt = runtime.now()

  /** The orchestrator's own running count, read the way its workers already are. */
  const pollOrchestrator = (codexHome: string): void => {
    if (!threadId) return
    const live = usageForThread(codexHome, threadId)
    // Keep the last good reading: a momentarily unreadable rollout means the
    // count is unknown, never that the orchestrator did nothing.
    if (!live) return
    inherited ??= live
    liveTokens = {
      input: Math.max(0, live.input - inherited.input),
      output: Math.max(0, live.output - inherited.output),
      cacheRead: Math.max(0, live.cacheRead - inherited.cacheRead),
      cacheWrite: Math.max(0, live.cacheWrite - inherited.cacheWrite),
    }
  }

  const pollWorkers = (): void => {
    pollOrchestrator(runtime.harnessHome('codex'))
    const spawned = readCodexUsage(runtime.harnessHome('codex'), startedAtMs, models.subagentModel ?? models.orchestratorModel, threadId)
    const delegated = isCrossHarness(models) ? readChildAgents(runtime.childBoundary, models.subagentModel, runtime.harnessHome('codex')) : []
    const combined = [...spawned, ...delegated]
    if (combined.length > 511 && !workerLimitReported) {
      workerLimitReported = true
      plog('error', 'Codex worker accounting reached the 511-worker persistence limit; remaining raw evidence stays on disk.')
    }
    workers = combined.slice(0, 511)
  }

  const metricsNow = (): RunMetrics => {
    // The session log is cumulative and always current; the stream's own total
    // only exists once the final turn lands, so it is the fallback.
    const own = liveTokens ?? tokens
    const orchestrator: AgentMetric = {
      id: 'orchestrator',
      label: 'orchestrator',
      model: models.orchestratorModel,
      messages: turns,
      tokens: own,
      firstTs: new Date(startedAtMs).toISOString(),
      lastTs: runtime.nowIso(),
      costUsd: estimateCostUsd(models.orchestratorModel, own),
    }
    const perModel: RunMetrics['perModel'] = {}
    for (const agent of [orchestrator, ...workers]) {
      const key = agent.model ?? models.orchestratorModel
      const entry = perModel[key] ?? { costUsd: 0, tokens: emptyTokens() }
      entry.tokens.input += agent.tokens.input
      entry.tokens.output += agent.tokens.output
      entry.tokens.cacheRead += agent.tokens.cacheRead
      entry.tokens.cacheWrite += agent.tokens.cacheWrite
      entry.costUsd = estimateCostUsd(key, entry.tokens)
      perModel[key] = entry
    }
    return { agents: [orchestrator, ...workers], perModel }
  }

  const flush = (force = false): void => {
    if (!force && runtime.now() - lastFlush < 15_000) return
    lastFlush = runtime.now()
    pollWorkers()
    const metrics = metricsNow()
    const totals = implementTokens(metrics.perModel)
    ledger.patchRun(run.id, {
      metrics,
      inputTokens: totals?.input,
      outputTokens: totals?.output,
      costUsd: Object.values(metrics.perModel).reduce((sum, model) => sum + (model.costUsd ?? 0), 0),
      costSource: `price_table:${PRICE_TABLE_VERSION}`,
    })
    runtime.broadcast()
  }

  const onLine = (line: string): void => {
    if (!line.trim()) return
    lastProgressAt = runtime.now()
    const translated = translateCodexLine(line)
    if (!translated) return
    if (translated.threadStarted !== undefined) {
      threadId = translated.threadStarted
      ledger.patchRun(run.id, { sessionId: threadId })
      // Capture the inheritance here rather than at the first poll: nothing of
      // this run has been spent yet when its thread is announced.
      if (inherited === null && threadId) inherited = usageForThread(runtime.harnessHome('codex'), threadId)
      plog('system', `codex thread ${threadId?.slice(0, 8) ?? '?'}`)
    }
    for (const event of translated.events) plog(event.kind, event.text, event.agentId)
    if (translated.summary !== undefined) lastAgentMessage = translated.summary
    if (translated.turn) {
      // See artifact-phase-stream: a completed turn clears a survived error.
      failure = null
      const turn = codexTokens(translated.turn.usage)
      tokens.input += turn.input
      tokens.output += turn.output
      tokens.cacheRead += turn.cacheRead
      tokens.cacheWrite += turn.cacheWrite
      turns += 1
      flush(true)
    }
    if (translated.error) {
      failure = translated.error
      if (rateLimitPause(failure, 0)) rateLimitNotice = failure
      plog('error', failure)
    }
  }

  const finalize = async (exit: ExitInfo): Promise<void> => {
    await runtime.finalize(exit, () => {
      pollWorkers()
      const metrics = metricsNow()
      const error = exit.spawnError ?? failure ?? rateLimitNotice ?? (exit.code !== 0 && exit.code !== null ? `codex exited ${exit.code}` : null)
      return {
        metrics,
        costUsd: Object.values(metrics.perModel).reduce((sum, model) => sum + (model.costUsd ?? 0), 0),
        costSource: `price_table:${PRICE_TABLE_VERSION}`,
        tokens: implementTokens(metrics.perModel),
        numTurns: turns,
        sessionId: threadId,
        summary: lastAgentMessage ? lastAgentMessage.slice(0, 4000) : null,
        error,
        logResult: null,
      }
    })
  }

  return {
    onLine,
    onStderr: (text) => plog('stderr', text.replace(/\s+/g, ' ').trim().slice(0, 400)),
    tick: () => flush(),
    progressAt: () => lastProgressAt,
    finalize,
  }
}
