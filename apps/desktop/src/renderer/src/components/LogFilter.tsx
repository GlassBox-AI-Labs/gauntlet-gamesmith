import type { LoopLogLine } from '../../../shared/loop'
import {
  PRIMARY_AGENT,
  roundChipLabel,
  type LogFilterState,
} from '@/lib/log-filter'

export {
  agentFilterKey,
  ALL_LOG_FILTER,
  KIND_COLORS,
  lineMatchesFilter,
  logLineColor,
  PRIMARY_AGENT,
  roundChipLabel,
  type LogFilterState,
} from '@/lib/log-filter'

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
