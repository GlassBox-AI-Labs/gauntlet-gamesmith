import { useEffect, useState } from 'react'
import { ArrowLeft, Check, ChevronDown, ChevronRight, FolderOpen, LoaderCircle, Pencil, Play, Plus, Square, Upload, X } from 'lucide-react'
import { agentFilterKey, ALL_LOG_FILTER, lineMatchesFilter, LogFilterStrip, logLineColor, type LogFilterState } from '@/components/LogFilter'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { agentDisplayStatus, logEmptyMessage, rawStreamForLogLine, rawStreamLinks, type RawStreamLink } from '@/lib/run-visibility'
import { useStickToBottom } from '@/lib/use-stick-to-bottom'
import { CritiqueRoundView } from '@/views/CritiquePanel'
import { PromptBrowser } from '@/views/PromptBrowser'
import { RawStreamBrowser } from '@/views/RawStreamBrowser'
import { AssetGallery } from '@/views/AssetGallery'
import { ReferenceStudyPanel } from '@/views/ReferenceStudyPanel'
import { HARNESS_LABELS } from '../../../shared/harness'
import type { AgentMetric, ArtifactLocation, ArtifactLocationKind, CritiqueRound, LoopLogLine, LoopRecord, LoopSnapshot, PlayState, RawStreamChunk, ReadRawStreamInput, ReferenceStudy, RunRecord } from '../../../shared/loop'
import { harnessFor, modelLabel } from '../../../shared/models'
import { buildCriticPrompt, buildImplementPromptPreview } from '../../../shared/prompts'
import { referenceRootForLoop } from '../../../shared/reference-path'
import type { OperationResult } from '../../../shared/result'
import { elapsedThroughRunMs, elapsedToRunStartMs, runtimeMs } from '../../../shared/run-timing'

type DetailTab = 'activity' | 'references' | 'artifacts'

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

interface ActivityLogItem {
  key: string
  line: LoopLogLine
  stream: RawStreamLink | null
  order: number
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
  const pad = (n: number): string => String(n).padStart(2, '0')
  const h = Math.floor(totalSec / 3600)
  const mmss = `${pad(Math.floor(totalSec / 60) % 60)}:${pad(totalSec % 60)}`
  return h > 0 ? `${pad(h)}:${mmss}` : mmss
}

function fmtTs(iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? '' : date.toTimeString().slice(0, 8)
}

function RunModelSummary({ models }: { models: LoopSnapshot['loop']['models'] }): React.JSX.Element {
  const implementer = models.subagentModel ? `${modelLabel(models.subagentModel)} · ${models.subagentEffort}` : 'orchestrator · solo'
  const criticHarness = HARNESS_LABELS[harnessFor(models.criticModel)]
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
  const totalTokens = workflow.reduce((sum, agent) => sum + (agent.totalTokens ?? 0), 0)
  const totalCost = workflow.reduce((sum, agent) => sum + (agent.costUsd ?? 0), 0)
  const running = workflow.filter((agent) => agent.state !== 'done').length
  return (
    <>
      <div className="mt-1 text-[#c0aee6]">
        ⇉ workflow fan-out · {workflow.length} agents{running > 0 ? ` (${running} running)` : ''} · {fmtTokens(totalTokens)} tokens · ${totalCost.toFixed(2)}
      </div>
      {phases.map((group, index) => (
        <div key={`${group.phase}-${index}`} className="pl-5">
          <div className="text-[#8f8a87]">{group.phase}</div>
          {group.agents.map((agent) => (
            <div key={agent.id} className="pl-4 text-[#a89f9a]">
              <span className={agent.state === 'done' ? 'text-[#a9e5b8]' : 'text-[#f2d98c]'}>{agent.state === 'done' ? '✓ done' : '⋯ running'}</span>{' '}
              {agent.label}
              <span className="text-[#68615f]"> ({agent.model ?? '?'}{agent.agentType ? `, ${agent.agentType}` : ''})</span>{' '}
              · {agent.costUsd != null ? `$${agent.costUsd.toFixed(2)}` : '$—'} · in {fmtTokens(agent.tokens.input + agent.tokens.cacheRead)} · out{' '}
              {fmtTokens(agent.tokens.output)} · {agent.toolCalls ?? 0} tools · {fmtDuration(agent.durationMs)}
              {agent.prompt && (
                <details className="pl-4">
                  <summary className="cursor-pointer text-[#68615f] hover:text-[#96908d]">task given to this agent</summary>
                  <pre className="mt-1 max-h-64 overflow-y-auto whitespace-pre-wrap rounded border border-[#332e2e] bg-[#141010] p-2 text-[10px] leading-relaxed text-[#8f8a87]">{agent.prompt}</pre>
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
  loopId,
  critique,
  expanded,
  onToggle,
}: {
  run: RunRecord
  loopCreatedAt: string
  loopId: string
  critique?: CritiqueRound
  expanded: boolean
  onToggle: () => void
}): React.JSX.Element {
  const hasDetail = Boolean(critique) || Boolean(run.metrics && run.metrics.agents.length > 0)
  const score = run.verdict ? run.verdict.score.toFixed(2) : run.role === 'implement' ? '' : '—'
  const now = useNow(run.status === 'running')
  const startedMs = elapsedToRunStartMs(loopCreatedAt, run)
  const runtimeTitle = startedMs == null ? undefined : `Started ${fmtDuration(startedMs)} into the loop`
  return (
    <>
      <TableRow className={`border-[#3b3636] ${hasDetail ? 'hover:bg-white/[0.03]' : 'hover:bg-transparent'}`}>
        <TableCell className="w-8 px-1 py-2.5 text-[#68615f]">
          {hasDetail ? (
            <button
              type="button"
              aria-expanded={expanded}
              aria-controls={`run-detail-${run.id}`}
              aria-label={`${expanded ? 'Collapse' : 'Expand'} ${run.role} attempt details`}
              onClick={onToggle}
              className="grid size-7 place-items-center rounded hover:bg-white/[0.05] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#c9b5aa]"
            >
              {expanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
            </button>
          ) : null}
        </TableCell>
        <TableCell className="px-2 py-2.5 text-[#ded9d6]">{run.role === 'reference' ? '—' : run.round}</TableCell>
        <TableCell className="px-2 py-2.5"><span className={run.role === 'reference' ? 'text-amber-300' : run.role === 'implement' ? 'text-[#e9c9bc]' : 'text-[#9ad1c6]'}>{run.role}</span></TableCell>
        <TableCell className="px-2 py-2.5 font-mono text-[11px] text-[#96908d]">{run.model ?? '—'}</TableCell>
        <TableCell className="px-2 py-2.5">
          {run.status === 'running' ? <span className="flex items-center gap-1.5 text-amber-300"><LoaderCircle className="size-3 animate-spin" /> running</span> : <span className={STATUS_STYLES[run.status]?.split(' ')[1] ?? 'text-[#96908d]'}>{run.status}</span>}
        </TableCell>
        <TableCell className="px-2 py-2.5 font-mono text-[#f2d98c]">{score}{run.verdict?.pass ? ' ✓' : ''}</TableCell>
        <TableCell className="px-2 py-2.5 font-mono text-[#9fb2c8]">{run.costUsd != null ? `$${run.costUsd.toFixed(2)}` : '—'}</TableCell>
        <TableCell className="px-2 py-2.5 font-mono text-[11px] text-[#96908d]">{fmtTokens(run.inputTokens)} / {fmtTokens(run.outputTokens)}</TableCell>
        <TableCell className="px-2 py-2.5 font-mono text-[11px] text-[#96908d]" title={runtimeTitle}>{fmtDuration(runtimeMs(run, now))}</TableCell>
      </TableRow>
      {expanded && (critique || run.metrics) && (
        <TableRow id={`run-detail-${run.id}`} className="border-[#3b3636] hover:bg-transparent">
          <TableCell colSpan={9} className="min-w-0 overflow-hidden whitespace-normal bg-[#151111] px-4 py-3">
            <div className="min-w-0 max-w-full overflow-hidden">
              {critique && <div className="mb-3"><CritiqueRoundView loopId={loopId} round={critique} /></div>}
              <div className="grid gap-1.5 font-mono text-[11px]">
                {(run.metrics?.agents ?? []).filter((agent) => agent.source !== 'workflow').map((agent) => {
                  const display = agentDisplayStatus(agent)
                  return (
                    <div key={agent.id} title={agent.note} className={agent.id === 'orchestrator' || agent.id === 'critic' ? 'text-[#ded9d6]' : `${agent.parentId && agent.parentId !== 'orchestrator' ? 'pl-10' : 'pl-5'} text-[#a89f9a]`}>
                      <span className={`mr-1.5 ${display === 'active' ? 'text-emerald-300' : display === 'failed' ? 'text-red-300' : display === 'done' ? 'text-[#77706d]' : 'text-amber-300'}`}>{display === 'active' ? '● active' : display === 'failed' ? '✗ failed' : display === 'done' ? '✓ done' : '○ idle'}</span>
                      {agent.id !== 'orchestrator' && agent.id !== 'critic' ? '↳ ' : ''}{agent.label}
                      <span className="text-[#68615f]"> ({agent.model ?? '?'})</span> · {agent.messages} msgs · in {fmtTokens(agent.tokens.input)} · out {fmtTokens(agent.tokens.output)} · cache r/w {fmtTokens(agent.tokens.cacheRead)}/{fmtTokens(agent.tokens.cacheWrite)}
                    </div>
                  )
                })}
                <WorkflowAgents agents={run.metrics?.agents ?? []} />
                {Object.entries(run.metrics?.perModel ?? {}).map(([model, usage]) => (
                  <div key={model} className="text-[#9fb2c8]">{model}: {usage.costUsd != null ? `$${usage.costUsd.toFixed(2)}` : '$—'} · in {fmtTokens(usage.tokens.input)} · out {fmtTokens(usage.tokens.output)}</div>
                ))}
              </div>
            </div>
          </TableCell>
        </TableRow>
      )}
    </>
  )
}

export interface RunDetailProps {
  snapshot: LoopSnapshot
  selectedRound: number | null
  lines: LoopLogLine[]
  critiqueRounds: CritiqueRound[]
  critiqueError: string | null
  referenceStudies: Map<string, ReferenceStudy>
  play: PlayState
  busy: boolean
  error: string | null
  projectionWarning: string | null
  exactImplementPrompt: string | null
  exactCritiquePrompt: string | null
  canLoadOlderRuns: boolean
  canLoadNewerRuns: boolean
  loadingOlderRuns: boolean
  onBack: () => void
  onRename: (title: string) => Promise<OperationResult<LoopRecord>>
  onPlayStart: (round: number | null) => void
  onPlayStop: () => void
  onExport: () => void
  onStop: () => void
  onResume: () => void
  onNewRun: () => void
  onLoadOlderRuns: () => void
  onLoadNewestRuns: () => void
  onReadStream: (input: ReadRawStreamInput) => Promise<OperationResult<RawStreamChunk>>
  onScrollTop: () => void
}

/** Selected-run presentation; RunView retains loading, persistence, and IPC orchestration. */
export function RunDetail({
  snapshot,
  selectedRound,
  lines,
  critiqueRounds,
  critiqueError,
  referenceStudies,
  play,
  busy,
  error,
  projectionWarning,
  exactImplementPrompt,
  exactCritiquePrompt,
  canLoadOlderRuns,
  canLoadNewerRuns,
  loadingOlderRuns,
  onBack,
  onRename,
  onPlayStart,
  onPlayStop,
  onExport,
  onStop,
  onResume,
  onNewRun,
  onLoadOlderRuns,
  onLoadNewestRuns,
  onReadStream,
  onScrollTop,
}: RunDetailProps): React.JSX.Element {
  const [renaming, setRenaming] = useState(false)
  const [renameBusy, setRenameBusy] = useState(false)
  const [titleDraft, setTitleDraft] = useState(snapshot.loop.title)
  const [renameError, setRenameError] = useState<string | null>(null)
  const [detailTab, setDetailTab] = useState<DetailTab>('activity')
  const [artifacts, setArtifacts] = useState<ArtifactLocation[]>([])
  const [artifactBusy, setArtifactBusy] = useState(false)
  const [artifactError, setArtifactError] = useState<string | null>(null)
  const [logFilter, setLogFilter] = useState<LogFilterState>(ALL_LOG_FILTER)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [selectedRawStream, setSelectedRawStream] = useState<RawStreamLink | null>(null)
  const log = useStickToBottom(lines)

  useEffect(() => {
    if (detailTab !== 'artifacts') return
    let disposed = false
    setArtifactBusy(true)
    setArtifactError(null)
    void window.loops.artifacts(snapshot.loop.id).then((result) => {
      if (disposed) return
      if (result.ok) setArtifacts(result.value)
      else setArtifactError(result.error)
    }).catch((cause: unknown) => {
      if (!disposed) setArtifactError(cause instanceof Error ? cause.message : 'Could not inspect run artifacts.')
    }).finally(() => {
      if (!disposed) setArtifactBusy(false)
    })
    return () => { disposed = true }
  }, [detailTab, snapshot.loop.id])

  const loop = snapshot.loop
  const running = loop.status === 'running'
  const now = useNow(running)
  const liveRun = snapshot.runs.find((run) => run.status === 'running') ?? null
  const referenceRuns = snapshot.runs.filter((run) => run.role === 'reference')
  const activeReferenceRun = referenceRuns.at(-1)
  const activeReferenceStudy = activeReferenceRun
    ? referenceStudies.get(activeReferenceRun.id)
    : [...referenceStudies.values()].at(-1)
  const visibleRuns = selectedRound == null ? snapshot.runs : snapshot.runs.filter((run) => run.round === selectedRound)
  const visibleRunIds = new Set(visibleRuns.map((run) => run.id))
  const visibleLines = selectedRound == null ? lines : lines.filter((line) => line.runId && visibleRunIds.has(line.runId))
  const rawStreams = loop.playTrusted ? rawStreamLinks(visibleRuns, visibleLines) : []
  const linkedStreams = new Set<string>()
  const loggedActivityItems: ActivityLogItem[] = visibleLines.map((line, index) => {
    const stream = rawStreamForLogLine(line, rawStreams)
    if (!stream || linkedStreams.has(stream.key)) return { key: `line:${index}`, line, stream: null, order: index }
    linkedStreams.add(stream.key)
    return { key: `line:${index}`, line, stream: { ...stream, ts: line.ts }, order: index }
  })
  const fallbackActivityItems: ActivityLogItem[] = rawStreams
    .filter((stream) => !linkedStreams.has(stream.key))
    .map((stream, index) => ({
      key: `raw-stream:${stream.key}`,
      line: {
        loopId: loop.id,
        runId: stream.input.runId,
        ts: stream.ts,
        kind: 'raw-stream',
        channel: 'system',
        text: stream.input.stream === 'stderr'
          ? 'Raw error stream produced output for this attempt.'
          : stream.input.stream === 'agent'
            ? `Delegated raw stream appeared for ${stream.label}.`
            : 'Raw output stream opened for this attempt.',
        agentId: stream.agentId,
        round: stream.round,
        role: stream.role,
      },
      stream,
      order: visibleLines.length + index,
    }))
  const allActivityItems = [...loggedActivityItems, ...fallbackActivityItems].sort((left, right) => {
    const delta = Date.parse(left.line.ts) - Date.parse(right.line.ts)
    return Number.isFinite(delta) && delta !== 0 ? delta : left.order - right.order
  })
  const activityItems = allActivityItems.filter((item) => lineMatchesFilter(item.line, logFilter))
  const activityLines = allActivityItems.map((item) => item.line)
  const emptyLogMessage = logEmptyMessage(activityLines, activityItems.map((item) => item.line))
  const referenceRoot = referenceRootForLoop(loop.id, referenceRuns.length > 0 || activeReferenceStudy != null)
  const initialImplementPrompt = exactImplementPrompt ?? undefined
  const systemPrompt = initialImplementPrompt
    ? initialImplementPrompt.startsWith(loop.prompt) ? initialImplementPrompt.slice(loop.prompt.length).trim() : initialImplementPrompt
    : buildImplementPromptPreview(loop.models, loop.prompt, referenceRoot)
  const critiqueRubric = exactCritiquePrompt ?? buildCriticPrompt(loop.prompt, 1, referenceRoot)
  const detailStatus = selectedRound == null
    ? loop.status
    : visibleRuns.some((run) => run.status === 'running') ? 'running' : (visibleRuns.at(-1)?.status ?? 'queued')
  const selectedCritique = selectedRound == null ? undefined : critiqueRounds.find((round) => round.round === selectedRound)
  const visibleTotals = visibleRuns.reduce(
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
  const totals = selectedRound == null && snapshot.aggregate
    ? { ...visibleTotals, ...snapshot.aggregate }
    : visibleTotals
  const attemptCount = selectedRound == null ? (snapshot.totalRuns ?? visibleRuns.length) : visibleRuns.length
  const totalTokens = totals.inputTokens + totals.outputTokens
  const loopStartMs = Date.parse(loop.createdAt)
  const loopEndMs = running ? now : Date.parse(loop.updatedAt)
  const visibleElapsedMs = selectedRound == null && Number.isFinite(loopStartMs) && Number.isFinite(loopEndMs)
    ? Math.max(0, loopEndMs - loopStartMs)
    : visibleRuns.reduce<number | null>((latest, run) => {
        const elapsed = elapsedThroughRunMs(loop.createdAt, run)
        return elapsed == null ? latest : Math.max(latest ?? 0, elapsed)
      }, null)
  const playingSelectedBuild = play.running && play.round === selectedRound
  const selectedRevision = selectedRound == null ? null : (visibleRuns.find((run) => run.role === 'implement' && run.status === 'succeeded')?.revision ?? null)
  const selectedRoundPlayable = selectedRevision != null

  const saveTitle = async (): Promise<void> => {
    if (renameBusy) return
    const title = titleDraft.trim()
    if (!title || title === loop.title) {
      setRenaming(false)
      setTitleDraft(loop.title)
      return
    }
    setRenameBusy(true)
    setRenameError(null)
    try {
      const result = await onRename(title)
      if (!result.ok) {
        setRenameError(`Could not rename run: ${result.error}`)
        return
      }
      setTitleDraft(result.value.title)
      setRenaming(false)
    } catch (cause) {
      setRenameError(`Could not rename run: ${cause instanceof Error ? cause.message : 'IPC request failed.'}`)
    } finally {
      setRenameBusy(false)
    }
  }

  const selectDetailTab = (tab: DetailTab): void => {
    setDetailTab(tab)
    onScrollTop()
  }

  const revealArtifact = async (kind: ArtifactLocationKind): Promise<void> => {
    setArtifactError(null)
    try {
      const result = await window.loops.revealArtifact(loop.id, kind)
      if (!result.ok) setArtifactError(result.error)
    } catch (cause) {
      setArtifactError(cause instanceof Error ? cause.message : 'Could not open that artifact folder.')
    }
  }

  return (
    <>
      {selectedRound != null && (
        <button type="button" onClick={onBack} className="mb-4 flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-[#8f8885] hover:bg-white/[0.04] hover:text-[#ded9d6]">
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
              disabled={renameBusy}
              maxLength={80}
              aria-label="Run name"
              className="h-10 min-w-0 flex-1 rounded-lg border border-[#514947] bg-[#181414] px-3 text-[20px] font-semibold text-[#eeeae7] outline-none focus:border-[#716763]"
            />
            <button type="button" disabled={renameBusy} onClick={() => void saveTitle()} className="grid size-9 place-items-center rounded-lg text-[#9f9895] hover:bg-white/[0.05] hover:text-white disabled:cursor-not-allowed disabled:opacity-40" aria-label="Save run name">
              {renameBusy ? <LoaderCircle className="size-4 animate-spin" /> : <Check className="size-4" />}
            </button>
            <button type="button" disabled={renameBusy} onClick={() => { setTitleDraft(loop.title); setRenaming(false) }} className="grid size-9 place-items-center rounded-lg text-[#77706d] hover:bg-white/[0.05] hover:text-white disabled:cursor-not-allowed disabled:opacity-40" aria-label="Cancel rename">
              <X className="size-4" />
            </button>
          </>
        ) : (
          <>
            <h1 className="line-clamp-2 text-[22px] font-semibold leading-tight tracking-[-0.02em] text-[#eeeae7]" title={loop.title}>{selectedRound == null ? loop.title : `Round ${selectedRound}`}</h1>
            {selectedRound == null && (
              <button type="button" onClick={() => { setTitleDraft(loop.title); setRenaming(true) }} className="grid size-8 shrink-0 place-items-center rounded-lg text-[#68615f] hover:bg-white/[0.05] hover:text-[#ded9d6]" aria-label="Rename run">
                <Pencil className="size-3.5" />
              </button>
            )}
          </>
        )}
      </div>
      {selectedRound == null && <RunModelSummary models={loop.models} />}
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <Badge className={`border px-2.5 py-1 text-[11px] uppercase tracking-wide ${STATUS_STYLES[detailStatus] ?? ''}`}>{detailStatus}</Badge>
        <span className="text-sm text-[#ded9d6]">
          {selectedRound == null ? liveRun?.role === 'reference' ? 'reference study · rounds not started' : `round ${loop.round}/${loop.maxRounds}` : visibleRuns.length === 1 ? '1 attempt' : `${visibleRuns.length} attempts`}
        </span>
        <span className="font-mono text-sm text-[#9fb2c8]">${totals.costUsd.toFixed(2)} equivalent API cost</span>
        <span className="font-mono text-sm text-[#b7cbe0]" title={`${totalTokens.toLocaleString()} combined tokens`}>{fmtTokens(totalTokens)} tokens</span>
        {selectedRevision && <span className="font-mono text-[11px] text-[#8f8885]" title={selectedRevision}>commit {selectedRevision.slice(0, 12)}</span>}
        <span className="max-w-[320px] truncate font-mono text-[11px] text-[#68615f]" title={loop.workspaceDir}>{loop.workspaceDir}</span>
        {selectedRound == null && (
          <div className="ml-auto flex items-center gap-2">
            {playingSelectedBuild && play.url && <button type="button" onClick={() => onPlayStart(null)} className="rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2.5 py-1 font-mono text-[11px] text-emerald-300 hover:bg-emerald-500/20" title="Open in browser">{play.url}</button>}
            {playingSelectedBuild ? (
              <Button variant="outline" className="border-[#494343] bg-transparent text-[#96908d] hover:bg-white/5 hover:text-white" onClick={onPlayStop}><Square /> Stop game</Button>
            ) : (
              <Button variant="outline" className="border-emerald-600/50 bg-transparent text-emerald-300 hover:bg-emerald-500/10 hover:text-emerald-200" onClick={() => onPlayStart(null)}><Play className="fill-current" /> Play</Button>
            )}
            <Button variant="outline" className="border-[#494343] bg-transparent text-[#96908d] hover:bg-white/5 hover:text-white" disabled={busy || running} title={running ? 'Stop the run first to export an exact folder snapshot' : 'Export the complete project folder and SQLite history'} onClick={onExport}><Upload /> Export</Button>
            {running ? (
              <Button variant="outline" className="border-[#6b4a44] bg-transparent text-[#f0b8aa] hover:bg-[#3a2622] hover:text-[#f7cec2]" onClick={onStop}><Square className="fill-current" /> Stop</Button>
            ) : (
              <>
                {(loop.status === 'stopped' || loop.status === 'exhausted' || loop.status === 'failed') && (
                  <Button variant="outline" className="border-amber-500/50 bg-transparent text-amber-300 hover:bg-amber-500/10 hover:text-amber-200" disabled={busy} onClick={onResume}>
                    {busy ? <LoaderCircle className="animate-spin" /> : <Play className="fill-current" />} Resume loop
                  </Button>
                )}
                <Button variant="outline" className="border-[#494343] bg-transparent text-[#eeeae7] hover:bg-white/5 hover:text-white" onClick={onNewRun}><Plus /> New run</Button>
              </>
            )}
          </div>
        )}
        {selectedRound != null && (
          <div className="ml-auto flex items-center gap-2">
            {playingSelectedBuild && play.url && <button type="button" onClick={() => onPlayStart(selectedRound)} className="rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2.5 py-1 font-mono text-[11px] text-emerald-300 hover:bg-emerald-500/20" title="Open this round in the browser">{play.url}</button>}
            {playingSelectedBuild ? (
              <Button variant="outline" className="border-[#494343] bg-transparent text-[#96908d] hover:bg-white/5 hover:text-white" onClick={onPlayStop}><Square /> Stop game</Button>
            ) : (
              <Button variant="outline" className="border-emerald-600/50 bg-transparent text-emerald-300 hover:bg-emerald-500/10 hover:text-emerald-200" disabled={!selectedRoundPlayable} title={selectedRoundPlayable ? `Launch commit ${selectedRevision.slice(0, 12)} from round ${selectedRound}` : 'No Git revision was recorded for this round'} onClick={() => onPlayStart(selectedRound)}>
                <Play className="fill-current" /> {selectedRoundPlayable ? `Play round ${selectedRound}` : 'Revision unavailable'}
              </Button>
            )}
          </div>
        )}
      </div>

      {selectedRound == null && loop.stopReason && !running && <p className="mb-5 rounded-lg border border-[#3f3a39] bg-[#1d1918] px-3 py-2.5 text-xs text-[#c9c3c0]">{loop.stopReason}</p>}
      {play.error && <p className="mb-5 rounded-lg border border-[#603f3f] bg-[#251718] px-3 py-2.5 text-xs text-[#f0aaaa]">Play: {play.error}</p>}
      {error && <p className="mb-5 rounded-lg border border-[#603f3f] bg-[#251718] px-3 py-2.5 text-xs text-[#f0aaaa]">{error}</p>}
      {projectionWarning && <p className="mb-5 rounded-lg border border-amber-700/40 bg-amber-950/20 px-3 py-2.5 text-xs leading-relaxed text-amber-200">Bounded history view: {projectionWarning} Canonical history remains in the project ledger and exported run folder.</p>}
      {(canLoadOlderRuns || canLoadNewerRuns) && (
        <div className="mb-5 flex flex-wrap gap-2">
          {canLoadNewerRuns && <button type="button" onClick={onLoadNewestRuns} disabled={loadingOlderRuns} className="inline-flex items-center gap-2 rounded-lg border border-amber-700/40 bg-amber-950/20 px-3 py-2 text-xs text-amber-200 hover:bg-amber-900/30 disabled:cursor-not-allowed disabled:opacity-50">Newest attempts</button>}
          {canLoadOlderRuns && <button type="button" onClick={onLoadOlderRuns} disabled={loadingOlderRuns} className="inline-flex items-center gap-2 rounded-lg border border-amber-700/40 bg-amber-950/20 px-3 py-2 text-xs text-amber-200 hover:bg-amber-900/30 disabled:cursor-not-allowed disabled:opacity-50">{loadingOlderRuns && <LoaderCircle className="size-3.5 animate-spin" />}Load older attempts</button>}
          <span className="self-center text-xs text-[#77706d]">Showing attempts {(snapshot.runOffset ?? 0) + 1}–{(snapshot.runOffset ?? 0) + snapshot.runs.length} of {snapshot.totalRuns ?? snapshot.runs.length}</span>
        </div>
      )}
      {renameError && <p className="mb-5 rounded-lg border border-[#603f3f] bg-[#251718] px-3 py-2.5 text-xs text-[#f0aaaa]">{renameError}</p>}
      {critiqueError && <p className="mb-5 rounded-lg border border-[#603f3f] bg-[#251718] px-3 py-2.5 text-xs text-[#f0aaaa]">{critiqueError}</p>}

      {selectedRound == null && (
        <div role="tablist" aria-label="Run detail" className="mb-5 flex border-b border-[#332e2e]">
          <button type="button" role="tab" aria-selected={detailTab === 'activity'} aria-controls="run-activity-panel" onClick={() => selectDetailTab('activity')} className={`relative px-3 py-2.5 text-[12px] transition-colors ${detailTab === 'activity' ? 'text-[#eeeae7] after:absolute after:inset-x-0 after:bottom-[-1px] after:h-px after:bg-[#c9b5aa]' : 'text-[#77706d] hover:text-[#c9c3c0]'}`}>Run activity</button>
          <button type="button" role="tab" aria-selected={detailTab === 'references'} aria-controls="run-references-panel" onClick={() => selectDetailTab('references')} className={`relative flex items-center gap-2 px-3 py-2.5 text-[12px] transition-colors ${detailTab === 'references' ? 'text-amber-200 after:absolute after:inset-x-0 after:bottom-[-1px] after:h-px after:bg-amber-300' : 'text-[#77706d] hover:text-[#c9c3c0]'}`}>
            Reference assets
            {activeReferenceStudy && <span className="rounded-full border border-[#49413a] bg-amber-500/[0.07] px-1.5 py-0.5 font-mono text-[9px] text-amber-300/80">{activeReferenceStudy.pack.images.length + activeReferenceStudy.pack.motion.length + activeReferenceStudy.pack.videos.length}</span>}
          </button>
          <button type="button" role="tab" aria-selected={detailTab === 'artifacts'} aria-controls="run-artifacts-panel" onClick={() => selectDetailTab('artifacts')} className={`relative px-3 py-2.5 text-[12px] transition-colors ${detailTab === 'artifacts' ? 'text-sky-200 after:absolute after:inset-x-0 after:bottom-[-1px] after:h-px after:bg-sky-300' : 'text-[#77706d] hover:text-[#c9c3c0]'}`}>Artifacts</button>
        </div>
      )}

      {selectedRound == null && detailTab === 'references' ? (
        <section id="run-references-panel" role="tabpanel" className="grid min-w-0 gap-4 overflow-hidden">
          <div className="min-w-0 overflow-hidden rounded-lg border border-[#332e2e] bg-[#151212] p-4">
            {activeReferenceStudy ? <ReferenceStudyPanel loopId={loop.id} study={activeReferenceStudy} /> : referenceRuns.length > 0 ? (
              <div className="flex items-center gap-2 py-10 text-sm text-[#77706d]"><LoaderCircle className="size-4 animate-spin" /> Loading Reference Pack…</div>
            ) : (
              <div className="py-10 text-center"><div className="text-sm text-[#aaa4a1]">No Reference Study was recorded for this run.</div><div className="mt-1 text-xs text-[#68615f]">Reference assets appear here for runs created with the Reference Study workflow.</div></div>
            )}
          </div>
        </section>
      ) : selectedRound == null && detailTab === 'artifacts' ? (
        <section id="run-artifacts-panel" role="tabpanel" className="overflow-hidden rounded-lg border border-[#332e2e] bg-[#151212]">
          <div className="border-b border-[#2f2a2b] px-4 py-3">
            <h2 className="text-sm font-medium text-[#ded9d6]">Generated folders</h2>
            <p className="mt-1 text-[11px] text-[#77706d]">Browse project output, procedural asset factories, sculptor evidence, references, and critique captures in your file browser.</p>
          </div>
          {artifactBusy && <div className="flex items-center gap-2 px-4 py-8 text-xs text-[#77706d]"><LoaderCircle className="size-3.5 animate-spin" /> Inspecting folders…</div>}
          {artifactError && <p role="alert" className="m-4 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] leading-relaxed text-amber-200">{artifactError}</p>}
          {!artifactBusy && artifacts.map((artifact) => (
            <div key={artifact.kind} className="flex items-center gap-3 border-b border-[#292425] px-4 py-3 last:border-b-0">
              <FolderOpen className={`size-4 shrink-0 ${artifact.exists ? 'text-sky-300' : 'text-[#514b49]'}`} aria-hidden="true" />
              <div className="min-w-0 flex-1">
                <div className={`text-xs ${artifact.exists ? 'text-[#ded9d6]' : 'text-[#68615f]'}`}>{artifact.label}</div>
                <div className="mt-0.5 truncate font-mono text-[10px] text-[#68615f]" title={artifact.relativePath}>{artifact.relativePath}</div>
              </div>
              <span className="whitespace-nowrap font-mono text-[10px] text-[#77706d]">{artifact.exists ? `${artifact.itemCount} items` : 'not created'}</span>
              <Button variant="outline" className="border-[#494343] bg-transparent text-[#aaa4a1] hover:bg-white/5 hover:text-white" disabled={!artifact.exists} aria-label={`Open ${artifact.label}`} onClick={() => void revealArtifact(artifact.kind)}><FolderOpen /> Open</Button>
            </div>
          ))}
          <AssetGallery loopId={loop.id} onOpenEvidence={() => void revealArtifact('sculpt-evidence')} />
        </section>
      ) : (
        <section id="run-activity-panel" role={selectedRound == null ? 'tabpanel' : undefined}>
          {selectedRound == null && (
            <>
              <div className="mb-5 grid grid-cols-4 gap-3 max-md:grid-cols-2">
                <div className="rounded-lg border border-[#332e2e] bg-[#181414] p-3.5"><div className="text-[10px] uppercase tracking-wide text-[#716a67]">Total tokens</div><div className="mt-1 font-mono text-lg text-[#d7e2ed]" title={totalTokens.toLocaleString()}>{fmtTokens(totalTokens)}</div></div>
                <div className="rounded-lg border border-[#332e2e] bg-[#181414] p-3.5"><div className="text-[10px] uppercase tracking-wide text-[#716a67]">Input / output</div><div className="mt-1 font-mono text-sm text-[#c2bbb7]">{fmtTokens(totals.inputTokens)} / {fmtTokens(totals.outputTokens)}</div></div>
                <div className="rounded-lg border border-[#332e2e] bg-[#181414] p-3.5"><div className="text-[10px] uppercase tracking-wide text-[#716a67]">Equivalent API cost</div><div className="mt-1 font-mono text-lg text-[#b7cbe0]">${totals.costUsd.toFixed(2)}</div></div>
                <div className="rounded-lg border border-[#332e2e] bg-[#181414] p-3.5"><div className="text-[10px] uppercase tracking-wide text-[#716a67]">Attempts / elapsed</div><div className="mt-1 font-mono text-sm text-[#c2bbb7]">{attemptCount} / {fmtDuration(visibleElapsedMs)}</div></div>
              </div>
              <div className="mb-5">
                <PromptBrowser prompts={[
                  { id: 'original', title: 'Original', description: 'The operator goal and quality bar for this run.', value: loop.prompt },
                  { id: 'reference', title: 'Reference Study', description: 'Research and validation instructions used to create the frozen Reference Pack.', value: activeReferenceStudy?.prompt ?? '' },
                  { id: 'implementer', title: 'System / Implementer', description: initialImplementPrompt ? 'The exact implementation rules, delegation contract, and Reference Pack handoff.' : 'A pre-round preview of the implementation rules, delegation contract, and Reference Pack handoff.', value: systemPrompt },
                  { id: 'critique', title: 'Critique', description: 'Evaluation protocol, evidence requirements, scoring rubric, and passing threshold.', value: critiqueRubric },
                ]} />
              </div>
            </>
          )}

          {selectedRound != null && (
            <div className="mb-5">
              <PromptBrowser prompts={[
                { id: `round-${selectedRound}-implement`, title: `Round ${selectedRound} implementer`, description: selectedRound > 1 ? `The exact prompt this round's implementer received, including the previous critic's score, summary, and must-fix findings.` : `The exact prompt this round's implementer received: the goal, Reference Pack handoff, and delegation rules.`, value: exactImplementPrompt ?? '' },
                { id: `round-${selectedRound}-critique`, title: `Round ${selectedRound} critic`, description: `The exact prompt this round's critic received, with its evidence and scoring protocol.`, value: exactCritiquePrompt ?? '' },
              ]} />
            </div>
          )}

          {selectedRound != null && selectedCritique && <section className="mb-5 rounded-lg border border-[#332e2e] bg-[#151212] p-4"><h2 className="mb-3 text-[11px] font-medium uppercase tracking-wide text-[#8f8885]">Round {selectedRound} critique</h2><CritiqueRoundView loopId={loop.id} round={selectedCritique} /></section>}

          {liveRun?.metrics && liveRun.metrics.agents.length > 0 && (selectedRound == null || liveRun.round === selectedRound) && (
            <div className="mb-5 flex flex-wrap items-center gap-2">
              <span className="mr-1 text-[11px] uppercase tracking-wide text-[#68615f]">Agents</span>
              {liveRun.metrics.agents.map((agent) => {
                const display = agentDisplayStatus(agent)
                const filterKey = agentFilterKey(agent.id)
                const selected = filterKey != null && logFilter.agent === filterKey
                const chip = <><span className={`size-1.5 rounded-full ${display === 'failed' ? 'bg-red-400' : display === 'done' ? 'bg-[#68615f]' : display === 'active' ? 'animate-pulse bg-emerald-400' : 'bg-amber-400/70'}`} aria-hidden="true" />{agent.label}<span className="font-mono text-[10px] text-[#9fb2c8]">{fmtTokens(agent.tokens.input + agent.tokens.cacheRead + agent.tokens.cacheWrite)}/{fmtTokens(agent.tokens.output)}</span><span>{display === 'failed' ? '✗ failed' : display === 'done' ? '✓ done' : display}</span></>
                const chipClass = `flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] ${selected ? 'border-[#8b7f78] bg-white/[0.08] text-[#eeeae7]' : display === 'failed' ? 'border-red-500/40 text-red-300' : display === 'done' ? 'border-[#332e2e] text-[#68615f]' : 'border-[#494343] text-[#ded9d6]'}`
                return filterKey != null
                  ? <button type="button" key={agent.id} title={agent.note ?? 'Filter the log to this agent'} onClick={() => setLogFilter((current) => ({ ...current, agent: current.agent === filterKey ? null : filterKey }))} className={chipClass}>{chip}</button>
                  : <span key={agent.id} title={agent.note} className={chipClass}>{chip}</span>
              })}
            </div>
          )}

          <div className="mb-5 overflow-hidden rounded-lg border border-[#332e2e] [&_[data-slot=table-container]]:overflow-x-hidden [&_td]:overflow-hidden [&_th]:overflow-hidden">
            <Table className="table-fixed">
              <colgroup><col className="w-8" /><col className="w-[58px]" /><col className="w-[76px]" /><col className="w-[160px]" /><col className="w-[88px]" /><col className="w-[58px]" /><col className="w-[70px]" /><col className="w-[120px]" /><col className="w-[85px]" /></colgroup>
              <TableHeader><TableRow className="border-[#3b3636] hover:bg-transparent"><TableHead className="w-8 px-1" /><TableHead className="px-2 text-[11px] text-[#68615f]">Round</TableHead><TableHead className="px-2 text-[11px] text-[#68615f]">Role</TableHead><TableHead className="px-2 text-[11px] text-[#68615f]">Model</TableHead><TableHead className="px-2 text-[11px] text-[#68615f]">Status</TableHead><TableHead className="px-2 text-[11px] text-[#68615f]">Score</TableHead><TableHead className="px-2 text-[11px] text-[#68615f]" title="Equivalent API cost estimate">API cost</TableHead><TableHead className="px-2 text-[11px] text-[#68615f]">Tokens in/out</TableHead><TableHead className="px-2 text-[11px] text-[#68615f]" title="How long this attempt itself ran">Runtime</TableHead></TableRow></TableHeader>
              <TableBody className="text-xs">
                {visibleRuns.map((run) => (
                  <RunRow
                    key={run.id}
                    run={run}
                    loopCreatedAt={loop.createdAt}
                    loopId={loop.id}
                    critique={run.role === 'critique' ? critiqueRounds.find((round) => round.runId === run.id) : undefined}
                    expanded={expanded.has(run.id)}
                    onToggle={() => setExpanded((current) => { const next = new Set(current); if (next.has(run.id)) next.delete(run.id); else next.add(run.id); return next })}
                  />
                ))}
                <TableRow className="border-t-2 border-[#4a4342] bg-[#181414] font-medium hover:bg-[#181414]">
                  <TableCell colSpan={5} className="px-4 py-3 text-[11px] uppercase tracking-wide text-[#8f8885]">{canLoadOlderRuns && selectedRound == null ? 'Loaded page' : 'Total'} · {visibleRuns.length} attempts</TableCell>
                  <TableCell className="px-2 py-3 font-mono text-[11px] text-[#f2d98c]">{visibleTotals.hasScore ? `best ${visibleTotals.bestScore.toFixed(2)}` : '—'}</TableCell>
                  <TableCell className="px-2 py-3 font-mono text-[#b7cbe0]">${visibleTotals.costUsd.toFixed(2)}</TableCell>
                  <TableCell className="px-2 py-3 font-mono text-[11px] text-[#c2bbb7]" title={`${(visibleTotals.inputTokens + visibleTotals.outputTokens).toLocaleString()} combined tokens · ${visibleTotals.inputTokens.toLocaleString()} input (including cache) / ${visibleTotals.outputTokens.toLocaleString()} output`}><div>{fmtTokens(visibleTotals.inputTokens + visibleTotals.outputTokens)} total</div><div className="mt-0.5 text-[10px] text-[#77706d]">{fmtTokens(visibleTotals.inputTokens)} / {fmtTokens(visibleTotals.outputTokens)}</div></TableCell>
                  <TableCell className="px-2 py-3 font-mono text-[11px] text-[#c2bbb7]" title="Sum of the runtimes of the loaded attempts">{fmtDuration(visibleTotals.durationMs)}</TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </div>

          <LogFilterStrip lines={activityLines} filter={logFilter} onChange={setLogFilter} />
          <div ref={log.ref} onScroll={log.onScroll} className="h-[420px] overflow-y-auto rounded-lg border border-[#332e2e] bg-[#0d0a0b] p-3.5 font-mono text-[11px] leading-[1.7]">
            {emptyLogMessage && <span className="text-[#68615f]">{emptyLogMessage}</span>}
            {activityItems.map((item) => (
              <div key={item.key} className="flex gap-2 whitespace-pre-wrap break-all">
                <span className="shrink-0 text-[#4d4744]">{fmtTs(item.line.ts)}</span>
                <span className={logLineColor(item.line)}>
                  {item.line.agentId && <span className="text-[#c0aee6]">[{item.line.agentId}] </span>}
                  {item.line.text}
                  {item.stream && <>{' '}· <button type="button" onClick={() => setSelectedRawStream(item.stream)} className="rounded-sm text-[#8faac4] underline decoration-[#40505f] underline-offset-2 hover:text-[#bdd2e5] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#c9b5aa]">View raw stream</button></>}
                </span>
              </div>
            ))}
          </div>
          <RawStreamBrowser key={selectedRawStream?.key ?? 'closed'} stream={selectedRawStream} onRead={onReadStream} onClose={() => setSelectedRawStream(null)} />
        </section>
      )}
    </>
  )
}
