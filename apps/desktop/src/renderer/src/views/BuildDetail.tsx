import { useEffect, useState } from 'react'
import { ArrowLeft, Check, ChevronDown, ChevronRight, LoaderCircle, Pencil, Play, Plus, Square, Upload, X } from 'lucide-react'
import { agentFilterKey, ALL_LOG_FILTER, lineMatchesFilter, LogFilterStrip, logLineColor, type LogFilterState } from '@/components/LogFilter'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { agentDisplayStatus, logEmptyMessage, rawStreamForLogLine, rawStreamLinks, type RawStreamLink } from '@/lib/build-visibility'
import { useStickToBottom } from '@/lib/use-stick-to-bottom'
import { CritiqueRoundView } from '@/views/CritiquePanel'
import { PromptBrowser } from '@/views/PromptBrowser'
import { RawStreamBrowser } from '@/views/RawStreamBrowser'
import { ReferenceStudyPanel } from '@/views/ReferenceStudyPanel'
import { HARNESS_LABELS } from '../../../shared/harness'
import type { AgentMetric, CritiqueRound, BuildLogLine, BuildRecord, BuildSnapshot, PlayState, RawStreamChunk, ReadRawStreamInput, ReferenceStudy, PhaseAttempt } from '../../../shared/build'
import { harnessFor, modelLabel } from '../../../shared/models'
import { buildCriticPrompt, buildImplementPromptPreview } from '../../../shared/prompts'
import { referenceRootForBuild } from '../../../shared/reference-path'
import type { OperationResult } from '../../../shared/result'
import { elapsedThroughAttemptMs, elapsedToAttemptStartMs, runtimeMs } from '../../../shared/attempt-timing'

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
  line: BuildLogLine
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

function AttemptModelSummary({ models }: { models: BuildSnapshot['build']['models'] }): React.JSX.Element {
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

function AttemptRow({
  attempt,
  buildCreatedAt,
  buildId,
  critique,
  expanded,
  onToggle,
}: {
  attempt: PhaseAttempt
  buildCreatedAt: string
  buildId: string
  critique?: CritiqueRound
  expanded: boolean
  onToggle: () => void
}): React.JSX.Element {
  const hasDetail = Boolean(critique) || Boolean(attempt.metrics && attempt.metrics.agents.length > 0)
  const score = attempt.verdict ? attempt.verdict.score.toFixed(2) : attempt.role === 'implement' ? '' : '—'
  const now = useNow(attempt.status === 'running')
  const startedMs = elapsedToAttemptStartMs(buildCreatedAt, attempt)
  const runtimeTitle = startedMs == null ? undefined : `Started ${fmtDuration(startedMs)} into the build`
  return (
    <>
      <TableRow className={`border-[#3b3636] ${hasDetail ? 'hover:bg-white/[0.03]' : 'hover:bg-transparent'}`}>
        <TableCell className="w-8 px-1 py-2.5 text-[#68615f]">
          {hasDetail ? (
            <button
              type="button"
              aria-expanded={expanded}
              aria-controls={`build-detail-${attempt.id}`}
              aria-label={`${expanded ? 'Collapse' : 'Expand'} ${attempt.role} attempt details`}
              onClick={onToggle}
              className="grid size-7 place-items-center rounded hover:bg-white/[0.05] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#c9b5aa]"
            >
              {expanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
            </button>
          ) : null}
        </TableCell>
        <TableCell className="px-2 py-2.5 text-[#ded9d6]">{attempt.role === 'reference' ? '—' : attempt.round}</TableCell>
        <TableCell className="px-2 py-2.5"><span className={attempt.role === 'reference' ? 'text-amber-300' : attempt.role === 'implement' ? 'text-[#e9c9bc]' : 'text-[#9ad1c6]'}>{attempt.role}</span></TableCell>
        <TableCell className="px-2 py-2.5 font-mono text-[11px] text-[#96908d]">{attempt.model ?? '—'}</TableCell>
        <TableCell className="px-2 py-2.5">
          {attempt.status === 'running' ? <span className="flex items-center gap-1.5 text-amber-300"><LoaderCircle className="size-3 animate-spin" /> running</span> : <span className={STATUS_STYLES[attempt.status]?.split(' ')[1] ?? 'text-[#96908d]'}>{attempt.status}</span>}
        </TableCell>
        <TableCell className="px-2 py-2.5 font-mono text-[#f2d98c]">{score}{attempt.verdict?.pass ? ' ✓' : ''}</TableCell>
        <TableCell className="px-2 py-2.5 font-mono text-[#9fb2c8]">{attempt.costUsd != null ? `$${attempt.costUsd.toFixed(2)}` : '—'}</TableCell>
        <TableCell className="px-2 py-2.5 font-mono text-[11px] text-[#96908d]">{fmtTokens(attempt.inputTokens)} / {fmtTokens(attempt.outputTokens)}</TableCell>
        <TableCell className="px-2 py-2.5 font-mono text-[11px] text-[#96908d]" title={runtimeTitle}>{fmtDuration(runtimeMs(attempt, now))}</TableCell>
      </TableRow>
      {expanded && (critique || attempt.metrics) && (
        <TableRow id={`build-detail-${attempt.id}`} className="border-[#3b3636] hover:bg-transparent">
          <TableCell colSpan={9} className="min-w-0 overflow-hidden whitespace-normal bg-[#151111] px-4 py-3">
            <div className="min-w-0 max-w-full overflow-hidden">
              {critique && <div className="mb-3"><CritiqueRoundView buildId={buildId} round={critique} /></div>}
              <div className="grid gap-1.5 font-mono text-[11px]">
                {(attempt.metrics?.agents ?? []).filter((agent) => agent.source !== 'workflow').map((agent) => {
                  const display = agentDisplayStatus(agent)
                  return (
                    <div key={agent.id} title={agent.note} className={agent.id === 'orchestrator' || agent.id === 'critic' ? 'text-[#ded9d6]' : `${agent.parentId && agent.parentId !== 'orchestrator' ? 'pl-10' : 'pl-5'} text-[#a89f9a]`}>
                      <span className={`mr-1.5 ${display === 'active' ? 'text-emerald-300' : display === 'failed' ? 'text-red-300' : display === 'done' ? 'text-[#77706d]' : 'text-amber-300'}`}>{display === 'active' ? '● active' : display === 'failed' ? '✗ failed' : display === 'done' ? '✓ done' : '○ idle'}</span>
                      {agent.id !== 'orchestrator' && agent.id !== 'critic' ? '↳ ' : ''}{agent.label}
                      <span className="text-[#68615f]"> ({agent.model ?? '?'})</span> · {agent.messages} msgs · in {fmtTokens(agent.tokens.input)} · out {fmtTokens(agent.tokens.output)} · cache r/w {fmtTokens(agent.tokens.cacheRead)}/{fmtTokens(agent.tokens.cacheWrite)}
                    </div>
                  )
                })}
                <WorkflowAgents agents={attempt.metrics?.agents ?? []} />
                {Object.entries(attempt.metrics?.perModel ?? {}).map(([model, usage]) => (
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

export interface BuildDetailProps {
  snapshot: BuildSnapshot
  selectedRound: number | null
  lines: BuildLogLine[]
  critiqueRounds: CritiqueRound[]
  critiqueError: string | null
  referenceStudies: Map<string, ReferenceStudy>
  play: PlayState
  busy: boolean
  error: string | null
  projectionWarning: string | null
  exactImplementPrompt: string | null
  exactCritiquePrompt: string | null
  canLoadOlderAttempts: boolean
  canLoadNewerAttempts: boolean
  loadingOlderAttempts: boolean
  onBack: () => void
  onRename: (title: string) => Promise<OperationResult<BuildRecord>>
  onPlayStart: (round: number | null) => void
  onPlayStop: () => void
  onExport: () => void
  onStop: () => void
  onResume: () => void
  onNewBuild: () => void
  onLoadOlderAttempts: () => void
  onLoadNewestAttempts: () => void
  onReadStream: (input: ReadRawStreamInput) => Promise<OperationResult<RawStreamChunk>>
  onScrollTop: () => void
}

/** Selected-build presentation; BuildView retains loading, persistence, and IPC orchestration. */
export function BuildDetail({
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
  canLoadOlderAttempts,
  canLoadNewerAttempts,
  loadingOlderAttempts,
  onBack,
  onRename,
  onPlayStart,
  onPlayStop,
  onExport,
  onStop,
  onResume,
  onNewBuild,
  onLoadOlderAttempts,
  onLoadNewestAttempts,
  onReadStream,
  onScrollTop,
}: BuildDetailProps): React.JSX.Element {
  const [renaming, setRenaming] = useState(false)
  const [renameBusy, setRenameBusy] = useState(false)
  const [titleDraft, setTitleDraft] = useState(snapshot.build.title)
  const [renameError, setRenameError] = useState<string | null>(null)
  const [detailTab, setDetailTab] = useState<'activity' | 'references'>('activity')
  const [logFilter, setLogFilter] = useState<LogFilterState>(ALL_LOG_FILTER)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [selectedRawStream, setSelectedRawStream] = useState<RawStreamLink | null>(null)
  const log = useStickToBottom(lines)

  const build = snapshot.build
  const running = build.status === 'running'
  const now = useNow(running)
  const liveAttempt = snapshot.attempts.find((attempt) => attempt.status === 'running') ?? null
  const referenceAttempts = snapshot.attempts.filter((attempt) => attempt.role === 'reference')
  const activeReferenceAttempt = referenceAttempts.at(-1)
  const activeReferenceStudy = activeReferenceAttempt
    ? referenceStudies.get(activeReferenceAttempt.id)
    : [...referenceStudies.values()].at(-1)
  const visibleAttempts = selectedRound == null ? snapshot.attempts : snapshot.attempts.filter((attempt) => attempt.round === selectedRound)
  const visibleAttemptIds = new Set(visibleAttempts.map((attempt) => attempt.id))
  const visibleLines = selectedRound == null ? lines : lines.filter((line) => line.attemptId && visibleAttemptIds.has(line.attemptId))
  const rawStreams = build.playTrusted ? rawStreamLinks(visibleAttempts, visibleLines) : []
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
        buildId: build.id,
        attemptId: stream.input.attemptId,
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
  const referenceRoot = referenceRootForBuild(build.id, referenceAttempts.length > 0 || activeReferenceStudy != null)
  const initialImplementPrompt = exactImplementPrompt ?? undefined
  const systemPrompt = initialImplementPrompt
    ? initialImplementPrompt.startsWith(build.prompt) ? initialImplementPrompt.slice(build.prompt.length).trim() : initialImplementPrompt
    : buildImplementPromptPreview(build.models, build.prompt, referenceRoot)
  const critiqueRubric = exactCritiquePrompt ?? buildCriticPrompt(build.prompt, 1, referenceRoot)
  const detailStatus = selectedRound == null
    ? build.status
    : visibleAttempts.some((attempt) => attempt.status === 'running') ? 'running' : (visibleAttempts.at(-1)?.status ?? 'queued')
  const selectedCritique = selectedRound == null ? undefined : critiqueRounds.find((round) => round.round === selectedRound)
  const visibleTotals = visibleAttempts.reduce(
    (sum, attempt) => ({
      costUsd: sum.costUsd + (attempt.costUsd ?? 0),
      inputTokens: sum.inputTokens + (attempt.inputTokens ?? 0),
      outputTokens: sum.outputTokens + (attempt.outputTokens ?? 0),
      durationMs: sum.durationMs + (runtimeMs(attempt, now) ?? 0),
      bestScore: Math.max(sum.bestScore, attempt.verdict?.score ?? 0),
      hasScore: sum.hasScore || Boolean(attempt.verdict),
    }),
    { costUsd: 0, inputTokens: 0, outputTokens: 0, durationMs: 0, bestScore: 0, hasScore: false },
  )
  const totals = selectedRound == null && snapshot.aggregate
    ? { ...visibleTotals, ...snapshot.aggregate }
    : visibleTotals
  const attemptCount = selectedRound == null ? (snapshot.totalAttempts ?? visibleAttempts.length) : visibleAttempts.length
  const totalTokens = totals.inputTokens + totals.outputTokens
  const buildStartMs = Date.parse(build.createdAt)
  const buildEndMs = running ? now : Date.parse(build.updatedAt)
  const visibleElapsedMs = selectedRound == null && Number.isFinite(buildStartMs) && Number.isFinite(buildEndMs)
    ? Math.max(0, buildEndMs - buildStartMs)
    : visibleAttempts.reduce<number | null>((latest, attempt) => {
        const elapsed = elapsedThroughAttemptMs(build.createdAt, attempt)
        return elapsed == null ? latest : Math.max(latest ?? 0, elapsed)
      }, null)
  const playingSelectedBuild = play.running && play.round === selectedRound
  const selectedRevision = selectedRound == null ? null : (visibleAttempts.find((attempt) => attempt.role === 'implement' && attempt.status === 'succeeded')?.revision ?? null)
  const selectedRoundPlayable = selectedRevision != null

  const saveTitle = async (): Promise<void> => {
    if (renameBusy) return
    const title = titleDraft.trim()
    if (!title || title === build.title) {
      setRenaming(false)
      setTitleDraft(build.title)
      return
    }
    setRenameBusy(true)
    setRenameError(null)
    try {
      const result = await onRename(title)
      if (!result.ok) {
        setRenameError(`Could not rename build: ${result.error}`)
        return
      }
      setTitleDraft(result.value.title)
      setRenaming(false)
    } catch (cause) {
      setRenameError(`Could not rename build: ${cause instanceof Error ? cause.message : 'IPC request failed.'}`)
    } finally {
      setRenameBusy(false)
    }
  }

  const selectDetailTab = (tab: 'activity' | 'references'): void => {
    setDetailTab(tab)
    onScrollTop()
  }

  return (
    <>
      {selectedRound != null && (
        <button type="button" onClick={onBack} className="mb-4 flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-[#8f8885] hover:bg-white/[0.04] hover:text-[#ded9d6]">
          <ArrowLeft className="size-3.5" /> Attempt detail
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
                  setTitleDraft(build.title)
                  setRenaming(false)
                }
              }}
              autoFocus
              disabled={renameBusy}
              maxLength={80}
              aria-label="Build name"
              className="h-10 min-w-0 flex-1 rounded-lg border border-[#514947] bg-[#181414] px-3 text-[20px] font-semibold text-[#eeeae7] outline-none focus:border-[#716763]"
            />
            <button type="button" disabled={renameBusy} onClick={() => void saveTitle()} className="grid size-9 place-items-center rounded-lg text-[#9f9895] hover:bg-white/[0.05] hover:text-white disabled:cursor-not-allowed disabled:opacity-40" aria-label="Save build name">
              {renameBusy ? <LoaderCircle className="size-4 animate-spin" /> : <Check className="size-4" />}
            </button>
            <button type="button" disabled={renameBusy} onClick={() => { setTitleDraft(build.title); setRenaming(false) }} className="grid size-9 place-items-center rounded-lg text-[#77706d] hover:bg-white/[0.05] hover:text-white disabled:cursor-not-allowed disabled:opacity-40" aria-label="Cancel rename">
              <X className="size-4" />
            </button>
          </>
        ) : (
          <>
            <h1 className="line-clamp-2 text-[22px] font-semibold leading-tight tracking-[-0.02em] text-[#eeeae7]" title={build.title}>{selectedRound == null ? build.title : `Round ${selectedRound}`}</h1>
            {selectedRound == null && (
              <button type="button" onClick={() => { setTitleDraft(build.title); setRenaming(true) }} className="grid size-8 shrink-0 place-items-center rounded-lg text-[#68615f] hover:bg-white/[0.05] hover:text-[#ded9d6]" aria-label="Rename build">
                <Pencil className="size-3.5" />
              </button>
            )}
          </>
        )}
      </div>
      {selectedRound == null && <AttemptModelSummary models={build.models} />}
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <Badge className={`border px-2.5 py-1 text-[11px] uppercase tracking-wide ${STATUS_STYLES[detailStatus] ?? ''}`}>{detailStatus}</Badge>
        <span className="text-sm text-[#ded9d6]">
          {selectedRound == null ? liveAttempt?.role === 'reference' ? 'reference study · rounds not started' : `round ${build.round}/${build.maxRounds}` : visibleAttempts.length === 1 ? '1 attempt' : `${visibleAttempts.length} attempts`}
        </span>
        <span className="font-mono text-sm text-[#9fb2c8]">${totals.costUsd.toFixed(2)} equivalent API cost</span>
        <span className="font-mono text-sm text-[#b7cbe0]" title={`${totalTokens.toLocaleString()} combined tokens`}>{fmtTokens(totalTokens)} tokens</span>
        {selectedRevision && <span className="font-mono text-[11px] text-[#8f8885]" title={selectedRevision}>commit {selectedRevision.slice(0, 12)}</span>}
        <span className="max-w-[320px] truncate font-mono text-[11px] text-[#68615f]" title={build.workspaceDir}>{build.workspaceDir}</span>
        {selectedRound == null && (
          <div className="ml-auto flex items-center gap-2">
            {playingSelectedBuild && play.url && <button type="button" onClick={() => onPlayStart(null)} className="rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2.5 py-1 font-mono text-[11px] text-emerald-300 hover:bg-emerald-500/20" title="Open in browser">{play.url}</button>}
            {playingSelectedBuild ? (
              <Button variant="outline" className="border-[#494343] bg-transparent text-[#96908d] hover:bg-white/5 hover:text-white" onClick={onPlayStop}><Square /> Stop game</Button>
            ) : (
              <Button variant="outline" className="border-emerald-600/50 bg-transparent text-emerald-300 hover:bg-emerald-500/10 hover:text-emerald-200" onClick={() => onPlayStart(null)}><Play className="fill-current" /> Play</Button>
            )}
            <Button variant="outline" className="border-[#494343] bg-transparent text-[#96908d] hover:bg-white/5 hover:text-white" disabled={busy || running} title={running ? 'Stop the build first to export an exact folder snapshot' : 'Export the complete project folder and SQLite history'} onClick={onExport}><Upload /> Export</Button>
            {running ? (
              <Button variant="outline" className="border-[#6b4a44] bg-transparent text-[#f0b8aa] hover:bg-[#3a2622] hover:text-[#f7cec2]" onClick={onStop}><Square className="fill-current" /> Stop</Button>
            ) : (
              <>
                {(build.status === 'stopped' || build.status === 'exhausted' || build.status === 'failed') && (
                  <Button variant="outline" className="border-amber-500/50 bg-transparent text-amber-300 hover:bg-amber-500/10 hover:text-amber-200" disabled={busy} onClick={onResume}>
                    {busy ? <LoaderCircle className="animate-spin" /> : <Play className="fill-current" />} Resume build
                  </Button>
                )}
                <Button variant="outline" className="border-[#494343] bg-transparent text-[#eeeae7] hover:bg-white/5 hover:text-white" onClick={onNewBuild}><Plus /> New build</Button>
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

      {selectedRound == null && build.stopReason && !running && <p className="mb-5 rounded-lg border border-[#3f3a39] bg-[#1d1918] px-3 py-2.5 text-xs text-[#c9c3c0]">{build.stopReason}</p>}
      {play.error && <p className="mb-5 rounded-lg border border-[#603f3f] bg-[#251718] px-3 py-2.5 text-xs text-[#f0aaaa]">Play: {play.error}</p>}
      {error && <p className="mb-5 rounded-lg border border-[#603f3f] bg-[#251718] px-3 py-2.5 text-xs text-[#f0aaaa]">{error}</p>}
      {projectionWarning && <p className="mb-5 rounded-lg border border-amber-700/40 bg-amber-950/20 px-3 py-2.5 text-xs leading-relaxed text-amber-200">Bounded history view: {projectionWarning} Canonical history remains in the project ledger and exported attempt folder.</p>}
      {(canLoadOlderAttempts || canLoadNewerAttempts) && (
        <div className="mb-5 flex flex-wrap gap-2">
          {canLoadNewerAttempts && <button type="button" onClick={onLoadNewestAttempts} disabled={loadingOlderAttempts} className="inline-flex items-center gap-2 rounded-lg border border-amber-700/40 bg-amber-950/20 px-3 py-2 text-xs text-amber-200 hover:bg-amber-900/30 disabled:cursor-not-allowed disabled:opacity-50">Newest attempts</button>}
          {canLoadOlderAttempts && <button type="button" onClick={onLoadOlderAttempts} disabled={loadingOlderAttempts} className="inline-flex items-center gap-2 rounded-lg border border-amber-700/40 bg-amber-950/20 px-3 py-2 text-xs text-amber-200 hover:bg-amber-900/30 disabled:cursor-not-allowed disabled:opacity-50">{loadingOlderAttempts && <LoaderCircle className="size-3.5 animate-spin" />}Load older attempts</button>}
          <span className="self-center text-xs text-[#77706d]">Showing attempts {(snapshot.attemptOffset ?? 0) + 1}–{(snapshot.attemptOffset ?? 0) + snapshot.attempts.length} of {snapshot.totalAttempts ?? snapshot.attempts.length}</span>
        </div>
      )}
      {renameError && <p className="mb-5 rounded-lg border border-[#603f3f] bg-[#251718] px-3 py-2.5 text-xs text-[#f0aaaa]">{renameError}</p>}
      {critiqueError && <p className="mb-5 rounded-lg border border-[#603f3f] bg-[#251718] px-3 py-2.5 text-xs text-[#f0aaaa]">{critiqueError}</p>}

      {selectedRound == null && (
        <div role="tablist" aria-label="Build detail" className="mb-5 flex border-b border-[#332e2e]">
          <button type="button" role="tab" aria-selected={detailTab === 'activity'} aria-controls="build-activity-panel" onClick={() => selectDetailTab('activity')} className={`relative px-3 py-2.5 text-[12px] transition-colors ${detailTab === 'activity' ? 'text-[#eeeae7] after:absolute after:inset-x-0 after:bottom-[-1px] after:h-px after:bg-[#c9b5aa]' : 'text-[#77706d] hover:text-[#c9c3c0]'}`}>Build activity</button>
          <button type="button" role="tab" aria-selected={detailTab === 'references'} aria-controls="build-references-panel" onClick={() => selectDetailTab('references')} className={`relative flex items-center gap-2 px-3 py-2.5 text-[12px] transition-colors ${detailTab === 'references' ? 'text-amber-200 after:absolute after:inset-x-0 after:bottom-[-1px] after:h-px after:bg-amber-300' : 'text-[#77706d] hover:text-[#c9c3c0]'}`}>
            Reference assets
            {activeReferenceStudy && <span className="rounded-full border border-[#49413a] bg-amber-500/[0.07] px-1.5 py-0.5 font-mono text-[9px] text-amber-300/80">{activeReferenceStudy.pack.images.length + activeReferenceStudy.pack.motion.length + activeReferenceStudy.pack.videos.length}</span>}
          </button>
        </div>
      )}

      {selectedRound == null && detailTab === 'references' ? (
        <section id="build-references-panel" role="tabpanel" className="grid min-w-0 gap-4 overflow-hidden">
          <div className="min-w-0 overflow-hidden rounded-lg border border-[#332e2e] bg-[#151212] p-4">
            {activeReferenceStudy ? <ReferenceStudyPanel buildId={build.id} study={activeReferenceStudy} /> : referenceAttempts.length > 0 ? (
              <div className="flex items-center gap-2 py-10 text-sm text-[#77706d]"><LoaderCircle className="size-4 animate-spin" /> Loading Reference Pack…</div>
            ) : (
              <div className="py-10 text-center"><div className="text-sm text-[#aaa4a1]">No Reference Study was recorded for this build.</div><div className="mt-1 text-xs text-[#68615f]">Reference assets appear here for builds created with the Reference Study workflow.</div></div>
            )}
          </div>
        </section>
      ) : (
        <section id="build-activity-panel" role={selectedRound == null ? 'tabpanel' : undefined}>
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
                  { id: 'original', title: 'Original', description: 'The operator goal and quality bar for this build.', value: build.prompt },
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

          {selectedRound != null && selectedCritique && <section className="mb-5 rounded-lg border border-[#332e2e] bg-[#151212] p-4"><h2 className="mb-3 text-[11px] font-medium uppercase tracking-wide text-[#8f8885]">Round {selectedRound} critique</h2><CritiqueRoundView buildId={build.id} round={selectedCritique} /></section>}

          {liveAttempt?.metrics && liveAttempt.metrics.agents.length > 0 && (selectedRound == null || liveAttempt.round === selectedRound) && (
            <div className="mb-5 flex flex-wrap items-center gap-2">
              <span className="mr-1 text-[11px] uppercase tracking-wide text-[#68615f]">Agents</span>
              {liveAttempt.metrics.agents.map((agent) => {
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
                {visibleAttempts.map((attempt) => (
                  <AttemptRow
                    key={attempt.id}
                    attempt={attempt}
                    buildCreatedAt={build.createdAt}
                    buildId={build.id}
                    critique={attempt.role === 'critique' ? critiqueRounds.find((round) => round.attemptId === attempt.id) : undefined}
                    expanded={expanded.has(attempt.id)}
                    onToggle={() => setExpanded((current) => { const next = new Set(current); if (next.has(attempt.id)) next.delete(attempt.id); else next.add(attempt.id); return next })}
                  />
                ))}
                <TableRow className="border-t-2 border-[#4a4342] bg-[#181414] font-medium hover:bg-[#181414]">
                  <TableCell colSpan={5} className="px-4 py-3 text-[11px] uppercase tracking-wide text-[#8f8885]">{canLoadOlderAttempts && selectedRound == null ? 'Loaded page' : 'Total'} · {visibleAttempts.length} attempts</TableCell>
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
