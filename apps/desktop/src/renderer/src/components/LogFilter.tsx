import { channelForKind, type LoopLogLine } from '../../../shared/loop'

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
  if (metricId.startsWith('child:')) return metricId.slice('child:'.length)
  if (metricId === 'orchestrator' || metricId === 'critic' || metricId === 'reference') return PRIMARY_AGENT
  return null
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

function chipClass(selected: boolean): string {
  return `rounded-full border px-2 py-0.5 font-mono text-[10px] transition-colors ${
    selected ? 'border-[#8b7f78] bg-white/[0.08] text-[#eeeae7]' : 'border-[#393433] text-[#88817e] hover:border-[#494343] hover:text-[#c9c3c0]'
  }`
}

export function LogFilterStrip({
  lines,
  filter,
  onChange,
  showRounds = true,
  primaryLabel = 'orchestrator',
}: {
  lines: LoopLogLine[]
  filter: LogFilterState
  onChange: (next: LogFilterState) => void
  showRounds?: boolean
  primaryLabel?: string
}): React.JSX.Element | null {
  const rounds = [...new Set(lines.map((line) => line.round).filter((round): round is number => round != null))].sort((a, b) => a - b)
  const agents = [...new Set(lines.map((line) => line.agentId).filter((agent): agent is string => Boolean(agent)))].sort()
  const withRounds = showRounds && rounds.length > 0
  if (!withRounds && agents.length === 0) return null
  return (
    <div className="mb-2 flex flex-wrap items-center gap-1.5">
      {withRounds && (
        <>
          <span className="mr-0.5 text-[10px] uppercase tracking-wide text-[#68615f]">Round</span>
          <button type="button" className={chipClass(filter.round == null)} onClick={() => onChange({ ...filter, round: null })}>
            all
          </button>
          {rounds.map((round) => (
            <button
              type="button"
              key={round}
              className={chipClass(filter.round === round)}
              onClick={() => onChange({ ...filter, round: filter.round === round ? null : round })}
            >
              {roundChipLabel(round)}
            </button>
          ))}
        </>
      )}
      {agents.length > 0 && (
        <>
          <span className={`mr-0.5 text-[10px] uppercase tracking-wide text-[#68615f] ${withRounds ? 'ml-3' : ''}`}>Agent</span>
          <button type="button" className={chipClass(filter.agent == null)} onClick={() => onChange({ ...filter, agent: null })}>
            all
          </button>
          <button
            type="button"
            className={chipClass(filter.agent === PRIMARY_AGENT)}
            onClick={() => onChange({ ...filter, agent: filter.agent === PRIMARY_AGENT ? null : PRIMARY_AGENT })}
          >
            {primaryLabel}
          </button>
          {agents.map((agent) => (
            <button
              type="button"
              key={agent}
              className={chipClass(filter.agent === agent)}
              onClick={() => onChange({ ...filter, agent: filter.agent === agent ? null : agent })}
            >
              {agent}
            </button>
          ))}
        </>
      )}
    </div>
  )
}
