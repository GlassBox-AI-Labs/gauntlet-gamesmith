import { channelForKind, type LoopLogLine } from '../../../shared/loop'
import { logAgentIdForMetric } from '../../../shared/agent-id'

/** Filter key for lines without an agentId — the run's primary agent. */
export const PRIMARY_AGENT = '__primary__'

export interface LogFilterState {
  /** null = all rounds; 0 = the Reference Study. */
  round: number | null
  /** null = all agents; PRIMARY_AGENT = the run's own agent. */
  agent: string | null
}

export const ALL_LOG_FILTER: LogFilterState = { round: null, agent: null }

/** Both dimensions are pure predicates over LoopLogLine fields — no runs join. */
export function lineMatchesFilter(line: LoopLogLine, filter: LogFilterState): boolean {
  if (filter.round != null && line.round !== filter.round) return false
  if (filter.agent == null) return true
  return filter.agent === PRIMARY_AGENT ? !line.agentId : line.agentId === filter.agent
}

/** The log-line filter key an agent-metric row corresponds to, if any. */
export function agentFilterKey(metricId: string): string | null {
  const nestedAgentId = logAgentIdForMetric(metricId)
  if (nestedAgentId) return nestedAgentId
  if (metricId === 'orchestrator' || metricId === 'critic' || metricId === 'reference') return PRIMARY_AGENT
  // Claude-native subagents use their tool-use id directly in both metrics and
  // translated stream events, so the durable id is already the filter key.
  return metricId || null
}

export const KIND_COLORS: Record<string, string> = {
  system: 'text-[#8f8a87]',
  claude: 'text-[#e9c9bc]',
  agent: 'text-[#cfae9d]',
  spawn: 'text-[#c0aee6]',
  tool: 'text-[#7d7772]',
  codex: 'text-[#9ad1c6]',
  thought: 'text-[#a99bc4] italic',
  cmd: 'text-[#7fa8a0]',
  search: 'text-[#8fc7e6]',
  prompt: 'text-[#d9c59e]',
  shot: 'text-[#e6b8d4]',
  stderr: 'text-[#a08b6f]',
  error: 'text-[#f0aaaa]',
  metric: 'text-[#9fb2c8]',
  'raw-stream': 'text-[#9fb2c8]',
  verdict: 'text-[#f2d98c]',
  done: 'text-[#a9e5b8]',
}

const CHANNEL_COLORS: Record<string, string> = {
  prompt: KIND_COLORS.prompt,
  thought: KIND_COLORS.thought,
  tool: KIND_COLORS.tool,
  output: KIND_COLORS.claude,
  search: KIND_COLORS.search,
  media: KIND_COLORS.shot,
  usage: KIND_COLORS.metric,
  error: KIND_COLORS.error,
  system: KIND_COLORS.system,
}

export function logLineColor(line: LoopLogLine): string {
  return KIND_COLORS[line.kind] ?? CHANNEL_COLORS[line.channel ?? channelForKind(line.kind)] ?? 'text-[#b5afac]'
}

export function roundChipLabel(round: number): string {
  return round === 0 ? 'Ref' : `R${round}`
}
