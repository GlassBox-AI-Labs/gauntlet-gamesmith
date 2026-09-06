import type { AgentMetric, LoopRecord, RunMetrics, RunRecord, TokenTotals } from '../../shared/loop'
import { isCrossHarness } from '../../shared/models'
import { readChildAgents, type ChildStreamBoundary } from '../child-agents'
import { codexTokens, readCodexUsage } from '../codex-usage'
import type { Ledger } from '../ledger'
import { estimateCostUsd, PRICE_TABLE_VERSION } from '../pricing'
import { createCodexStream } from '../streams/codex-stream'
import { isMissingLeadSession } from '../../shared/lead'
import { LeadContinuity } from '../lead-continuity'
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
  const lead = new LeadContinuity(ledger)
  let usageBaseline = lead.usageBaseline(run)
  let threadId: string | null = null
  let lastAgentMessage = ''
  let didWork = false
  let missingSession = false
  const stream = createCodexStream()
  let turns = 0
  let workers: AgentMetric[] = []
  let workerLimitReported = false
  let lastFlush = runtime.now()
  let lastProgressAt = runtime.now()

  const pollWorkers = (): void => {
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
    const orchestrator: AgentMetric = {
      id: 'orchestrator',
      label: 'orchestrator',
      model: models.orchestratorModel,
      messages: turns,
      tokens,
      firstTs: new Date(startedAtMs).toISOString(),
      lastTs: runtime.nowIso(),
      costUsd: estimateCostUsd(models.orchestratorModel, tokens),
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
    const translated = stream.onLine(line)
    if (!translated) return
    if (translated.threadStarted !== undefined) {
      threadId = translated.threadStarted
      if (threadId && lead.sessionStarted(run, threadId)) {
        usageBaseline = emptyTokens()
        plog('system', 'The CLI started a different lead session; continuing from saved memory with fresh usage accounting.')
      }
      ledger.patchRun(run.id, { sessionId: threadId })
      plog('system', `codex thread ${threadId?.slice(0, 8) ?? '?'}`)
    }
    for (const event of translated.events) plog(event.kind, event.text, event.agentId)
    if (translated.events.some(event => ['tool', 'output', 'thought', 'search'].includes(event.channel))) didWork = true
    if (translated.summary !== undefined) lastAgentMessage = translated.summary
    if (translated.turn) {
      const turn = codexTokens(translated.turn.usage)
      if (usageBaseline && translated.turn.usage) {
        for (const key of ['input', 'output', 'cacheRead', 'cacheWrite'] as const) tokens[key] = Math.max(0, turn[key] - usageBaseline[key])
        if (threadId && translated.turn.usage) lead.recordUsage(run, threadId, turn)
      } else if (!usageBaseline) {
        tokens.input += turn.input
        tokens.output += turn.output
        tokens.cacheRead += turn.cacheRead
        tokens.cacheWrite += turn.cacheWrite
      }
      turns += 1
      flush(true)
    }
  }

  const finalize = async (exit: ExitInfo): Promise<void> => {
    await runtime.finalize(exit, () => {
      pollWorkers()
      const metrics = metricsNow()
      const error = exit.spawnError ?? stream.failure() ?? (exit.code !== 0 && exit.code !== null ? `codex exited ${exit.code}` : null)
      return {
        metrics,
        costUsd: Object.values(metrics.perModel).reduce((sum, model) => sum + (model.costUsd ?? 0), 0),
        costSource: `price_table:${PRICE_TABLE_VERSION}`,
        tokens: implementTokens(metrics.perModel),
        numTurns: turns,
        sessionId: threadId,
        summary: lastAgentMessage ? lastAgentMessage.slice(0, 4000) : null,
        leadResponse: lastAgentMessage || null,
        sessionUnavailable: !didWork && (missingSession || isMissingLeadSession(error ?? '')),
        error,
        logResult: null,
      }
    })
  }

  return {
    onLine,
    onStderr: (text) => {
      missingSession ||= isMissingLeadSession(text)
      plog('stderr', text.replace(/\s+/g, ' ').trim().slice(0, 400))
    },
    tick: () => flush(),
    progressAt: () => lastProgressAt,
    finalize,
  }
}
