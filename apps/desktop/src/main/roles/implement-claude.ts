import type { AgentMetric, LoopRecord, RunMetrics, RunRecord, TokenTotals } from '../../shared/loop'
import { normalizeSessionId } from '../../shared/session-id'
import { isMissingLeadSession } from '../../shared/lead'
import { isCrossHarness } from '../../shared/models'
import { readChildAgents, type ChildStreamBoundary } from '../child-agents'
import { parseChildStreamName } from '../child-stream-name'
import { buildImplementMetrics, hasCliModelCost } from '../implement-metrics'
import type { Ledger } from '../ledger'
import { LeadContinuity } from '../lead-continuity'
import { estimateCostUsd, PRICE_TABLE_VERSION } from '../pricing'
import { normalizeStreamUsage, translateClaudeLine } from '../streams/claude-stream'
import { readWorkflowProgress, workflowDir, type WorkflowRunSummary } from '../workflow-progress'
import { WorkflowTail, workflowTailDir } from '../workflow-tail'
import type { ImplementOutcome } from './implement-finalize'
import type { ExitInfo, LogGate, StreamParser } from './types'

const MAX_IMPLEMENT_AGENT_IDS = 511
const MAX_IMPLEMENT_TASK_IDS = 4_096
const MAX_IMPLEMENT_MESSAGE_IDS = 8_192
const MAX_IMPLEMENT_CHILD_PARENTS = 256
const MAX_IMPLEMENT_WORKFLOW_KEYS = 512
const MAX_STREAM_ID_CHARS = 256

export interface ClaudeImplementRuntime {
  ledger: Ledger
  loop: LoopRecord
  run: RunRecord
  gate: LogGate
  childBoundary: ChildStreamBoundary
  initialWorkflowOffsets?: Record<string, number>
  initialWorkflowIdentities?: Record<string, { dev: number; ino: number }>
  now(): number
  nowIso(): string
  harnessHome(kind: 'claude' | 'codex'): string
  log(kind: string, text: string, agentId?: string): void
  broadcast(): void
  finalize(exit: ExitInfo, collect: () => ImplementOutcome): Promise<void>
}

function trunc(value: string, max: number): string {
  const flat = value.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

function emptyTokens(): TokenTotals {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
}

function finiteNonNegative(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`
  return String(value)
}

/** Prefer complete per-model accounting over the primary-thread CLI total. */
export function implementCostUsd(
  perModel: RunMetrics['perModel'],
  totalCostUsd: number | null,
  liveEstimate: number | null,
): number | null {
  const costs = Object.values(perModel).map((model) => model.costUsd)
  if (costs.some((cost) => cost != null)) return costs.reduce((sum: number, cost) => sum + (cost ?? 0), 0)
  return totalCostUsd ?? liveEstimate
}

/** Prefer fan-out-aware per-model token totals over primary-thread usage. */
export function implementTokens(
  perModel: RunMetrics['perModel'],
  usage: Record<string, number> | undefined,
): { input: number; output: number } | null {
  const models = Object.values(perModel)
  if (models.length) {
    return {
      input: models.reduce((sum, model) => sum + model.tokens.input + model.tokens.cacheRead + model.tokens.cacheWrite, 0),
      output: models.reduce((sum, model) => sum + model.tokens.output, 0),
    }
  }
  if (!usage) return null
  return {
    input: (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0),
    output: usage.output_tokens ?? 0,
  }
}

/**
 * Owns Claude implement parsing, async-agent lifecycle projection, workflow and
 * cross-harness accounting, bounded live metrics, and terminal outcome
 * construction. The runner supplies only process-level orchestration seams.
 */
export function createClaudeImplementProtocol(runtime: ClaudeImplementRuntime): StreamParser {
  const { ledger, loop, run, gate } = runtime
  const initialWorkflowOffsets = runtime.initialWorkflowOffsets ?? {}
  const initialWorkflowIdentities = runtime.initialWorkflowIdentities ?? {}
  const plog = (kind: string, text: string, agentId?: string): void => {
    if (!gate.suppress) runtime.log(kind, text, agentId)
  }
  let retentionLimitReported = false
  let taskTrackingOverflow = false
  const reportRetentionLimit = (): void => {
    if (retentionLimitReported) return
    retentionLimitReported = true
    plog(
      'error',
      'Implement live projection reached its bounded message/task identity limit; additional raw events remain on disk and terminal CLI totals remain authoritative.',
    )
  }
  const streamId = (value: unknown): string | null => {
    if (typeof value === 'string' && value.length > 0 && value.length <= MAX_STREAM_ID_CHARS) return value
    if (value !== undefined && value !== null) reportRetentionLimit()
    return null
  }
  const agentLabels = new Map<string, { label: string; model: string | null }>()
  const finishedAgents = new Set<string>()
  // A background launch receipt is not completion; only the later task
  // notification ends that worker.
  const backgrounded = new Set<string>()
  /** Tracked tasks that are shell commands, not agents. */
  const notAgents = new Set<string>()
  /** Cross-harness child slice → owning Claude tool-use id. */
  const childParents = new Map<string, string>()
  const msgUsage = new Map<string, { agentKey: string; model: string | null; usage: Record<string, number>; ts: string }>()
  let result: Record<string, unknown> | null = null
  let didWork = false
  let missingSession = false
  let fallbackId = 0
  let lastTokenFlush = runtime.now()
  let liveCostEstimate: number | null = null
  let sessionId: string | null = ledger.getRun(run.id)?.sessionId ?? null
  const attemptStartMs = new LeadContinuity(ledger).state(loop.id).enabled ? Date.parse(ledger.getRun(run.id)?.startedAt ?? run.createdAt) : 0
  const workflowBaseline = (ledger.getRun(run.id)?.metrics?.agents ?? [])
    .filter((agent) => agent.source === 'workflow')
    .slice(0, MAX_IMPLEMENT_AGENT_IDS)
  let workflowAgents: AgentMetric[] = workflowBaseline
  let childAgents: AgentMetric[] = []
  let workflowRuns: WorkflowRunSummary[] = []
  let workflowTokens = 0
  const loggedWorkflowRuns = new Set<string>()
  const loggedWorkflowWarnings = new Set<string>()
  let loggedWorkflowMetric = false
  let tail: WorkflowTail | null = null

  const pollWorkflows = (): void => {
    if (!sessionId) return
    const claudeHome = runtime.harnessHome('claude')
    tail ??= new WorkflowTail(
      workflowTailDir(claudeHome, loop.workspaceDir, sessionId),
      initialWorkflowOffsets,
      claudeHome,
      initialWorkflowIdentities,
      attemptStartMs,
    )
    const { agents: live, events } = tail.pollWithEvents()
    for (const event of events) plog(event.kind, event.text, event.agentId)
    const progress = readWorkflowProgress(workflowDir(claudeHome, loop.workspaceDir, sessionId), attemptStartMs)
    const progressWarning = progress.warning?.slice(0, 1_000)
    if (progressWarning && !loggedWorkflowWarnings.has(progressWarning)) {
      if (loggedWorkflowWarnings.size < MAX_IMPLEMENT_WORKFLOW_KEYS) loggedWorkflowWarnings.add(progressWarning)
      else reportRetentionLimit()
      plog('error', progressWarning)
    }
    const phaseById = new Map(progress.agents.map((agent) => [agent.id.split(':').at(-1), agent.phase]))
    const liveById = new Map(live.map((agent) => [agent.id, agent]))
    const projectedWorkflowAgents = [
      ...workflowBaseline.map((prior) => {
        const next = liveById.get(prior.id)
        if (!next) return prior
        liveById.delete(prior.id)
        const tokens = {
          input: prior.tokens.input + next.tokens.input,
          output: prior.tokens.output + next.tokens.output,
          cacheRead: prior.tokens.cacheRead + next.tokens.cacheRead,
          cacheWrite: prior.tokens.cacheWrite + next.tokens.cacheWrite,
        }
        return {
          ...prior,
          ...next,
          messages: prior.messages + next.messages,
          tokens,
          toolCalls: (prior.toolCalls ?? 0) + (next.toolCalls ?? 0),
          totalTokens: tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite,
          costUsd: estimateCostUsd(next.model ?? prior.model, tokens),
        }
      }),
      ...liveById.values(),
    ].map((agent) => ({ ...agent, phase: agent.phase ?? phaseById.get(agent.id.split(':').at(-1)) }))
    if (projectedWorkflowAgents.length > MAX_IMPLEMENT_AGENT_IDS) reportRetentionLimit()
    workflowAgents = projectedWorkflowAgents.slice(0, MAX_IMPLEMENT_AGENT_IDS)
    workflowRuns = progress.runs
    workflowTokens = live.reduce((sum, agent) => sum + (agent.totalTokens ?? 0), 0) || progress.totalTokens
    for (const workflow of progress.runs) {
      const key = `${workflow.runId}:${workflow.status}`
      if (loggedWorkflowRuns.has(key)) continue
      if (loggedWorkflowRuns.size >= MAX_IMPLEMENT_WORKFLOW_KEYS) {
        reportRetentionLimit()
        continue
      }
      loggedWorkflowRuns.add(key)
      plog('spawn', `⇉ workflow "${workflow.name}" ${workflow.status} — ${workflow.agentCount} agents · ${formatTokens(workflow.totalTokens)} tokens`)
    }
  }

  const pollChildren = (): void => {
    if (!isCrossHarness(loop.models)) return
    childAgents = readChildAgents(runtime.childBoundary, loop.models.subagentModel, runtime.harnessHome('codex'))
  }

  const flushTokens = (force = false): void => {
    if (!force && runtime.now() - lastTokenFlush < 15_000) return
    lastTokenFlush = runtime.now()
    pollWorkflows()
    pollChildren()
    let input = 0
    let output = 0
    const perModel = new Map<string, TokenTotals>()
    for (const { usage, model } of msgUsage.values()) {
      const key = model ?? loop.models.orchestratorModel
      const tokens = perModel.get(key) ?? emptyTokens()
      tokens.input += usage.input_tokens ?? 0
      tokens.output += usage.output_tokens ?? 0
      tokens.cacheRead += usage.cache_read_input_tokens ?? 0
      tokens.cacheWrite += usage.cache_creation_input_tokens ?? 0
      perModel.set(key, tokens)
      input += (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0)
      output += usage.output_tokens ?? 0
    }
    liveCostEstimate = null
    for (const [model, tokens] of perModel) {
      const cost = estimateCostUsd(model, tokens)
      if (cost != null) liveCostEstimate = (liveCostEstimate ?? 0) + cost
    }
    for (const agent of [...workflowAgents, ...childAgents]) {
      if (agent.costUsd != null) liveCostEstimate = (liveCostEstimate ?? 0) + agent.costUsd
      input += agent.tokens.input + agent.tokens.cacheRead + agent.tokens.cacheWrite
      output += agent.tokens.output
    }
    ledger.patchRun(run.id, {
      inputTokens: input,
      outputTokens: output,
      costUsd: liveCostEstimate,
      costSource: liveCostEstimate === null ? null : `price_table:${PRICE_TABLE_VERSION}`,
      metrics: buildImplementMetrics({
        models: loop.models,
        agentLabels,
        messageUsage: msgUsage,
        result: null,
        finished: finishedAgents,
        workflowAgents,
        childAgents,
        childParents,
      }),
    })
    runtime.broadcast()
  }

  let lastProgressAt = runtime.now()

  const onLine = (line: string): void => {
    if (!line.trim()) return
    lastProgressAt = runtime.now()
    const translated = translateClaudeLine(line)
    let obj: Record<string, unknown>
    try {
      const parsed: unknown = JSON.parse(line)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        for (const event of translated?.events ?? []) plog(event.kind, event.text, event.agentId)
        return
      }
      obj = parsed as Record<string, unknown>
    } catch {
      for (const event of translated?.events ?? []) plog(event.kind, event.text, event.agentId)
      return
    }
    const type = obj.type as string
    if (type === 'assistant' || type === 'user') didWork = true
    const parentId = streamId(obj.parent_tool_use_id)
    const agentKey = parentId ?? 'orchestrator'
    const who = parentId ? (agentLabels.get(parentId)?.label ?? `agent-${parentId.slice(-6)}`) : 'orchestrator'

    if (type !== 'assistant' && type !== 'user') {
      for (const event of translated?.events ?? []) plog(event.kind, `[${who}] ${event.text}`, event.agentId)
    }

    if (type === 'system' && obj.subtype === 'init') {
      const model = translated?.init?.model ?? null
      const reportedSession = translated?.init?.sessionId ?? null
      if (typeof obj.session_id === 'string' && !reportedSession) {
        plog('error', 'Claude init reported an invalid session id; workflow paths and resume state will ignore it.')
      }
      sessionId = reportedSession ?? sessionId
      if (reportedSession && new LeadContinuity(ledger).sessionStarted(run, reportedSession)) {
        plog('system', 'The CLI started a different lead session; this turn uses saved memory instead of the previous conversation.')
      }
      if (model || sessionId) ledger.patchRun(run.id, { ...(model ? { model } : {}), ...(sessionId ? { sessionId } : {}) })
      plog('system', `session ${sessionId?.slice(0, 8) ?? '?'} · model ${model ?? '?'}`)
      return
    }

    if (type === 'system' && (obj.subtype === 'task_started' || obj.subtype === 'task_notification')) {
      const toolUseId = streamId(obj.tool_use_id)
      if (!toolUseId) return
      if (obj.subtype === 'task_started') {
        if (obj.task_type !== 'local_agent' && !agentLabels.has(toolUseId)) {
          if (notAgents.size < MAX_IMPLEMENT_TASK_IDS) notAgents.add(toolUseId)
          else {
            taskTrackingOverflow = true
            reportRetentionLimit()
          }
          return
        }
        if (obj.is_backgrounded) {
          if (backgrounded.size < MAX_IMPLEMENT_TASK_IDS) backgrounded.add(toolUseId)
          else reportRetentionLimit()
        }
        if (!agentLabels.has(toolUseId)) {
          if (agentLabels.size >= MAX_IMPLEMENT_AGENT_IDS) {
            reportRetentionLimit()
            return
          }
          agentLabels.set(toolUseId, { label: trunc((obj.description as string | undefined) ?? 'subagent', 30), model: null })
        }
        return
      }
      if (taskTrackingOverflow && !agentLabels.has(toolUseId) && !notAgents.has(toolUseId)) return
      if (notAgents.has(toolUseId) || finishedAgents.has(toolUseId)) return
      if (finishedAgents.size < MAX_IMPLEMENT_TASK_IDS) finishedAgents.add(toolUseId)
      else reportRetentionLimit()
      const label = agentLabels.get(toolUseId)?.label ?? `agent-${toolUseId.slice(-6)}`
      plog('spawn', `⇊ subagent "${label}" ${(obj.status as string | undefined) ?? 'finished'}`, toolUseId)
      return
    }

    if (type === 'assistant') {
      const message = obj.message as Record<string, unknown> | undefined
      if (!message) return
      const msgId = streamId(message.id) ?? `noid-${fallbackId++}`
      const usage = normalizeStreamUsage(message.usage)
      if (usage) {
        const item = {
          agentKey,
          model: typeof message.model === 'string' && message.model.length <= 256 ? message.model : null,
          usage,
          ts: runtime.nowIso(),
        }
        if (msgUsage.has(msgId)) msgUsage.set(msgId, item)
        else if (msgUsage.size < MAX_IMPLEMENT_MESSAGE_IDS) msgUsage.set(msgId, item)
        else reportRetentionLimit()
        flushTokens()
      }
      const content = Array.isArray(message.content) ? (message.content as Record<string, unknown>[]) : []
      const spawnEventIds: string[] = []
      for (const block of content) {
        if (block.type !== 'tool_use') continue
        const name = block.name as string
        const input = block.input as Record<string, unknown> | undefined
        const blockId = streamId(block.id)
        if ((name === 'Agent' || name === 'Task') && blockId) {
          const label = trunc((input?.description as string | undefined) ?? (input?.subagent_type as string | undefined) ?? 'subagent', 30)
          const model = typeof input?.model === 'string' && input.model.length <= 256 ? input.model : null
          if (agentLabels.has(blockId) || agentLabels.size < MAX_IMPLEMENT_AGENT_IDS) {
            agentLabels.set(blockId, { label, model })
            spawnEventIds.push(blockId)
          } else {
            reportRetentionLimit()
          }
        } else {
          const raw = input ? JSON.stringify(input) : ''
          const stream = /agents[\\/]+([^/'"\s\\]+\.jsonl)/.exec(raw)
          const named = stream ? parseChildStreamName(stream[1]) : null
          if (named && parentId) {
            if (childParents.has(named.slug) || childParents.size < MAX_IMPLEMENT_CHILD_PARENTS) childParents.set(named.slug, parentId)
            else reportRetentionLimit()
          }
        }
      }
      for (const event of translated?.events ?? []) {
        const eventAgentId = event.kind === 'spawn' ? (spawnEventIds.shift() ?? event.agentId) : event.agentId
        plog(event.kind === 'claude' && parentId ? 'agent' : event.kind, `[${who}] ${event.text}`, eventAgentId)
      }
      return
    }

    if (type === 'user') {
      const message = obj.message as Record<string, unknown> | undefined
      const content = Array.isArray(message?.content) ? (message.content as Record<string, unknown>[]) : []
      for (const block of content) {
        if (block.type !== 'tool_result') continue
        const toolUseId = streamId(block.tool_use_id)
        if (toolUseId && agentLabels.has(toolUseId) && !backgrounded.has(toolUseId) && !finishedAgents.has(toolUseId)) {
          if (finishedAgents.size < MAX_IMPLEMENT_TASK_IDS) finishedAgents.add(toolUseId)
          else reportRetentionLimit()
          plog('spawn', `⇊ subagent "${agentLabels.get(toolUseId)!.label}" finished`, toolUseId)
        }
      }
      for (const event of translated?.events ?? []) plog(event.kind, `[${who}] ${event.text}`, event.agentId)
      return
    }

    if (type === 'result') result = obj
  }

  const finalize = async (exit: ExitInfo): Promise<void> => {
    await runtime.finalize(exit, () => {
      pollWorkflows()
      pollChildren()
      const metrics = buildImplementMetrics({
        models: loop.models,
        agentLabels,
        messageUsage: msgUsage,
        result,
        finished: finishedAgents,
        workflowAgents,
        childAgents,
        childParents,
      })
      if (workflowRuns.length && !loggedWorkflowMetric) {
        loggedWorkflowMetric = true
        plog(
          'metric',
          `▤ workflow fan-out: ${workflowRuns.length} workflow${workflowRuns.length === 1 ? '' : 's'} · ${workflowAgents.length} agents · ${formatTokens(workflowTokens)} tokens`,
        )
      }
      const usage = normalizeStreamUsage(result?.usage)
      const succeeded = result !== null && result.is_error !== true && (exit.code === 0 || exit.code === null)
      const cliModelCostPresent = hasCliModelCost(result)
      const hasPerModelCost = Object.values(metrics.perModel).some((usageRow) => usageRow.costUsd !== null)
      const cliTotal = finiteNonNegative(result?.total_cost_usd)
      const costSource = hasPerModelCost
        ? cliModelCostPresent && childAgents.length
          ? `cli:model_usage+price_table:${PRICE_TABLE_VERSION}`
          : cliModelCostPresent
            ? 'cli:model_usage'
            : `price_table:${PRICE_TABLE_VERSION}`
        : cliTotal !== null
          ? 'cli:total'
          : liveCostEstimate === null
            ? null
            : `price_table:${PRICE_TABLE_VERSION}`
      return {
        metrics,
        costUsd: implementCostUsd(metrics.perModel, cliTotal, liveCostEstimate),
        costSource,
        tokens: implementTokens(metrics.perModel, usage),
        numTurns: nonNegativeInteger(result?.num_turns),
        sessionId: normalizeSessionId(result?.session_id) ?? sessionId,
        summary: typeof result?.result === 'string' ? result.result.slice(0, 4000) : null,
        leadResponse: typeof result?.result === 'string' ? result.result : null,
        sessionUnavailable: !didWork && (missingSession || isMissingLeadSession(typeof result?.result === 'string' ? result.result : '')),
        error: succeeded
          ? null
          : (exit.spawnError ??
            (typeof result?.result === 'string'
              ? trunc(result.result, 400)
              : `claude exited ${exit.code}${result ? ` (${result.subtype})` : ' without a result'}`)),
        logResult: result,
      }
    })
  }

  let lastWorkflowFootprint = ''
  let lastTick = 0
  const tick = (): void => {
    if (runtime.now() - lastTick < 10_000) return
    lastTick = runtime.now()
    const before = workflowAgents.length + childAgents.length
    pollWorkflows()
    pollChildren()
    const footprint = [...workflowAgents, ...childAgents]
      .map((agent) => `${agent.id}:${agent.totalTokens}:${agent.toolCalls}:${agent.state}`)
      .join('|')
    if (footprint !== lastWorkflowFootprint) {
      lastWorkflowFootprint = footprint
      lastProgressAt = runtime.now()
    }
    if (workflowAgents.length + childAgents.length === 0 && before === 0) return
    flushTokens(true)
  }

  return {
    onLine,
    onStderr: (text) => { missingSession ||= isMissingLeadSession(text); plog('stderr', trunc(text, 400)) },
    tick,
    progressAt: () => lastProgressAt,
    workflowOffsets: () => tail?.snapshot() ?? initialWorkflowOffsets,
    workflowIdentities: () => tail?.identitySnapshot() ?? initialWorkflowIdentities,
    finalize,
  }
}
