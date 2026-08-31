import { useEffect, useRef, useState } from 'react'
import {
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronRight,
  Eye,
  FileText,
  FolderGit2,
  FolderPlus,
  LoaderCircle,
  Pencil,
  Play,
  Plus,
  Sparkles,
  Square,
  X,
} from 'lucide-react'
import { CritiquePanel, CritiqueRoundView } from '@/views/CritiquePanel'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import type { CritiqueRound, LoopLogLine, LoopSnapshot, PlayState, RunRecord } from '../../../shared/loop'

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

function fmtDuration(ms: number | null | undefined): string {
  if (ms == null) return '—'
  const totalSec = Math.round(ms / 1000)
  const m = Math.floor(totalSec / 60)
  const s = totalSec % 60
  return m >= 60 ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m` : `${m}m${String(s).padStart(2, '0')}s`
}

function fmtTs(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toTimeString().slice(0, 8)
}

function projectName(workspaceDir: string): string {
  return workspaceDir.split(/[\\/]/).filter(Boolean).at(-1) ?? 'Choose project'
}

function roundNumbers(snapshot: LoopSnapshot): number[] {
  return [...new Set(snapshot.runs.map((run) => run.round))].sort((a, b) => b - a)
}

function RunSidebar({
  snapshots,
  selectedLoopId,
  selectedRound,
  expandedRuns,
  visibleRounds,
  onNewRun,
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
                    aria-label={`${open ? 'Collapse' : 'Expand'} ${item.loop.title}`}
                  >
                    {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
                  </button>
                  <button
                    type="button"
                    onClick={() => onSelectRun(item)}
                    title={item.loop.title}
                    className="min-w-0 flex-1 truncate py-2 pr-2 text-left text-[13px]"
                  >
                    {item.loop.title}
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

function PromptBlock({ title, value }: { title: string; value: string }): React.JSX.Element {
  return (
    <section className="overflow-hidden rounded-lg border border-[#332e2e] bg-[#151212]">
      <h2 className="border-b border-[#332e2e] px-4 py-3 text-[11px] font-medium uppercase tracking-wide text-[#8f8885]">{title}</h2>
      <pre className="max-h-[260px] overflow-y-auto whitespace-pre-wrap px-4 py-3.5 font-mono text-[11px] leading-[1.7] text-[#c9c3c0]">
        {value || 'No additional prompt was recorded.'}
      </pre>
    </section>
  )
}

function RunRow({
  run,
  loopId,
  critique,
  expanded,
  onToggle,
}: {
  run: RunRecord
  loopId: string
  critique?: CritiqueRound
  expanded: boolean
  onToggle: () => void
}): React.JSX.Element {
  const hasDetail = Boolean(critique) || Boolean(run.metrics && run.metrics.agents.length > 0)
  const score = run.verdict ? run.verdict.score.toFixed(2) : run.role === 'critique' ? '—' : ''
  return (
    <>
      <TableRow
        className={`border-[#3b3636] ${hasDetail ? 'cursor-pointer hover:bg-white/[0.03]' : 'hover:bg-transparent'}`}
        onClick={hasDetail ? onToggle : undefined}
      >
        <TableCell className="w-8 px-2 py-2.5 text-[#68615f]">
          {hasDetail ? (expanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />) : null}
        </TableCell>
        <TableCell className="px-2 py-2.5 text-[#ded9d6]">{run.round}</TableCell>
        <TableCell className="px-2 py-2.5">
          <span className={run.role === 'implement' ? 'text-[#e9c9bc]' : 'text-[#9ad1c6]'}>{run.role}</span>
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
        <TableCell className="px-2 py-2.5 font-mono text-[11px] text-[#96908d]">{fmtDuration(run.durationMs)}</TableCell>
      </TableRow>
      {expanded && (critique || run.metrics) && (
        <TableRow className="border-[#3b3636] hover:bg-transparent">
          <TableCell colSpan={9} className="bg-[#151111] px-4 py-3">
            {/* w-0 + min-w-full stops wide media from stretching the table sideways */}
            <div className="w-0 min-w-full">
            {critique && (
              <div className="mb-3">
                <CritiqueRoundView loopId={loopId} round={critique} />
              </div>
            )}
            <div className="grid gap-1.5 font-mono text-[11px]">
              {(run.metrics?.agents ?? []).map((agent) => (
                <div key={agent.id} className={agent.id === 'orchestrator' || agent.id === 'critic' ? 'text-[#ded9d6]' : 'pl-5 text-[#a89f9a]'}>
                  {agent.id !== 'orchestrator' && agent.id !== 'critic' ? '↳ ' : ''}
                  {agent.label}
                  <span className="text-[#68615f]"> ({agent.model ?? '?'})</span> · {agent.messages} msgs · in {fmtTokens(agent.tokens.input)} · out{' '}
                  {fmtTokens(agent.tokens.output)} · cache r/w {fmtTokens(agent.tokens.cacheRead)}/{fmtTokens(agent.tokens.cacheWrite)}
                </div>
              ))}
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
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [expandedRuns, setExpandedRuns] = useState<Set<string>>(new Set())
  const [visibleRounds, setVisibleRounds] = useState<Record<string, number>>({})
  const [selectedRound, setSelectedRound] = useState<number | null>(null)
  const [renaming, setRenaming] = useState(false)
  const [titleDraft, setTitleDraft] = useState('')
  const [reportOpen, setReportOpen] = useState(false)
  const [reportMd, setReportMd] = useState('')
  const [critiqueOpen, setCritiqueOpen] = useState(false)
  const [play, setPlay] = useState<PlayState>({ running: false, url: null, error: null })
  const loopIdRef = useRef<string | null>(null)
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
    })
    void (async () => {
      const [all, snap, defaultDir] = await Promise.all([window.loops.list(), window.loops.active(), window.loops.defaultWorkspace()])
      setSnapshots(all)
      const initial = snap ?? all[0] ?? null
      setWorkspaceDir((current) => current || initial?.loop.workspaceDir || defaultDir)
      if (initial) {
        loopIdRef.current = initial.loop.id
        setSnapshot(initial)
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

  useEffect(() => {
    if (!reportOpen || !snapshot) return
    void window.loops.report(snapshot.loop.id).then(setReportMd)
  }, [reportOpen, snapshot])

  const [critiqueRounds, setCritiqueRounds] = useState<CritiqueRound[]>([])
  const finishedCritiques = snapshot?.runs.filter((r) => r.role === 'critique' && r.status !== 'running').length ?? 0

  const activeLoopId = snapshot?.loop.id ?? null

  useEffect(() => {
    if (!activeLoopId) return
    void window.loops.critique(activeLoopId).then(setCritiqueRounds)
  }, [activeLoopId, finishedCritiques])
  useEffect(() => {
    if (!activeLoopId) return
    void window.loops.playState(activeLoopId).then(setPlay)
    return window.loops.onPlayState((state) => {
      if (state.loopId === activeLoopId) setPlay(state)
    })
  }, [activeLoopId])

  const loop = snapshot?.loop ?? null
  const running = loop?.status === 'running'
  const liveRun = snapshot?.runs.find((r) => r.status === 'running') ?? null
  const visibleRuns = selectedRound == null ? (snapshot?.runs ?? []) : (snapshot?.runs.filter((run) => run.round === selectedRound) ?? [])
  const visibleRunIds = new Set(visibleRuns.map((run) => run.id))
  const visibleLines = selectedRound == null ? lines : lines.filter((line) => line.runId && visibleRunIds.has(line.runId))
  const initialImplementPrompt = snapshot?.runs.find((run) => run.role === 'implement')?.prompt ?? ''
  const systemPrompt = loop && initialImplementPrompt.startsWith(loop.prompt)
    ? initialImplementPrompt.slice(loop.prompt.length).trim()
    : initialImplementPrompt
  const critiqueRubric = snapshot?.runs.find((run) => run.role === 'critique')?.prompt ?? ''
  const detailStatus = selectedRound == null
    ? loop?.status
    : visibleRuns.some((run) => run.status === 'running')
      ? 'running'
      : (visibleRuns.at(-1)?.status ?? 'queued')
  const selectedCritique = selectedRound == null ? undefined : critiqueRounds.find((round) => round.round === selectedRound)
  const totals = visibleRuns.reduce(
    (sum, run) => ({
      costUsd: sum.costUsd + (run.costUsd ?? 0),
      inputTokens: sum.inputTokens + (run.inputTokens ?? 0),
      outputTokens: sum.outputTokens + (run.outputTokens ?? 0),
      durationMs: sum.durationMs + (run.durationMs ?? 0),
      bestScore: Math.max(sum.bestScore, run.verdict?.score ?? 0),
      hasScore: sum.hasScore || Boolean(run.verdict),
    }),
    { costUsd: 0, inputTokens: 0, outputTokens: 0, durationMs: 0, bestScore: 0, hasScore: false },
  )
  const totalTokens = totals.inputTokens + totals.outputTokens

  const start = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const result = await window.loops.start({
        prompt,
        workspaceDir,
        maxRounds: 10,
        budgetUsd: null,
      })
      if (!result.ok) {
        setError(result.error ?? 'Failed to start.')
        return
      }
      loopIdRef.current = result.loopId ?? null
      setLines([])
      setExpanded(new Set())
      setSelectedRound(null)
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
    setSelectedRound(round)
    setRenaming(false)
    setComposing(false)
    setProjectOpen(false)
    setExpanded(new Set())
    setReportOpen(false)
    setCritiqueOpen(false)
    setLines(await window.loops.log(next.loop.id))
  }

  const beginNewRun = (): void => {
    setComposing(true)
    setSelectedRound(null)
    setPrompt('')
    setError(null)
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

  const projects = [...new Set([workspaceDir, ...snapshots.map((item) => item.loop.workspaceDir)].filter(Boolean))]

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
      <main className="min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-[min(980px,calc(100%-48px))] py-12 max-sm:w-[calc(100%-28px)] max-sm:py-7">

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
          <div className="mb-6 flex max-w-3xl items-center gap-2">
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
          <div className="mb-5 flex flex-wrap items-center gap-3">
            <Badge className={`border px-2.5 py-1 text-[11px] uppercase tracking-wide ${STATUS_STYLES[detailStatus ?? ''] ?? ''}`}>{detailStatus}</Badge>
            <span className="text-sm text-[#ded9d6]">
              {selectedRound == null ? `round ${loop.round}/${loop.maxRounds}` : visibleRuns.length === 1 ? '1 attempt' : `${visibleRuns.length} attempts`}
            </span>
            <span className="font-mono text-sm text-[#9fb2c8]">
              ${totals.costUsd.toFixed(2)} equiv
            </span>
            <span className="font-mono text-sm text-[#b7cbe0]" title={`${totalTokens.toLocaleString()} combined tokens`}>
              {fmtTokens(totalTokens)} tokens
            </span>
            <span className="max-w-[320px] truncate font-mono text-[11px] text-[#68615f]" title={loop.workspaceDir}>
              {loop.workspaceDir}
            </span>
            {selectedRound == null && <div className="ml-auto flex items-center gap-2">
              {play.running && play.url && (
                <button
                  type="button"
                  onClick={() => void window.loops.playStart(loop.id)}
                  className="rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2.5 py-1 font-mono text-[11px] text-emerald-300 hover:bg-emerald-500/20"
                  title="Open in browser"
                >
                  {play.url}
                </button>
              )}
              {play.running ? (
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
                className={`border-[#494343] bg-transparent hover:bg-white/5 hover:text-white ${critiqueOpen ? 'text-[#f2d98c]' : 'text-[#96908d]'}`}
                onClick={() => setCritiqueOpen((open) => !open)}
              >
                <Eye /> Critique
              </Button>
              <Button
                variant="outline"
                className={`border-[#494343] bg-transparent hover:bg-white/5 hover:text-white ${reportOpen ? 'text-[#e9c9bc]' : 'text-[#96908d]'}`}
                onClick={() => setReportOpen((open) => !open)}
              >
                <FileText /> Report
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
                  {(loop.status === 'stopped' || loop.status === 'exhausted') && (
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
          </div>

          {selectedRound == null && loop.stopReason && !running && (
            <p className="mb-5 rounded-lg border border-[#3f3a39] bg-[#1d1918] px-3 py-2.5 text-xs text-[#c9c3c0]">{loop.stopReason}</p>
          )}

          {play.error && (
            <p className="mb-5 rounded-lg border border-[#603f3f] bg-[#251718] px-3 py-2.5 text-xs text-[#f0aaaa]">Play: {play.error}</p>
          )}
          {error && <p className="mb-5 rounded-lg border border-[#603f3f] bg-[#251718] px-3 py-2.5 text-xs text-[#f0aaaa]">{error}</p>}

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
                  <div className="text-[10px] uppercase tracking-wide text-[#716a67]">Attempts / runtime</div>
                  <div className="mt-1 font-mono text-sm text-[#c2bbb7]">{visibleRuns.length} / {fmtDuration(totals.durationMs)}</div>
                </div>
              </div>
              <div className="mb-5 grid gap-3">
                <PromptBlock title="Original prompt" value={loop.prompt} />
                <PromptBlock title="System / implementer prompt" value={systemPrompt} />
                <PromptBlock title="Critique evaluation rubric" value={critiqueRubric} />
              </div>
            </>
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
                const active = !agent.done && agent.lastTs != null && Date.now() - new Date(agent.lastTs).getTime() < 90_000
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

          {selectedRound == null && critiqueOpen && <CritiquePanel loopId={loop.id} refreshKey={finishedCritiques} />}

          {selectedRound == null && reportOpen && (
            <pre className="mb-5 max-h-[360px] overflow-y-auto whitespace-pre-wrap rounded-lg border border-[#332e2e] bg-[#151111] p-4 font-mono text-[11px] leading-[1.65] text-[#c9c3c0]">
              {reportMd || 'Building report…'}
            </pre>
          )}

          <div className="mb-5 overflow-hidden rounded-lg border border-[#332e2e]">
            <Table>
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
                  <TableHead className="px-2 text-[11px] text-[#68615f]">Time</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody className="text-xs">
                {visibleRuns.map((run) => (
                  <RunRow
                    key={run.id}
                    run={run}
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
                  <TableCell className="px-2 py-3 font-mono text-[11px] text-[#c2bbb7]">{fmtDuration(totals.durationMs)}</TableCell>
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
        </div>
      </main>
    </div>
  )
}
