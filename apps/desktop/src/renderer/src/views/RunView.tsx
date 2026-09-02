import { useEffect, useRef, useState } from 'react'
import {
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronRight,
  Download,
  FolderGit2,
  FolderPlus,
  LoaderCircle,
  Pencil,
  Play,
  Plus,
  Sparkles,
  Square,
  Upload,
  X,
} from 'lucide-react'
import { CritiqueRoundView } from '@/views/CritiquePanel'
import { PromptBrowser } from '@/views/PromptBrowser'
import { ReferenceStudyPanel } from '@/views/ReferenceStudyPanel'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import type { AgentMetric, CritiqueRound, LoopLogLine, LoopModels, LoopSnapshot, PlayState, ReferenceStudy, RunRecord } from '../../../shared/loop'
import { buildCriticPrompt } from '../../../shared/prompts'
import { elapsedThroughRunMs, elapsedToRunStartMs, runtimeMs } from '../../../shared/run-timing'
import {
  AGENT_EFFORTS,
  AGENT_MODEL_CHOICES,
  DEFAULT_CRITIC,
  DEFAULT_IMPLEMENTER,
  DEFAULT_RESEARCH,
  describeCritic,
  modelLabel,
  orchestratorEfforts,
  SOLO_SUBAGENT,
  type CriticFields,
  type ImplementerFields,
  type ResearchFields,
} from '../../../shared/models'

const LOG_LIMIT = 1500
const ROUNDS_PAGE_SIZE = 3

const KIND_COLORS: Record<string, string> = {
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

const STATUS_STYLES: Record<string, string> = {
  running: 'bg-amber-500/15 text-amber-300 border-amber-500/40',
  passed: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40',
  exhausted: 'bg-[#3a3535] text-[#c9c3c0] border-[#4a4444]',
  stopped: 'bg-[#3a3535] text-[#c9c3c0] border-[#4a4444]',
  failed: 'bg-red-500/15 text-red-300 border-red-500/40',
  succeeded: 'bg-emerald-500/10 text-emerald-300/90 border-transparent',
  queued: 'bg-[#2c2828] text-[#96908d] border-transparent',
  cancelled: 'bg-[#2c2828] text-[#96908d] border-transparent',
  interrupted: 'bg-[#2c2828] text-[#96908d] border-transparent',
}

function fmtTokens(n: number | null | undefined): string {
  if (n == null) return '—'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

/**
 * Working right now: not finished, and it wrote something in the last 90s.
 * A run that ended long ago fails the time test on its own, so a finished
 * run's breakdown shows no live dots without tracking that separately.
 */
function agentActive(agent: AgentMetric): boolean {
  return !agent.done && agent.lastTs != null && Date.now() - new Date(agent.lastTs).getTime() < 90_000
}

function fmtDuration(ms: number | null | undefined): string {
  if (ms == null) return '—'
  const totalSec = Math.round(ms / 1000)
  const pad = (n: number): string => String(n).padStart(2, '0')
  const h = Math.floor(totalSec / 3600)
  const mmss = `${pad(Math.floor(totalSec / 60) % 60)}:${pad(totalSec % 60)}`
  return h > 0 ? `${pad(h)}:${mmss}` : mmss
}

function fmtTs(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toTimeString().slice(0, 8)
}

function projectName(workspaceDir: string): string {
  return workspaceDir.split(/[\\/]/).filter(Boolean).at(-1) ?? 'Choose project'
}

function RunModelSummary({ models }: { models: LoopModels }): React.JSX.Element {
  const implementer = models.subagentModel
    ? `${modelLabel(models.subagentModel)} · ${models.subagentEffort}`
    : 'orchestrator · solo'
  const criticHarness = models.criticHarness === 'codex' ? 'Codex' : 'Claude'
  return (
    <div className="mb-6 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-[#68615f]">
      <span><span className="text-[#857d79]">Orchestrator</span> {modelLabel(models.orchestratorModel)} · {models.orchestratorEffort}</span>
      <span className="text-[#393433]" aria-hidden="true">/</span>
      <span><span className="text-[#857d79]">Implementer</span> {implementer}</span>
      <span className="text-[#393433]" aria-hidden="true">/</span>
      <span><span className="text-[#857d79]">Critique</span> {criticHarness} · {modelLabel(models.criticModel)} · {models.criticEffort}</span>
      <span className="text-[#393433]" aria-hidden="true">/</span>
      <span><span className="text-[#857d79]">Research</span> {models.researchModel ? `${modelLabel(models.researchModel)} · ${models.researchEffort}` : 'no fan-out'}</span>
    </div>
  )
}

function roundNumbers(snapshot: LoopSnapshot): number[] {
  return [...new Set(snapshot.runs.filter((run) => run.round > 0).map((run) => run.round))].sort((a, b) => b - a)
}

function RunSidebar({
  snapshots,
  selectedLoopId,
  selectedRound,
  expandedRuns,
  visibleRounds,
  onNewRun,
  onImportRun,
  onSelectRun,
  onSelectRound,
  onToggleRun,
  onLoadMore,
  onOpenAgents,
}: {
  snapshots: LoopSnapshot[]
  selectedLoopId: string | null
  selectedRound: number | null
  expandedRuns: Set<string>
  visibleRounds: Record<string, number>
  onNewRun: () => void
  onImportRun: () => void
  onSelectRun: (snapshot: LoopSnapshot) => void
  onSelectRound: (snapshot: LoopSnapshot, round: number) => void
  onToggleRun: (loopId: string) => void
  onLoadMore: (loopId: string) => void
  onOpenAgents: () => void
}): React.JSX.Element {
  return (
    <aside className="flex h-screen w-[252px] shrink-0 flex-col border-r border-[#2a2626] bg-[#141112]">
      <div className="px-3 pb-3 pt-5">
        <button
          type="button"
          onClick={onNewRun}
          className="flex w-full items-center gap-2 rounded-lg px-3 py-2.5 text-left text-[14px] font-medium text-[#ded9d6] transition-colors hover:bg-white/[0.05] hover:text-white"
        >
          <Plus className="size-4" /> Run
        </button>
        <button
          type="button"
          onClick={onImportRun}
          className="mt-1 flex w-full items-center gap-2 rounded-lg px-3 py-2.5 text-left text-[13px] text-[#918a87] transition-colors hover:bg-white/[0.05] hover:text-[#ded9d6]"
        >
          <Download className="size-4" /> Import run
        </button>
      </div>
      <div className="border-t border-[#2f2a2b]" />
      <div className="min-h-0 flex-1 overflow-y-auto px-2.5 py-4">
        <div className="mb-2 px-2 text-[13px] font-medium text-[#8d8784]">Runs</div>
        <div className="grid gap-1">
          {snapshots.map((item) => {
            const loopId = item.loop.id
            const rounds = roundNumbers(item)
            const limit = visibleRounds[loopId] ?? ROUNDS_PAGE_SIZE
            const open = expandedRuns.has(loopId)
            const selected = selectedLoopId === loopId
            const label = projectName(item.loop.workspaceDir)
            return (
              <div key={loopId}>
                <div
                  className={`group flex items-center rounded-lg pr-1 transition-colors ${
                    selected ? 'bg-[#302b2b] text-[#eeeae7]' : 'text-[#aaa4a1] hover:bg-white/[0.035] hover:text-[#ded9d6]'
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => onToggleRun(loopId)}
                    className="grid size-8 shrink-0 place-items-center rounded-md text-[#716b68] hover:text-[#c9c3c0]"
                    aria-label={`${open ? 'Collapse' : 'Expand'} ${label}`}
                  >
                    {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
                  </button>
                  <button
                    type="button"
                    onClick={() => onSelectRun(item)}
                    title={item.loop.workspaceDir}
                    className="min-w-0 flex-1 truncate py-2 pr-2 text-left text-[13px]"
                  >
                    {label}
                  </button>
                  {item.loop.status === 'running' && <span className="mr-2 size-1.5 shrink-0 animate-pulse rounded-full bg-amber-400" />}
                </div>
                {open && (
                  <div className="ml-8 border-l border-[#332f2f] pb-1 pl-2 pt-1">
                    {rounds.slice(0, limit).map((round) => {
                      const records = item.runs.filter((run) => run.round === round)
                      const score = records.find((run) => run.verdict)?.verdict?.score
                      const active = records.some((run) => run.status === 'running' || run.status === 'queued')
                      return (
                        <button
                          type="button"
                          key={round}
                          onClick={() => onSelectRound(item, round)}
                          className={`flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-[12px] hover:bg-white/[0.035] hover:text-[#c9c3c0] ${
                            selectedLoopId === loopId && selectedRound === round ? 'bg-white/[0.055] text-[#ded9d6]' : 'text-[#88817e]'
                          }`}
                        >
                          <span>Round {round}</span>
                          <span className={active ? 'text-amber-300' : 'font-mono text-[10px] text-[#68615f]'}>
                            {active ? 'active' : score != null ? score.toFixed(2) : ''}
                          </span>
                        </button>
                      )
                    })}
                    {rounds.length > limit && (
                      <button
                        type="button"
                        onClick={() => onLoadMore(loopId)}
                        className="mt-1 w-full rounded-md px-2 py-1.5 text-left text-[12px] text-[#77706d] hover:bg-white/[0.035] hover:text-[#c9c3c0]"
                      >
                        Load more
                      </button>
                    )}
                  </div>
                )}
              </div>
            )
          })}
          {snapshots.length === 0 && <p className="px-2 py-3 text-xs leading-relaxed text-[#68615f]">Your runs will appear here.</p>}
        </div>
      </div>
      <div className="border-t border-[#2f2a2b] p-3">
        <button
          type="button"
          onClick={onOpenAgents}
          className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-[13px] text-[#88817e] hover:bg-white/[0.04] hover:text-[#ded9d6]"
        >
          <Sparkles className="size-3.5" /> Agents
        </button>
      </div>
    </aside>
  )
}

function ProjectChooser({
  value,
  projects,
  open,
  onOpenChange,
  onChange,
  onAddProject,
}: {
  value: string
  projects: string[]
  open: boolean
  onOpenChange: (open: boolean) => void
  onChange: (project: string) => void
  onAddProject: () => void
}): React.JSX.Element {
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => onOpenChange(!open)}
        className="flex max-w-[360px] items-center gap-2 rounded-lg px-2.5 py-2 text-sm font-medium text-[#ded9d6] hover:bg-white/[0.05]"
      >
        <FolderGit2 className="size-4 text-[#bda99f]" />
        <span className="truncate">{projectName(value)}</span>
        <ChevronDown className={`size-3.5 text-[#77706d] transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="absolute left-0 top-[calc(100%+8px)] z-30 w-[300px] overflow-hidden rounded-xl border border-[#443e3d] bg-[#282424] py-1.5 shadow-2xl">
          <div className="max-h-[280px] overflow-y-auto px-1.5">
            {projects.map((project) => (
              <button
                type="button"
                key={project}
                onClick={() => {
                  onChange(project)
                  onOpenChange(false)
                }}
                className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm text-[#c9c3c0] hover:bg-white/[0.055] hover:text-white"
                title={project}
              >
                <FolderGit2 className="size-4 shrink-0 text-[#a9968d]" />
                <span className="min-w-0 flex-1 truncate">{projectName(project)}</span>
                {project === value && <Check className="size-4 shrink-0" />}
              </button>
            ))}
          </div>
          <div className="mt-1 border-t border-[#403a39] px-1.5 pt-1.5">
            <button
              type="button"
              onClick={onAddProject}
              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm text-[#aaa4a1] hover:bg-white/[0.055] hover:text-white"
            >
              <FolderPlus className="size-4" /> Add project
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * Agents the ultracode orchestrator ran through the Workflow tool. They never
 * reach the message stream, so their numbers come off disk and read differently
 * from stream agents: one scalar token count, plus a phase and a live state.
 */
function WorkflowAgents({ agents }: { agents: AgentMetric[] }): React.JSX.Element | null {
  const workflow = agents.filter((agent) => agent.source === 'workflow')
  if (workflow.length === 0) return null
  const phases: { phase: string; agents: AgentMetric[] }[] = []
  for (const agent of workflow) {
    const phase = agent.phase ?? 'workflow'
    const last = phases.at(-1)
    if (last && last.phase === phase) last.agents.push(agent)
    else phases.push({ phase, agents: [agent] })
  }
  const totalTokens = workflow.reduce((sum, a) => sum + (a.totalTokens ?? 0), 0)
  const totalCost = workflow.reduce((sum, a) => sum + (a.costUsd ?? 0), 0)
  const running = workflow.filter((a) => a.state !== 'done').length
  return (
    <>
      <div className="mt-1 text-[#c0aee6]">
        ⇉ workflow fan-out · {workflow.length} agents{running > 0 ? ` (${running} running)` : ''} · {fmtTokens(totalTokens)} tokens · $
        {totalCost.toFixed(2)}
      </div>
      {phases.map((group, index) => (
        <div key={`${group.phase}-${index}`} className="pl-5">
          <div className="text-[#8f8a87]">{group.phase}</div>
          {group.agents.map((agent) => (
            <div key={agent.id} className="pl-4 text-[#a89f9a]">
              <span className={agent.state === 'done' ? 'text-[#a9e5b8]' : 'text-[#f2d98c]'}>{agent.state === 'done' ? '✓' : '⋯'}</span>{' '}
              {agent.label}
              <span className="text-[#68615f]">
                {' '}
                ({agent.model ?? '?'}
                {agent.agentType ? `, ${agent.agentType}` : ''})
              </span>{' '}
              · {agent.costUsd != null ? `$${agent.costUsd.toFixed(2)}` : '$—'} · in {fmtTokens(agent.tokens.input + agent.tokens.cacheRead)} · out{' '}
              {fmtTokens(agent.tokens.output)} · {agent.toolCalls ?? 0} tools · {fmtDuration(agent.durationMs)}
              {agent.prompt && (
                <details className="pl-4">
                  <summary className="cursor-pointer text-[#68615f] hover:text-[#96908d]">task given to this agent</summary>
                  <pre className="mt-1 max-h-64 overflow-y-auto whitespace-pre-wrap rounded border border-[#332e2e] bg-[#141010] p-2 text-[10px] leading-relaxed text-[#8f8a87]">
                    {agent.prompt}
                  </pre>
                </details>
              )}
              {agent.note && <div className="pl-4 text-[#68615f]">{agent.note}</div>}
            </div>
          ))}
        </div>
      ))}
    </>
  )
}

/** Re-renders once a second so live runtimes count up. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [active])
  return active ? now : Date.now()
}

function RunRow({
  run,
  loopCreatedAt,
  timing,
  loopId,
  critique,
  expanded,
  onToggle,
}: {
  run: RunRecord
  loopCreatedAt: string
  timing: 'elapsed' | 'runtime'
  loopId: string
  critique?: CritiqueRound
  expanded: boolean
  onToggle: () => void
}): React.JSX.Element {
  const hasDetail = Boolean(critique) || Boolean(run.metrics && run.metrics.agents.length > 0)
  const score = run.verdict ? run.verdict.score.toFixed(2) : run.role === 'implement' ? '' : '—'
  const elapsedMs = elapsedThroughRunMs(loopCreatedAt, run)
  const startedMs = elapsedToRunStartMs(loopCreatedAt, run)
  const elapsedTitle =
    elapsedMs == null
      ? undefined
      : startedMs != null && startedMs !== elapsedMs
        ? `Started ${fmtDuration(startedMs)} into the loop · reached this point after ${fmtDuration(elapsedMs)} wall-clock time`
        : `Reached this point after ${fmtDuration(elapsedMs)} wall-clock time`
  return (
    <>
      <TableRow
        className={`border-[#3b3636] ${hasDetail ? 'cursor-pointer hover:bg-white/[0.03]' : 'hover:bg-transparent'}`}
        onClick={hasDetail ? onToggle : undefined}
      >
        <TableCell className="w-8 px-2 py-2.5 text-[#68615f]">
          {hasDetail ? (expanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />) : null}
        </TableCell>
        <TableCell className="px-2 py-2.5 text-[#ded9d6]">{run.role === 'reference' ? '—' : run.round}</TableCell>
        <TableCell className="px-2 py-2.5">
          <span className={run.role === 'reference' ? 'text-amber-300' : run.role === 'implement' ? 'text-[#e9c9bc]' : 'text-[#9ad1c6]'}>{run.role}</span>
        </TableCell>
        <TableCell className="px-2 py-2.5 font-mono text-[11px] text-[#96908d]">{run.model ?? '—'}</TableCell>
        <TableCell className="px-2 py-2.5">
          {run.status === 'running' ? (
            <span className="flex items-center gap-1.5 text-amber-300">
              <LoaderCircle className="size-3 animate-spin" /> running
            </span>
          ) : (
            <span className={STATUS_STYLES[run.status]?.split(' ')[1] ?? 'text-[#96908d]'}>{run.status}</span>
          )}
        </TableCell>
        <TableCell className="px-2 py-2.5 font-mono text-[#f2d98c]">
          {score}
          {run.verdict?.pass ? ' ✓' : ''}
        </TableCell>
        <TableCell className="px-2 py-2.5 font-mono text-[#9fb2c8]">{run.costUsd != null ? `$${run.costUsd.toFixed(2)}` : '—'}</TableCell>
        <TableCell className="px-2 py-2.5 font-mono text-[11px] text-[#96908d]">
          {fmtTokens(run.inputTokens)} / {fmtTokens(run.outputTokens)}
        </TableCell>
        <TableCell
          className={`px-2 py-2.5 font-mono text-[11px] ${timing === 'elapsed' ? 'text-[#b8aaa4]' : 'text-[#96908d]'}`}
          title={timing === 'elapsed' ? elapsedTitle : undefined}
        >
          {timing === 'elapsed' ? (elapsedMs == null ? '—' : `+${fmtDuration(elapsedMs)}`) : fmtDuration(runtimeMs(run))}
        </TableCell>
      </TableRow>
      {expanded && (critique || run.metrics) && (
        <TableRow className="border-[#3b3636] hover:bg-transparent">
          <TableCell colSpan={9} className="min-w-0 overflow-hidden whitespace-normal bg-[#151111] px-4 py-3">
            <div className="min-w-0 max-w-full overflow-hidden">
            {critique && (
              <div className="mb-3">
                <CritiqueRoundView loopId={loopId} round={critique} />
              </div>
            )}
            <div className="grid gap-1.5 font-mono text-[11px]">
              {(run.metrics?.agents ?? [])
                .filter((agent) => agent.source !== 'workflow')
                .map((agent) => (
                  <div key={agent.id} className={agent.id === 'orchestrator' || agent.id === 'critic' ? 'text-[#ded9d6]' : 'pl-5 text-[#a89f9a]'}>
                    {/* Transparent when idle so every row keeps the same indent. */}
                    <span
                      className={`mr-1.5 inline-block size-1.5 rounded-full align-middle ${agentActive(agent) ? 'animate-pulse bg-emerald-400' : 'bg-transparent'}`}
                    />
                    {agent.id !== 'orchestrator' && agent.id !== 'critic' ? '↳ ' : ''}
                    {agent.label}
                    <span className="text-[#68615f]"> ({agent.model ?? '?'})</span> · {agent.messages} msgs · in {fmtTokens(agent.tokens.input)} · out{' '}
                    {fmtTokens(agent.tokens.output)} · cache r/w {fmtTokens(agent.tokens.cacheRead)}/{fmtTokens(agent.tokens.cacheWrite)}
                  </div>
                ))}
              <WorkflowAgents agents={run.metrics?.agents ?? []} />
              {Object.entries(run.metrics?.perModel ?? {}).map(([model, mu]) => (
                <div key={model} className="text-[#9fb2c8]">
                  {model}: {mu.costUsd != null ? `$${mu.costUsd.toFixed(2)}` : '$—'} · in {fmtTokens(mu.tokens.input)} · out {fmtTokens(mu.tokens.output)}
                </div>
              ))}
            </div>
            </div>
          </TableCell>
        </TableRow>
      )}
    </>
  )
}

export function RunView({ onOpenAgents }: { onOpenAgents: () => void }): React.JSX.Element {
  const [snapshots, setSnapshots] = useState<LoopSnapshot[]>([])
  const [snapshot, setSnapshot] = useState<LoopSnapshot | null>(null)
  const [lines, setLines] = useState<LoopLogLine[]>([])
  const [composing, setComposing] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [prompt, setPrompt] = useState('')
  const [workspaceDir, setWorkspaceDir] = useState('')
  const [projectOpen, setProjectOpen] = useState(false)
  const [maxRounds, setMaxRounds] = useState('10')
  const [budget, setBudget] = useState('')
  const [impl, setImpl] = useState<ImplementerFields>(DEFAULT_IMPLEMENTER)
  const [critic, setCritic] = useState<CriticFields>(DEFAULT_CRITIC)
  const [research, setResearch] = useState<ResearchFields>(DEFAULT_RESEARCH)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [expandedRuns, setExpandedRuns] = useState<Set<string>>(new Set())
  const [visibleRounds, setVisibleRounds] = useState<Record<string, number>>({})
  const [selectedRound, setSelectedRound] = useState<number | null>(null)
  const [renaming, setRenaming] = useState(false)
  const [titleDraft, setTitleDraft] = useState('')
  const [play, setPlay] = useState<PlayState>({ running: false, url: null, error: null, round: null })
  const [referenceStudies, setReferenceStudies] = useState<Map<string, ReferenceStudy>>(new Map())
  const [detailTab, setDetailTab] = useState<'activity' | 'references'>('activity')
  const loopIdRef = useRef<string | null>(null)
  const mainRef = useRef<HTMLElement | null>(null)
  const logRef = useRef<HTMLDivElement | null>(null)
  const stickRef = useRef(true)

  useEffect(() => {
    const removeUpdate = window.loops.onUpdate((snap) => {
      if (!loopIdRef.current || snap.loop.id === loopIdRef.current) {
        loopIdRef.current = snap.loop.id
        setSnapshot(snap)
      }
      setSnapshots((current) => {
        const next = [snap, ...current.filter((item) => item.loop.id !== snap.loop.id)]
        return next.sort((a, b) => b.loop.createdAt.localeCompare(a.loop.createdAt))
      })
    })
    const removeLog = window.loops.onLog((line) => {
      if (line.loopId !== loopIdRef.current) return
      setLines((current) => {
        const next = [...current, line]
        return next.length > LOG_LIMIT ? next.slice(next.length - LOG_LIMIT) : next
      })
      if (line.runId) {
        setReferenceStudies((current) => {
          const study = current.get(line.runId!)
          if (!study) return current
          const next = new Map(current)
          next.set(line.runId!, { ...study, logs: [...study.logs, line].slice(-500) })
          return next
        })
      }
    })
    void (async () => {
      const [all, snap, defaultDir] = await Promise.all([window.loops.list(), window.loops.active(), window.loops.defaultWorkspace()])
      setSnapshots(all)
      const initial = snap ?? all[0] ?? null
      setWorkspaceDir((current) => current || initial?.loop.workspaceDir || defaultDir)
      if (initial) {
        loopIdRef.current = initial.loop.id
        setSnapshot(initial)
        setImpl({
          orchestratorModel: initial.loop.models.orchestratorModel,
          orchestratorEffort: initial.loop.models.orchestratorEffort,
          subagentModel: initial.loop.models.subagentModel,
          subagentEffort: initial.loop.models.subagentEffort,
        })
        setCritic({ criticModel: initial.loop.models.criticModel, criticEffort: initial.loop.models.criticEffort })
        setResearch({ researchModel: initial.loop.models.researchModel, researchEffort: initial.loop.models.researchEffort })
        setExpandedRuns(new Set([initial.loop.id]))
        setLines(await window.loops.log(initial.loop.id))
      } else {
        setComposing(true)
      }
      setLoaded(true)
    })()
    return () => {
      removeUpdate()
      removeLog()
    }
  }, [])

  useEffect(() => {
    if (stickRef.current && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [lines])

  const [critiqueRounds, setCritiqueRounds] = useState<CritiqueRound[]>([])
  const finishedCritiques = snapshot?.runs.filter((r) => r.role === 'critique' && r.status !== 'running').length ?? 0

  const activeLoopId = snapshot?.loop.id ?? null
  const referenceSignature = snapshot?.runs
    .filter((run) => run.role === 'reference')
    .map((run) => `${run.id}:${run.status}:${run.inputTokens ?? 0}:${run.outputTokens ?? 0}`)
    .join('|') ?? ''

  useEffect(() => {
    if (!activeLoopId) return
    void window.loops.critique(activeLoopId).then(setCritiqueRounds)
  }, [activeLoopId, finishedCritiques])
  useEffect(() => {
    if (!activeLoopId || !snapshot) return
    const runs = snapshot.runs.filter((run) => run.role === 'reference')
    void Promise.all(runs.map((run) => window.loops.reference(activeLoopId, run.id))).then((studies) => {
      setReferenceStudies(new Map(studies.filter((study): study is ReferenceStudy => study != null).map((study) => [study.runId, study])))
    })
  }, [activeLoopId, referenceSignature])
  useEffect(() => {
    if (!activeLoopId) return
    void window.loops.playState(activeLoopId).then(setPlay)
    return window.loops.onPlayState((state) => {
      if (state.loopId === activeLoopId) setPlay(state)
    })
  }, [activeLoopId])

  const loop = snapshot?.loop ?? null
  const running = loop?.status === 'running'
  const now = useNow(running)
  const liveRun = snapshot?.runs.find((r) => r.status === 'running') ?? null
  const referenceRuns = snapshot?.runs.filter((run) => run.role === 'reference') ?? []
  const activeReferenceRun = referenceRuns.at(-1)
  const activeReferenceStudy = activeReferenceRun ? referenceStudies.get(activeReferenceRun.id) : undefined
  const visibleRuns = selectedRound == null ? (snapshot?.runs ?? []) : (snapshot?.runs.filter((run) => run.round === selectedRound) ?? [])
  const visibleRunIds = new Set(visibleRuns.map((run) => run.id))
  const visibleLines = selectedRound == null ? lines : lines.filter((line) => line.runId && visibleRunIds.has(line.runId))
  const initialImplementPrompt = snapshot?.runs.find((run) => run.role === 'implement')?.prompt ?? ''
  const systemPrompt = loop && initialImplementPrompt.startsWith(loop.prompt)
    ? initialImplementPrompt.slice(loop.prompt.length).trim()
    : initialImplementPrompt
  // The rubric is deterministic loop configuration, so show it from the
  // moment a loop is created instead of waiting for the first critique job.
  const critiqueRubric = snapshot?.runs.find((run) => run.role === 'critique')?.prompt
    ?? (loop ? buildCriticPrompt(loop.prompt, 1, snapshot?.runs.some((run) => run.role === 'reference') ? `reference/${loop.id}` : 'reference') : '')
  const detailStatus = selectedRound == null
    ? loop?.status
    : visibleRuns.some((run) => run.status === 'running')
      ? 'running'
      : (visibleRuns.at(-1)?.status ?? 'queued')
  const selectedCritique = selectedRound == null ? undefined : critiqueRounds.find((round) => round.round === selectedRound)
  // The exact prompts those runs were launched with — the implement one carries
  // the previous round's critic verdict and findings baked in.
  const roundImplementRun = selectedRound == null ? undefined : visibleRuns.filter((run) => run.role === 'implement').at(-1)
  const roundCritiqueRun = selectedRound == null ? undefined : visibleRuns.filter((run) => run.role === 'critique').at(-1)
  const totals = visibleRuns.reduce(
    (sum, run) => ({
      costUsd: sum.costUsd + (run.costUsd ?? 0),
      inputTokens: sum.inputTokens + (run.inputTokens ?? 0),
      outputTokens: sum.outputTokens + (run.outputTokens ?? 0),
      durationMs: sum.durationMs + (runtimeMs(run, now) ?? 0),
      bestScore: Math.max(sum.bestScore, run.verdict?.score ?? 0),
      hasScore: sum.hasScore || Boolean(run.verdict),
    }),
    { costUsd: 0, inputTokens: 0, outputTokens: 0, durationMs: 0, bestScore: 0, hasScore: false },
  )
  const totalTokens = totals.inputTokens + totals.outputTokens
  const playingSelectedBuild = play.running && play.round === selectedRound
  const selectedRevision = selectedRound == null ? null : (visibleRuns.find((run) => run.role === 'implement' && run.status === 'succeeded')?.revision ?? null)
  const selectedRoundPlayable = selectedRevision != null
  const visibleElapsedMs = visibleRuns.reduce<number | null>((latest, run) => {
    const elapsed = loop ? elapsedThroughRunMs(loop.createdAt, run) : null
    return elapsed == null ? latest : Math.max(latest ?? 0, elapsed)
  }, null)

  const start = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const result = await window.loops.start({
        prompt,
        workspaceDir,
        maxRounds: Number(maxRounds) || 10,
        budgetUsd: budget.trim() ? Number(budget) : null,
        ...impl,
        ...critic,
        ...research,
      })
      if (!result.ok) {
        setError(result.error ?? 'Failed to start.')
        return
      }
      loopIdRef.current = result.loopId ?? null
      setLines([])
      setExpanded(new Set())
      setSelectedRound(null)
      setDetailTab('activity')
      setComposing(false)
      setProjectOpen(false)
      const snap = result.loopId ? await window.loops.get(result.loopId) : await window.loops.active()
      if (snap) {
        setSnapshot(snap)
        setSnapshots((current) => [snap, ...current.filter((item) => item.loop.id !== snap.loop.id)])
        setExpandedRuns((current) => new Set(current).add(snap.loop.id))
      }
      setPrompt('')
    } finally {
      setBusy(false)
    }
  }

  const selectRun = async (next: LoopSnapshot, round: number | null = null): Promise<void> => {
    loopIdRef.current = next.loop.id
    setSnapshot(next)
    setImpl({
      orchestratorModel: next.loop.models.orchestratorModel,
      orchestratorEffort: next.loop.models.orchestratorEffort,
      subagentModel: next.loop.models.subagentModel,
      subagentEffort: next.loop.models.subagentEffort,
    })
    setCritic({ criticModel: next.loop.models.criticModel, criticEffort: next.loop.models.criticEffort })
    setResearch({ researchModel: next.loop.models.researchModel, researchEffort: next.loop.models.researchEffort })
    setSelectedRound(round)
    setDetailTab('activity')
    setRenaming(false)
    setComposing(false)
    setProjectOpen(false)
    setExpanded(new Set())
    setNotice(null)
    setLines(await window.loops.log(next.loop.id))
  }

  const beginNewRun = (): void => {
    setComposing(true)
    setSelectedRound(null)
    setDetailTab('activity')
    setPrompt('')
    setError(null)
    setNotice(null)
    setProjectOpen(false)
  }

  const saveTitle = async (): Promise<void> => {
    if (!loop) return
    const title = titleDraft.trim()
    if (!title || title === loop.title) {
      setRenaming(false)
      setTitleDraft(loop.title)
      return
    }
    const updated = await window.loops.rename(loop.id, title)
    if (!updated) return
    setSnapshot((current) => current && current.loop.id === updated.id ? { ...current, loop: updated } : current)
    setSnapshots((current) => current.map((item) => item.loop.id === updated.id ? { ...item, loop: updated } : item))
    setTitleDraft(updated.title)
    setRenaming(false)
  }

  const importRun = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const result = await window.loops.importRun()
      if (result.canceled) return
      if (!result.ok || !result.snapshot) {
        setError(result.error ?? 'Failed to import run.')
        return
      }
      const imported = result.snapshot
      const importedSnapshots = result.snapshots ?? [imported]
      const importedIds = new Set(importedSnapshots.map((item) => item.loop.id))
      loopIdRef.current = imported.loop.id
      setSnapshot(imported)
      setSnapshots((current) => [...importedSnapshots, ...current.filter((item) => !importedIds.has(item.loop.id))])
      setWorkspaceDir(imported.loop.workspaceDir)
      setLines(await window.loops.log(imported.loop.id, LOG_LIMIT))
      setExpanded(new Set())
      setExpandedRuns((current) => new Set(current).add(imported.loop.id))
      setSelectedRound(null)
      setDetailTab('activity')
      setRenaming(false)
      setProjectOpen(false)
      setComposing(false)
      setNotice(`Opened the complete run folder at ${imported.loop.workspaceDir}. Its project files and SQLite history remain together.`)
    } finally {
      setBusy(false)
    }
  }

  const exportRun = async (): Promise<void> => {
    if (!loop) return
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const result = await window.loops.exportRun(loop.id)
      if (result.canceled) return
      if (!result.ok) {
        setError(result.error ?? 'Failed to export run.')
        return
      }
      setNotice(`Exported the complete project and SQLite history to ${result.filePath ?? 'the selected folder'}.`)
    } finally {
      setBusy(false)
    }
  }

  const projects = [...new Set([workspaceDir, ...snapshots.map((item) => item.loop.workspaceDir)].filter(Boolean))]

  const selectDetailTab = (tab: 'activity' | 'references'): void => {
    setDetailTab(tab)
    requestAnimationFrame(() => mainRef.current?.scrollTo({ top: 0 }))
  }

  if (!loaded) {
    return (
      <main className="grid h-screen place-items-center bg-[#100d0e]">
        <LoaderCircle className="size-5 animate-spin text-[#68615f]" />
      </main>
    )
  }

  return (
    <div className="flex h-screen overflow-hidden bg-[#100d0e]">
      <RunSidebar
        snapshots={snapshots}
        selectedLoopId={composing ? null : (snapshot?.loop.id ?? null)}
        selectedRound={selectedRound}
        expandedRuns={expandedRuns}
        visibleRounds={visibleRounds}
        onNewRun={beginNewRun}
        onImportRun={() => void importRun()}
        onSelectRun={(next) => void selectRun(next)}
        onSelectRound={(next, round) => void selectRun(next, round)}
        onToggleRun={(loopId) =>
          setExpandedRuns((current) => {
            const next = new Set(current)
            if (next.has(loopId)) next.delete(loopId)
            else next.add(loopId)
            return next
          })
        }
        onLoadMore={(loopId) =>
          setVisibleRounds((current) => ({ ...current, [loopId]: (current[loopId] ?? ROUNDS_PAGE_SIZE) + ROUNDS_PAGE_SIZE }))
        }
        onOpenAgents={onOpenAgents}
      />
      <main ref={mainRef} className="min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-[min(980px,calc(100%-48px))] py-12 max-sm:w-[calc(100%-28px)] max-sm:py-7">

      {notice && <p className="mb-5 rounded-lg border border-emerald-700/40 bg-emerald-950/20 px-3 py-2.5 text-xs text-emerald-300">{notice}</p>}

      {composing || !loop ? (
        <Card className="gap-0 overflow-visible border-[#393433] bg-[#1d1919] p-0 shadow-2xl shadow-black/20">
          <div className="border-b border-[#393433] p-3">
            <ProjectChooser
              value={workspaceDir}
              projects={projects}
              open={projectOpen}
              onOpenChange={setProjectOpen}
              onChange={setWorkspaceDir}
              onAddProject={() => {
                void window.loops.pickWorkspace().then((dir) => {
                  if (dir) setWorkspaceDir(dir)
                  setProjectOpen(false)
                })
              }}
            />
          </div>
          <textarea
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            rows={14}
            spellCheck={false}
            autoFocus
            placeholder="What do you want to work on?"
            className="min-h-[360px] w-full resize-y bg-transparent px-5 py-5 text-[15px] leading-relaxed text-[#eeeae7] outline-none placeholder:text-[#68615f]"
          />
          <div className="mx-5 mb-4 grid gap-3 rounded-lg border border-[#393433] bg-[#161212] p-3.5">
            <div className="grid grid-cols-[92px_1fr_1fr] items-center gap-2.5 max-sm:grid-cols-1">
              <span className="text-xs text-[#7d7772]">Orchestrator</span>
              <Select
                value={impl.orchestratorModel}
                onValueChange={(value) =>
                  setImpl((current) => ({
                    ...current,
                    orchestratorModel: value,
                    // ultracode and ultra belong to different CLIs, so a switch
                    // between harnesses must not carry the old level across.
                    orchestratorEffort: orchestratorEfforts(value).includes(current.orchestratorEffort)
                      ? current.orchestratorEffort
                      : 'high',
                  }))
                }
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {AGENT_MODEL_CHOICES.map((model) => <SelectItem key={model.id} value={model.id}>{model.label}</SelectItem>)}
                </SelectContent>
              </Select>
              <Select value={impl.orchestratorEffort} onValueChange={(value) => setImpl((current) => ({ ...current, orchestratorEffort: value }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {orchestratorEfforts(impl.orchestratorModel).map((effort) => (
                    <SelectItem key={effort} value={effort}>
                      {effort === 'ultracode' ? 'ultracode (xhigh + workflows)' : effort === 'ultra' ? 'ultra (max + delegation)' : effort}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-[92px_1fr_1fr] items-center gap-2.5 max-sm:grid-cols-1">
              <span className="text-xs text-[#7d7772]">Subagents</span>
              <Select
                value={impl.subagentModel ?? SOLO_SUBAGENT}
                onValueChange={(value) => setImpl((current) => ({ ...current, subagentModel: value === SOLO_SUBAGENT ? null : value }))}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {AGENT_MODEL_CHOICES.map((model) => <SelectItem key={model.id} value={model.id}>{model.label}</SelectItem>)}
                  <SelectItem value={SOLO_SUBAGENT}>none (solo)</SelectItem>
                </SelectContent>
              </Select>
              <Select
                value={impl.subagentEffort}
                onValueChange={(value) => setImpl((current) => ({ ...current, subagentEffort: value }))}
                disabled={impl.subagentModel === null}
              >
                <SelectTrigger className={impl.subagentModel === null ? 'opacity-50' : undefined}><SelectValue /></SelectTrigger>
                <SelectContent>
                  {AGENT_EFFORTS.map((effort) => <SelectItem key={effort} value={effort}>{effort}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-[92px_1fr_1fr] items-center gap-2.5 max-sm:grid-cols-1">
              <span className="text-xs text-[#7d7772]">Research</span>
              <Select
                value={research.researchModel ?? SOLO_SUBAGENT}
                onValueChange={(value) => setResearch((current) => ({ ...current, researchModel: value === SOLO_SUBAGENT ? null : value }))}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {AGENT_MODEL_CHOICES.map((model) => <SelectItem key={model.id} value={model.id}>{model.label}</SelectItem>)}
                  <SelectItem value={SOLO_SUBAGENT}>none (no fan-out)</SelectItem>
                </SelectContent>
              </Select>
              <Select
                value={research.researchEffort}
                onValueChange={(value) => setResearch((current) => ({ ...current, researchEffort: value }))}
                disabled={research.researchModel === null}
              >
                <SelectTrigger className={research.researchModel === null ? 'opacity-50' : undefined}><SelectValue /></SelectTrigger>
                <SelectContent>
                  {AGENT_EFFORTS.map((effort) => <SelectItem key={effort} value={effort}>{effort}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-[92px_1fr_1fr] items-center gap-2.5 max-sm:grid-cols-1">
              <span className="text-xs text-[#7d7772]">Critic</span>
              <Select
                value={critic.criticModel}
                onValueChange={(value) => setCritic((current) => ({ ...current, criticModel: value }))}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {AGENT_MODEL_CHOICES.map((model) => <SelectItem key={model.id} value={model.id}>{model.label}</SelectItem>)}
                </SelectContent>
              </Select>
              <Select
                value={critic.criticEffort}
                onValueChange={(value) => setCritic((current) => ({ ...current, criticEffort: value }))}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {AGENT_EFFORTS.map((effort) => <SelectItem key={effort} value={effort}>{effort}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-3 max-sm:grid-cols-1">
              <label className="grid gap-1.5 text-xs text-[#96908d]">
                Max rounds
                <input value={maxRounds} onChange={(event) => setMaxRounds(event.target.value)} inputMode="numeric" className="h-9 rounded-lg border border-[#393433] bg-[#141010] px-3 text-xs text-[#eeeae7] outline-none focus:border-[#5a524f]" />
              </label>
              <label className="grid gap-1.5 text-xs text-[#96908d]">
                Budget $ (optional)
                <input value={budget} onChange={(event) => setBudget(event.target.value)} inputMode="decimal" placeholder="none" className="h-9 rounded-lg border border-[#393433] bg-[#141010] px-3 text-xs text-[#eeeae7] outline-none placeholder:text-[#68615f] focus:border-[#5a524f]" />
              </label>
            </div>
            <p className="text-xs leading-relaxed text-[#7d7772]">
              {modelLabel(impl.orchestratorModel)} at {impl.orchestratorEffort} effort
              {impl.subagentModel ? ` with ${modelLabel(impl.subagentModel)} subagents at ${impl.subagentEffort} effort.` : ' with no subagents.'}{' '}
              {modelLabel(critic.criticModel)} critiques at {critic.criticEffort} effort. {describeCritic(critic.criticModel, impl.subagentModel ?? impl.orchestratorModel)}{' '}
              {research.researchModel ? `Reference Study fans research out to ${modelLabel(research.researchModel)} at ${research.researchEffort} effort.` : 'Reference Study researches without fan-out.'}
            </p>
          </div>
          {error && <p className="mx-5 mb-3 rounded-lg border border-[#603f3f] bg-[#251718] px-3 py-2.5 text-xs text-[#f0aaaa]">{error}</p>}
          <div className="flex justify-end px-5 pb-5">
            <Button
              className="h-10 bg-[#eeeae7] px-5 text-[#1c1716] hover:bg-white"
              disabled={busy || !prompt.trim() || !workspaceDir}
              onClick={() => void start()}
            >
              {busy ? <LoaderCircle className="animate-spin" /> : null} Create
            </Button>
          </div>
        </Card>
      ) : (
        <>
          {selectedRound != null && (
            <button
              type="button"
              onClick={() => setSelectedRound(null)}
              className="mb-4 flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-[#8f8885] hover:bg-white/[0.04] hover:text-[#ded9d6]"
            >
              <ArrowLeft className="size-3.5" /> Run detail
            </button>
          )}
          <div className={`${selectedRound == null ? 'mb-2' : 'mb-6'} flex max-w-3xl items-center gap-2`}>
            {selectedRound == null && renaming ? (
              <>
                <input
                  value={titleDraft}
                  onChange={(event) => setTitleDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') void saveTitle()
                    if (event.key === 'Escape') {
                      setTitleDraft(loop.title)
                      setRenaming(false)
                    }
                  }}
                  autoFocus
                  maxLength={80}
                  aria-label="Run name"
                  className="h-10 min-w-0 flex-1 rounded-lg border border-[#514947] bg-[#181414] px-3 text-[20px] font-semibold text-[#eeeae7] outline-none focus:border-[#716763]"
                />
                <button type="button" onClick={() => void saveTitle()} className="grid size-9 place-items-center rounded-lg text-[#9f9895] hover:bg-white/[0.05] hover:text-white" aria-label="Save run name">
                  <Check className="size-4" />
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setTitleDraft(loop.title)
                    setRenaming(false)
                  }}
                  className="grid size-9 place-items-center rounded-lg text-[#77706d] hover:bg-white/[0.05] hover:text-white"
                  aria-label="Cancel rename"
                >
                  <X className="size-4" />
                </button>
              </>
            ) : (
              <>
                <h1 className="line-clamp-2 text-[22px] font-semibold leading-tight tracking-[-0.02em] text-[#eeeae7]" title={loop.title}>
                  {selectedRound == null ? loop.title : `Round ${selectedRound}`}
                </h1>
                {selectedRound == null && (
                  <button
                    type="button"
                    onClick={() => {
                      setTitleDraft(loop.title)
                      setRenaming(true)
                    }}
                    className="grid size-8 shrink-0 place-items-center rounded-lg text-[#68615f] hover:bg-white/[0.05] hover:text-[#ded9d6]"
                    aria-label="Rename run"
                  >
                    <Pencil className="size-3.5" />
                  </button>
                )}
              </>
            )}
          </div>
          {selectedRound == null && <RunModelSummary models={loop.models} />}
          <div className="mb-5 flex flex-wrap items-center gap-3">
            <Badge className={`border px-2.5 py-1 text-[11px] uppercase tracking-wide ${STATUS_STYLES[detailStatus ?? ''] ?? ''}`}>{detailStatus}</Badge>
            <span className="text-sm text-[#ded9d6]">
              {selectedRound == null
                ? liveRun?.role === 'reference'
                  ? 'reference study · rounds not started'
                  : `round ${loop.round}/${loop.maxRounds}`
                : visibleRuns.length === 1 ? '1 attempt' : `${visibleRuns.length} attempts`}
            </span>
            <span className="font-mono text-sm text-[#9fb2c8]">
              ${totals.costUsd.toFixed(2)} equiv
            </span>
            <span className="font-mono text-sm text-[#b7cbe0]" title={`${totalTokens.toLocaleString()} combined tokens`}>
              {fmtTokens(totalTokens)} tokens
            </span>
            {selectedRevision && (
              <span className="font-mono text-[11px] text-[#8f8885]" title={selectedRevision}>
                commit {selectedRevision.slice(0, 12)}
              </span>
            )}
            <span className="max-w-[320px] truncate font-mono text-[11px] text-[#68615f]" title={loop.workspaceDir}>
              {loop.workspaceDir}
            </span>
            {selectedRound == null && <div className="ml-auto flex items-center gap-2">
              {playingSelectedBuild && play.url && (
                <button
                  type="button"
                  onClick={() => void window.loops.playStart(loop.id)}
                  className="rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2.5 py-1 font-mono text-[11px] text-emerald-300 hover:bg-emerald-500/20"
                  title="Open in browser"
                >
                  {play.url}
                </button>
              )}
              {playingSelectedBuild ? (
                <Button
                  variant="outline"
                  className="border-[#494343] bg-transparent text-[#96908d] hover:bg-white/5 hover:text-white"
                  onClick={() => void window.loops.playStop(loop.id)}
                >
                  <Square /> Stop game
                </Button>
              ) : (
                <Button
                  variant="outline"
                  className="border-emerald-600/50 bg-transparent text-emerald-300 hover:bg-emerald-500/10 hover:text-emerald-200"
                  onClick={() => void window.loops.playStart(loop.id).then(setPlay)}
                >
                  <Play className="fill-current" /> Play
                </Button>
              )}
              <Button
                variant="outline"
                className="border-[#494343] bg-transparent text-[#96908d] hover:bg-white/5 hover:text-white"
                disabled={busy || running}
                title={running ? 'Stop the run first to export an exact folder snapshot' : 'Export the complete project folder and SQLite history'}
                onClick={() => void exportRun()}
              >
                <Upload /> Export
              </Button>
              {running ? (
                <Button
                  variant="outline"
                  className="border-[#6b4a44] bg-transparent text-[#f0b8aa] hover:bg-[#3a2622] hover:text-[#f7cec2]"
                  onClick={() => void window.loops.stop(loop.id)}
                >
                  <Square className="fill-current" /> Stop
                </Button>
              ) : (
                <>
                  {(loop.status === 'stopped' || loop.status === 'exhausted' || loop.status === 'failed') && (
                    <Button
                      variant="outline"
                      className="border-amber-500/50 bg-transparent text-amber-300 hover:bg-amber-500/10 hover:text-amber-200"
                      onClick={() =>
                        void window.loops.resume(loop.id).then((result) => {
                          if (!result.ok) setError(result.error ?? 'Could not resume.')
                        })
                      }
                    >
                      <Play className="fill-current" /> Resume loop
                    </Button>
                  )}
                  <Button
                    variant="outline"
                    className="border-[#494343] bg-transparent text-[#eeeae7] hover:bg-white/5 hover:text-white"
                    onClick={beginNewRun}
                  >
                    <Plus /> New run
                  </Button>
                </>
              )}
            </div>}
            {selectedRound != null && <div className="ml-auto flex items-center gap-2">
              {playingSelectedBuild && play.url && (
                <button
                  type="button"
                  onClick={() => void window.loops.playStart(loop.id, selectedRound)}
                  className="rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2.5 py-1 font-mono text-[11px] text-emerald-300 hover:bg-emerald-500/20"
                  title="Open this round in the browser"
                >
                  {play.url}
                </button>
              )}
              {playingSelectedBuild ? (
                <Button
                  variant="outline"
                  className="border-[#494343] bg-transparent text-[#96908d] hover:bg-white/5 hover:text-white"
                  onClick={() => void window.loops.playStop(loop.id)}
                >
                  <Square /> Stop game
                </Button>
              ) : (
                <Button
                  variant="outline"
                  className="border-emerald-600/50 bg-transparent text-emerald-300 hover:bg-emerald-500/10 hover:text-emerald-200"
                  disabled={!selectedRoundPlayable}
                  title={selectedRoundPlayable ? `Launch commit ${selectedRevision.slice(0, 12)} from round ${selectedRound}` : 'No Git revision was recorded for this round'}
                  onClick={() => void window.loops.playStart(loop.id, selectedRound).then(setPlay)}
                >
                  <Play className="fill-current" /> {selectedRoundPlayable ? `Play round ${selectedRound}` : 'Revision unavailable'}
                </Button>
              )}
            </div>}
          </div>

          {selectedRound == null && loop.stopReason && !running && (
            <p className="mb-5 rounded-lg border border-[#3f3a39] bg-[#1d1918] px-3 py-2.5 text-xs text-[#c9c3c0]">{loop.stopReason}</p>
          )}

          {play.error && (
            <p className="mb-5 rounded-lg border border-[#603f3f] bg-[#251718] px-3 py-2.5 text-xs text-[#f0aaaa]">Play: {play.error}</p>
          )}
          {error && <p className="mb-5 rounded-lg border border-[#603f3f] bg-[#251718] px-3 py-2.5 text-xs text-[#f0aaaa]">{error}</p>}

          {selectedRound == null && (
            <div role="tablist" aria-label="Run detail" className="mb-5 flex border-b border-[#332e2e]">
              <button
                type="button"
                role="tab"
                aria-selected={detailTab === 'activity'}
                onClick={() => selectDetailTab('activity')}
                className={`relative px-3 py-2.5 text-[12px] transition-colors ${
                  detailTab === 'activity' ? 'text-[#eeeae7] after:absolute after:inset-x-0 after:bottom-[-1px] after:h-px after:bg-[#c9b5aa]' : 'text-[#77706d] hover:text-[#c9c3c0]'
                }`}
              >
                Run activity
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={detailTab === 'references'}
                onClick={() => selectDetailTab('references')}
                className={`relative flex items-center gap-2 px-3 py-2.5 text-[12px] transition-colors ${
                  detailTab === 'references' ? 'text-amber-200 after:absolute after:inset-x-0 after:bottom-[-1px] after:h-px after:bg-amber-300' : 'text-[#77706d] hover:text-[#c9c3c0]'
                }`}
              >
                Reference assets
                {activeReferenceStudy && (
                  <span className="rounded-full border border-[#49413a] bg-amber-500/[0.07] px-1.5 py-0.5 font-mono text-[9px] text-amber-300/80">
                    {activeReferenceStudy.pack.images.length + activeReferenceStudy.pack.motion.length + activeReferenceStudy.pack.videos.length}
                  </span>
                )}
              </button>
            </div>
          )}

          {selectedRound == null && detailTab === 'references' ? (
            <section role="tabpanel" className="grid min-w-0 gap-4 overflow-hidden">
              <div className="min-w-0 overflow-hidden rounded-lg border border-[#332e2e] bg-[#151212] p-4">
                {activeReferenceStudy ? (
                  <ReferenceStudyPanel loopId={loop.id} study={activeReferenceStudy} />
                ) : referenceRuns.length > 0 ? (
                  <div className="flex items-center gap-2 py-10 text-sm text-[#77706d]"><LoaderCircle className="size-4 animate-spin" /> Loading Reference Pack…</div>
                ) : (
                  <div className="py-10 text-center">
                    <div className="text-sm text-[#aaa4a1]">No Reference Study was recorded for this run.</div>
                    <div className="mt-1 text-xs text-[#68615f]">Reference assets appear here for runs created with the Reference Study workflow.</div>
                  </div>
                )}
              </div>
            </section>
          ) : (
          <>
          {selectedRound == null && (
            <>
              <div className="mb-5 grid grid-cols-4 gap-3 max-md:grid-cols-2">
                <div className="rounded-lg border border-[#332e2e] bg-[#181414] p-3.5">
                  <div className="text-[10px] uppercase tracking-wide text-[#716a67]">Total tokens</div>
                  <div className="mt-1 font-mono text-lg text-[#d7e2ed]" title={totalTokens.toLocaleString()}>{fmtTokens(totalTokens)}</div>
                </div>
                <div className="rounded-lg border border-[#332e2e] bg-[#181414] p-3.5">
                  <div className="text-[10px] uppercase tracking-wide text-[#716a67]">Input / output</div>
                  <div className="mt-1 font-mono text-sm text-[#c2bbb7]">{fmtTokens(totals.inputTokens)} / {fmtTokens(totals.outputTokens)}</div>
                </div>
                <div className="rounded-lg border border-[#332e2e] bg-[#181414] p-3.5">
                  <div className="text-[10px] uppercase tracking-wide text-[#716a67]">Equivalent cost</div>
                  <div className="mt-1 font-mono text-lg text-[#b7cbe0]">${totals.costUsd.toFixed(2)}</div>
                </div>
                <div className="rounded-lg border border-[#332e2e] bg-[#181414] p-3.5">
                  <div className="text-[10px] uppercase tracking-wide text-[#716a67]">Attempts / elapsed</div>
                  <div className="mt-1 font-mono text-sm text-[#c2bbb7]">{visibleRuns.length} / {fmtDuration(visibleElapsedMs)}</div>
                </div>
              </div>
              <div className="mb-5">
                <PromptBrowser
                  prompts={[
                    { id: 'original', title: 'Original', description: 'The operator goal and quality bar for this run.', value: loop.prompt },
                    { id: 'reference', title: 'Reference Study', description: 'Research and validation instructions used to create the frozen Reference Pack.', value: activeReferenceRun?.prompt ?? '' },
                    { id: 'implementer', title: 'System / Implementer', description: 'Implementation rules, delegation contract, and Reference Pack handoff.', value: systemPrompt },
                    { id: 'critique', title: 'Critique', description: 'Evaluation protocol, evidence requirements, scoring rubric, and passing threshold.', value: critiqueRubric },
                  ]}
                />
              </div>
            </>
          )}

          {selectedRound != null && (
            <div className="mb-5">
              <PromptBrowser
                prompts={[
                  {
                    id: `round-${selectedRound}-implement`,
                    title: `Round ${selectedRound} implementer`,
                    description: selectedRound > 1
                      ? `The exact prompt this round's implementer received, including the previous critic's score, summary, and must-fix findings.`
                      : `The exact prompt this round's implementer received: the goal, Reference Pack handoff, and delegation rules.`,
                    value: roundImplementRun?.prompt ?? '',
                  },
                  {
                    id: `round-${selectedRound}-critique`,
                    title: `Round ${selectedRound} critic`,
                    description: `The exact prompt this round's critic received, with its evidence and scoring protocol.`,
                    value: roundCritiqueRun?.prompt ?? '',
                  },
                ]}
              />
            </div>
          )}

          {selectedRound != null && selectedCritique && (
            <section className="mb-5 rounded-lg border border-[#332e2e] bg-[#151212] p-4">
              <h2 className="mb-3 text-[11px] font-medium uppercase tracking-wide text-[#8f8885]">Round {selectedRound} critique</h2>
              <CritiqueRoundView loopId={loop.id} round={selectedCritique} />
            </section>
          )}

          {liveRun?.metrics && liveRun.metrics.agents.length > 0 && (selectedRound == null || liveRun.round === selectedRound) && (
            <div className="mb-5 flex flex-wrap items-center gap-2">
              <span className="mr-1 text-[11px] uppercase tracking-wide text-[#68615f]">Agents</span>
              {liveRun.metrics.agents.map((agent) => {
                const active = agentActive(agent)
                return (
                  <span
                    key={agent.id}
                    className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] ${
                      agent.done ? 'border-[#332e2e] text-[#68615f]' : 'border-[#494343] text-[#ded9d6]'
                    }`}
                  >
                    <span
                      className={`size-1.5 rounded-full ${
                        agent.done ? 'bg-[#68615f]' : active ? 'animate-pulse bg-emerald-400' : 'bg-amber-400/70'
                      }`}
                    />
                    {agent.label}
                    <span className="font-mono text-[10px] text-[#9fb2c8]">
                      {fmtTokens(agent.tokens.input + agent.tokens.cacheRead + agent.tokens.cacheWrite)}/{fmtTokens(agent.tokens.output)}
                    </span>
                    {agent.done && '✓'}
                  </span>
                )
              })}
            </div>
          )}

          <div className="mb-5 overflow-hidden rounded-lg border border-[#332e2e] [&_[data-slot=table-container]]:overflow-x-hidden [&_td]:overflow-hidden [&_th]:overflow-hidden">
            <Table className="table-fixed">
              <colgroup>
                <col className="w-8" />
                <col className="w-[58px]" />
                <col className="w-[76px]" />
                <col className="w-[160px]" />
                <col className="w-[88px]" />
                <col className="w-[58px]" />
                <col className="w-[70px]" />
                <col className="w-[120px]" />
                <col className="w-[85px]" />
              </colgroup>
              <TableHeader>
                <TableRow className="border-[#3b3636] hover:bg-transparent">
                  <TableHead className="w-8 px-2 text-[11px] text-[#68615f]" />
                  <TableHead className="px-2 text-[11px] text-[#68615f]">Round</TableHead>
                  <TableHead className="px-2 text-[11px] text-[#68615f]">Role</TableHead>
                  <TableHead className="px-2 text-[11px] text-[#68615f]">Model</TableHead>
                  <TableHead className="px-2 text-[11px] text-[#68615f]">Status</TableHead>
                  <TableHead className="px-2 text-[11px] text-[#68615f]">Score</TableHead>
                  <TableHead className="px-2 text-[11px] text-[#68615f]">Cost</TableHead>
                  <TableHead className="px-2 text-[11px] text-[#68615f]">Tokens in/out</TableHead>
                  {selectedRound == null ? (
                    <TableHead
                      className="px-2 text-[11px] text-[#68615f]"
                      title="Wall-clock time from the beginning of the loop through this attempt"
                    >
                      Elapsed
                    </TableHead>
                  ) : (
                    <TableHead className="px-2 text-[11px] text-[#68615f]">Runtime</TableHead>
                  )}
                </TableRow>
              </TableHeader>
              <TableBody className="text-xs">
                {visibleRuns.map((run) => (
                  <RunRow
                    key={run.id}
                    run={run}
                    loopCreatedAt={loop.createdAt}
                    timing={selectedRound == null ? 'elapsed' : 'runtime'}
                    loopId={loop.id}
                    critique={run.role === 'critique' ? critiqueRounds.find((c) => c.runId === run.id) : undefined}
                    expanded={expanded.has(run.id)}
                    onToggle={() =>
                      setExpanded((current) => {
                        const next = new Set(current)
                        if (next.has(run.id)) next.delete(run.id)
                        else next.add(run.id)
                        return next
                      })
                    }
                  />
                ))}
                <TableRow className="border-t-2 border-[#4a4342] bg-[#181414] font-medium hover:bg-[#181414]">
                  <TableCell colSpan={5} className="px-4 py-3 text-[11px] uppercase tracking-wide text-[#8f8885]">
                    Total · {visibleRuns.length} attempts
                  </TableCell>
                  <TableCell className="px-2 py-3 font-mono text-[11px] text-[#f2d98c]">
                    {totals.hasScore ? `best ${totals.bestScore.toFixed(2)}` : '—'}
                  </TableCell>
                  <TableCell className="px-2 py-3 font-mono text-[#b7cbe0]">${totals.costUsd.toFixed(2)}</TableCell>
                  <TableCell
                    className="px-2 py-3 font-mono text-[11px] text-[#c2bbb7]"
                    title={`${totalTokens.toLocaleString()} combined tokens · ${totals.inputTokens.toLocaleString()} input (including cache) / ${totals.outputTokens.toLocaleString()} output`}
                  >
                    <div>{fmtTokens(totalTokens)} total</div>
                    <div className="mt-0.5 text-[10px] text-[#77706d]">{fmtTokens(totals.inputTokens)} / {fmtTokens(totals.outputTokens)}</div>
                  </TableCell>
                  <TableCell
                    className={`px-2 py-3 font-mono text-[11px] ${selectedRound == null ? 'text-[#b8aaa4]' : 'text-[#c2bbb7]'}`}
                    title={selectedRound == null ? 'Wall-clock time from the beginning of the loop through the latest visible attempt' : undefined}
                  >
                    {selectedRound == null
                      ? visibleElapsedMs == null
                        ? '—'
                        : `+${fmtDuration(visibleElapsedMs)}`
                      : fmtDuration(totals.durationMs)}
                  </TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </div>

          <div
            ref={logRef}
            onScroll={() => {
              const el = logRef.current
              if (el) stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
            }}
            className="h-[420px] overflow-y-auto rounded-lg border border-[#332e2e] bg-[#0d0a0b] p-3.5 font-mono text-[11px] leading-[1.7]"
          >
            {visibleLines.length === 0 && <span className="text-[#68615f]">Waiting for output…</span>}
            {visibleLines.map((line, index) => (
              <div key={index} className="flex gap-2 whitespace-pre-wrap break-all">
                <span className="shrink-0 text-[#4d4744]">{fmtTs(line.ts)}</span>
                <span className={KIND_COLORS[line.kind] ?? 'text-[#b5afac]'}>{line.text}</span>
              </div>
            ))}
          </div>
          </>
          )}
        </>
      )}
        </div>
      </main>
    </div>
  )
}
