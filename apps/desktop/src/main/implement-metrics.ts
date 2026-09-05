import { parseAgentMetricId } from '../shared/agent-id'
import type { AgentMetric, LoopModels, RunMetrics, TokenTotals } from '../shared/loop'
import { canonicalModelId, DISPATCHER_MODEL_ID, isCrossHarness } from '../shared/models'
import { estimateCostUsd } from './pricing'
import { normalizeStreamUsage } from './streams/claude-stream'

const MAX_PERSISTED_AGENTS = 512
const MAX_PERSISTED_MODELS = 128
const MAX_MODEL_NAME_LENGTH = 256

export interface ImplementMessageUsage {
  agentKey: string
  model: string | null
  usage: Record<string, number>
  ts: string
}

export interface ImplementMetricInput {
  models: LoopModels
  agentLabels: Map<string, { label: string; model: string | null }>
  messageUsage: Map<string, ImplementMessageUsage>
  result: Record<string, unknown> | null
  finished?: Set<string>
  workflowAgents?: AgentMetric[]
  childAgents?: AgentMetric[]
  childParents?: Map<string, string>
  /**
   * Rows whose tokens are already inside the orchestrator's own totals.
   *
   * Grok forwards a subagent's messages into the parent stream, so the run
   * total already contains the worker's spend. These rows therefore come *out*
   * of the orchestrator rather than adding on top of it — the opposite of
   * `childAgents`, which are separate processes the app spawned itself.
   */
  splitAgents?: AgentMetric[]
}

function emptyTokens(): TokenTotals {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
}

function finiteNonNegative(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

function validModelName(value: string): boolean {
  return value.length > 0 && value.length <= MAX_MODEL_NAME_LENGTH
}

/** Inspect only the bounded set of CLI model rows that can be persisted. */
export function hasCliModelCost(result: Record<string, unknown> | null): boolean {
  const modelUsage = result?.modelUsage
  if (!modelUsage || typeof modelUsage !== 'object' || Array.isArray(modelUsage)) return false
  let accepted = 0
  for (const model in modelUsage) {
    if (!Object.prototype.hasOwnProperty.call(modelUsage, model) || !validModelName(model)) continue
    if (accepted >= MAX_PERSISTED_MODELS) break
    const candidate = (modelUsage as Record<string, unknown>)[model]
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue
    accepted += 1
    if (finiteNonNegative((candidate as Record<string, unknown>).costUSD) !== null) return true
  }
  return false
}

/** Build one deterministic, normalized accounting tree from every worker source. */
export function buildImplementMetrics(input: ImplementMetricInput): RunMetrics {
  const {
    models,
    agentLabels,
    messageUsage,
    result,
    finished = new Set(),
    workflowAgents = [],
    childAgents = [],
    childParents = new Map(),
    splitAgents = [],
  } = input
  const agents = new Map<string, AgentMetric>()
  const ensure = (key: string): AgentMetric | null => {
    let agent = agents.get(key)
    if (!agent) {
      if (agents.size >= MAX_PERSISTED_AGENTS) return null
      const registered = agentLabels.get(key)
      const dispatches = key !== 'orchestrator' && isCrossHarness(models)
      agent = {
        id: key,
        label:
          key === 'orchestrator'
            ? 'orchestrator'
            : `${registered?.label ?? `subagent ${key.slice(-6)}`}${dispatches ? ' (dispatcher)' : ''}`,
        model:
          key === 'orchestrator'
            ? models.orchestratorModel
            : (registered?.model ?? (dispatches ? DISPATCHER_MODEL_ID : (models.subagentModel ?? models.orchestratorModel))),
        messages: 0,
        tokens: emptyTokens(),
        firstTs: null,
        lastTs: null,
      }
      agents.set(key, agent)
    }
    return agent
  }
  ensure('orchestrator')
  for (const key of agentLabels.keys()) ensure(key)
  for (const { agentKey, model, usage, ts } of messageUsage.values()) {
    const agent = ensure(agentKey)
    if (!agent) continue
    const safeUsage = normalizeStreamUsage(usage) ?? {}
    agent.messages += 1
    if (model && agent.id !== 'orchestrator') agent.model = model
    agent.tokens.input += safeUsage.input_tokens ?? 0
    agent.tokens.output += safeUsage.output_tokens ?? 0
    agent.tokens.cacheRead += safeUsage.cache_read_input_tokens ?? 0
    agent.tokens.cacheWrite += safeUsage.cache_creation_input_tokens ?? 0
    if (!agent.firstTs || ts < agent.firstTs) agent.firstTs = ts
    if (!agent.lastTs || ts > agent.lastTs) agent.lastTs = ts
  }

  const perModel: RunMetrics['perModel'] = Object.create(null) as RunMetrics['perModel']
  const modelUsage = result?.modelUsage
  if (modelUsage && typeof modelUsage === 'object' && !Array.isArray(modelUsage)) {
    const maxCliModels = MAX_PERSISTED_MODELS - (childAgents.length && models.subagentModel ? 1 : 0)
    let accepted = 0
    for (const rawModel in modelUsage) {
      if (!Object.prototype.hasOwnProperty.call(modelUsage, rawModel) || !validModelName(rawModel)) continue
      if (accepted >= maxCliModels) break
      const candidate = (modelUsage as Record<string, unknown>)[rawModel]
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue
      accepted += 1
      const raw = candidate as Record<string, unknown>
      const usage = normalizeStreamUsage({
        inputTokens: raw.inputTokens,
        outputTokens: raw.outputTokens,
        cacheReadInputTokens: raw.cacheReadInputTokens,
        cacheCreationInputTokens: raw.cacheCreationInputTokens,
      }) ?? {}
      const model = canonicalModelId(rawModel) ?? rawModel
      const tokens = {
        input: usage.inputTokens ?? 0,
        output: usage.outputTokens ?? 0,
        cacheRead: usage.cacheReadInputTokens ?? 0,
        cacheWrite: usage.cacheCreationInputTokens ?? 0,
      }
      const cost = finiteNonNegative(raw.costUSD)
      const existing = perModel[model]
      perModel[model] = existing
        ? {
            costUsd: existing.costUsd === null && cost === null ? null : (existing.costUsd ?? 0) + (cost ?? 0),
            tokens: {
              input: existing.tokens.input + tokens.input,
              output: existing.tokens.output + tokens.output,
              cacheRead: existing.tokens.cacheRead + tokens.cacheRead,
              cacheWrite: existing.tokens.cacheWrite + tokens.cacheWrite,
            },
          }
        : { costUsd: cost, tokens }
    }
  }

  if (childAgents.length && models.subagentModel) {
    const tokens = emptyTokens()
    for (const agent of childAgents) {
      tokens.input += agent.tokens.input
      tokens.output += agent.tokens.output
      tokens.cacheRead += agent.tokens.cacheRead
      tokens.cacheWrite += agent.tokens.cacheWrite
    }
    perModel[models.subagentModel] = { costUsd: estimateCostUsd(models.subagentModel, tokens), tokens }
  }
  for (const [key, agent] of agents) if (key !== 'orchestrator') agent.done = finished.has(key)

  // Take each split row's spend back out of the orchestrator, so the rows still
  // sum to what the run actually cost instead of counting the worker twice.
  const orchestrator = agents.get('orchestrator')
  if (orchestrator) {
    for (const worker of splitAgents) {
      orchestrator.tokens.input = Math.max(0, orchestrator.tokens.input - worker.tokens.input)
      orchestrator.tokens.output = Math.max(0, orchestrator.tokens.output - worker.tokens.output)
      orchestrator.tokens.cacheRead = Math.max(0, orchestrator.tokens.cacheRead - worker.tokens.cacheRead)
      orchestrator.tokens.cacheWrite = Math.max(0, orchestrator.tokens.cacheWrite - worker.tokens.cacheWrite)
      orchestrator.messages = Math.max(0, orchestrator.messages - worker.messages)
    }
  }

  const list = [...agents.values()]
  list.sort((leftAgent, rightAgent) => {
    if (leftAgent.id === 'orchestrator') return -1
    if (rightAgent.id === 'orchestrator') return 1
    const left = leftAgent.firstTs ?? '\uffff'
    const right = rightAgent.firstTs ?? '\uffff'
    return left < right ? -1 : left > right ? 1 : 0
  })
  const byParent = new Map<string, AgentMetric[]>()
  const orphans: AgentMetric[] = []
  for (const child of childAgents) {
    const parsed = parseAgentMetricId(child.id)
    const parent = parsed?.kind === 'child' ? childParents.get(parsed.slug) : undefined
    child.parentId = parent
    if (parent && agents.has(parent)) byParent.set(parent, [...(byParent.get(parent) ?? []), child])
    else orphans.push(child)
  }
  const nested = list.flatMap((agent) => [agent, ...(byParent.get(agent.id) ?? [])])
  return { agents: [...nested, ...splitAgents, ...workflowAgents, ...orphans].slice(0, MAX_PERSISTED_AGENTS), perModel }
}
