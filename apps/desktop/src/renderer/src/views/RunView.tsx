import { newRunOrchestratorEffort } from '../../../shared/models'
import { withExistingRunTrust } from '@/lib/trusted-action'
import { DEFAULT_RUN_PACE } from '../../../shared/run-presets'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { RunAttachment } from '../../../shared/attachments'
import type { ReferenceMode } from '../../../shared/loop'
import { LoaderCircle } from 'lucide-react'
import { RunDetail } from '@/views/RunDetail'
import { RunComposerDialog } from '@/components/RunComposerDialog'
import { RunForm, type RunFormSettings } from '@/views/RunForm'
import { RunSidebar, RUN_ROUNDS_PAGE_SIZE } from '@/views/RunSidebar'
import { DeleteRunsDialog, NameReportDialog, ReportPanel } from '@/views/ReportView'
import { applySnapshotUpdate, olderRunPageOffset, pruneExpandedLoops, pruneVisibleRoundCounts, selectSnapshotInList } from '@/lib/run-pages'
import type { CritiqueRound, LoopLogLine, LoopRecord, LoopSnapshot, PlayState, RawStreamChunk, ReadRawStreamInput, ReferenceStudy } from '../../../shared/loop'
import {
  DEFAULT_CRITIC,
  DEFAULT_ASSET,
  DEFAULT_IMPLEMENTER,
  DEFAULT_RESEARCH,
  type CriticFields,
  type AssetFields,
  type ImplementerFields,
  type ResearchFields,
} from '../../../shared/models'
import type { OperationResult } from '../../../shared/result'
import type { ReportRecord } from '../../../shared/reports'

const LOG_LIMIT = 1500

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message ? cause.message : fallback
}

export function RunView({ onOpenAgents }: { onOpenAgents: () => void }): React.JSX.Element {
  const [snapshots, setSnapshots] = useState<LoopSnapshot[]>([])
  const [snapshot, setSnapshot] = useState<LoopSnapshot | null>(null)
  const [lines, setLines] = useState<LoopLogLine[]>([])
  const [composing, setComposing] = useState(false)
  const [attachmentBusy, setAttachmentBusy] = useState(false)
  const [formSettings, setFormSettings] = useState<RunFormSettings>({ pace: DEFAULT_RUN_PACE, custom: false, initialized: false })
  const [loaded, setLoaded] = useState(false)
  const [prompt, setPrompt] = useState('')
  const [attachments, setAttachments] = useState<RunAttachment[]>([])
  const [referenceMode, setReferenceMode] = useState<ReferenceMode>('web')
  const [workspaceDir, setWorkspaceDir] = useState('')
  const [projectOpen, setProjectOpen] = useState(false)
  const [maxRounds, setMaxRounds] = useState('10')
  const [budget, setBudget] = useState('')
  const [impl, setImpl] = useState<ImplementerFields>(DEFAULT_IMPLEMENTER)
  const [critic, setCritic] = useState<CriticFields>(DEFAULT_CRITIC)
  const [research, setResearch] = useState<ResearchFields>(DEFAULT_RESEARCH)
  const [assets, setAssets] = useState<AssetFields>(DEFAULT_ASSET)
  const [reports, setReports] = useState<ReportRecord[]>([])
  const [selectedReportId, setSelectedReportId] = useState<string | null>(null)
  const [editingRuns, setEditingRuns] = useState(false)
  const [checkedRuns, setCheckedRuns] = useState<Set<string>>(new Set())
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [deleteFiles, setDeleteFiles] = useState(false)
  const [namingReport, setNamingReport] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [critiqueError, setCritiqueError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [historyWarning, setHistoryWarning] = useState<string | null>(null)
  const [hasMoreHistories, setHasMoreHistories] = useState(false)
  const [historyOffset, setHistoryOffset] = useState(0)
  const [historyPageCount, setHistoryPageCount] = useState(0)
  const [runPageBusy, setRunPageBusy] = useState(false)
  const [busy, setBusy] = useState(false)
  const [expandedRuns, setExpandedRuns] = useState<Set<string>>(new Set())
  const [visibleRounds, setVisibleRounds] = useState<Record<string, number>>({})
  const [selectedRound, setSelectedRound] = useState<number | null>(null)
  const [play, setPlay] = useState<PlayState>({ running: false, url: null, error: null, round: null })
  const [referenceStudies, setReferenceStudies] = useState<Map<string, ReferenceStudy>>(new Map())
  const [exactPrompts, setExactPrompts] = useState<{ implement: string | null; critique: string | null }>({ implement: null, critique: null })
  const selectionGeneration = useRef(0)
  const privilegedActionPending = useRef(false)
  useEffect(() => () => { selectionGeneration.current += 1 }, [])
  const loopIdRef = useRef<string | null>(null)
  const mainRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    setExpandedRuns((current) => pruneExpandedLoops(current, snapshots))
    setVisibleRounds((current) => pruneVisibleRoundCounts(current, snapshots, RUN_ROUNDS_PAGE_SIZE))
  }, [snapshots])

  useEffect(() => {
    let disposed = false
    const removeUpdate = window.loops.onUpdate((nextSnapshot) => {
      if (!loopIdRef.current || nextSnapshot.loop.id === loopIdRef.current) {
        loopIdRef.current = nextSnapshot.loop.id
        setSnapshot((current) => applySnapshotUpdate(current, nextSnapshot))
      }
      setSnapshots((current) => {
        const retained = current.find((item) => item.loop.id === nextSnapshot.loop.id)
        const detail = applySnapshotUpdate(retained ?? null, nextSnapshot)
        const next = selectSnapshotInList(current, detail)
        return next.sort((a, b) => a.loop.createdAt < b.loop.createdAt ? 1 : a.loop.createdAt > b.loop.createdAt ? -1 : 0)
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
      try {
        const [page, active, defaultDir, savedReports] = await Promise.all([
          window.loops.list(),
          window.loops.active(),
          window.loops.defaultWorkspace(),
          window.reports.list(),
        ])
        if (disposed) return
        setReports(savedReports)
        setHasMoreHistories(page.hasMore)
        setHistoryOffset(page.offset)
        setHistoryPageCount(page.snapshots.length)
        setHistoryWarning(page.hasMore ? `Showing the newest ${page.snapshots.length} of ${page.total} histories.` : null)
        let initial = active
        if (!initial && page.snapshots[0]) initial = await window.loops.get(page.snapshots[0].loop.id)
        if (disposed) return
        setSnapshots(initial ? selectSnapshotInList(page.snapshots, initial) : page.snapshots)
        setWorkspaceDir((current) => current || defaultDir)
        if (initial) {
          loopIdRef.current = initial.loop.id
          setSnapshot(initial)
          setImpl({ orchestratorModel: initial.loop.models.orchestratorModel, orchestratorEffort: newRunOrchestratorEffort(initial.loop.models.orchestratorEffort), subagentModel: initial.loop.models.subagentModel, subagentEffort: initial.loop.models.subagentEffort })
          setCritic({ criticModel: initial.loop.models.criticModel, criticEffort: initial.loop.models.criticEffort })
          setResearch({ researchModel: initial.loop.models.researchModel, researchEffort: initial.loop.models.researchEffort })
          setAssets({ assetModel: initial.loop.models.assetModel, assetEffort: initial.loop.models.assetEffort })
          setExpandedRuns(new Set([initial.loop.id]))
          const history = await window.loops.log(initial.loop.id)
          if (!disposed) setLines(history)
        } else {
          setComposing(true)
        }
      } catch (cause) {
        if (!disposed) {
          setComposing(true)
          setError(`Could not load runs: ${cause instanceof Error ? cause.message : 'IPC request failed.'}`)
        }
      } finally {
        if (!disposed) setLoaded(true)
      }
    })()
    return () => { disposed = true; removeUpdate(); removeLog() }
  }, [])

  const [critiqueRounds, setCritiqueRounds] = useState<CritiqueRound[]>([])
  const finishedCritiques = snapshot?.runs.filter((run) => run.role === 'critique' && run.status !== 'running').length ?? 0
  const activeLoopId = snapshot?.loop.id ?? null
  const referenceSignature = `${activeLoopId ?? ''}:${snapshot?.loop.status ?? ''}:${snapshot?.totalRuns ?? snapshot?.runs.length ?? 0}`

  useEffect(() => {
    if (!activeLoopId) return
    let disposed = false
    void window.loops.critique(activeLoopId).then((result) => {
      if (disposed) return
      if (result.ok) { setCritiqueRounds(result.value); setCritiqueError(null) }
      else { setCritiqueRounds([]); setCritiqueError(`Could not load critique details: ${result.error}`) }
    }).catch((cause: unknown) => {
      if (!disposed) setCritiqueError(`Could not load critique details: ${cause instanceof Error ? cause.message : 'IPC request failed.'}`)
    })
    return () => { disposed = true }
  }, [activeLoopId, finishedCritiques])

  useEffect(() => {
    if (!activeLoopId || !snapshot) return
    let disposed = false
    void window.loops.reference(activeLoopId).then((study) => {
      if (!disposed) setReferenceStudies(study ? new Map([[study.runId, study]]) : new Map())
    }).catch((cause: unknown) => {
      if (!disposed) setError(`Could not load reference study: ${errorMessage(cause, 'IPC request failed.')}`)
    })
    return () => { disposed = true }
  }, [activeLoopId, referenceSignature])

  useEffect(() => {
    if (!activeLoopId) return
    let disposed = false
    const round = selectedRound ?? 1
    setExactPrompts({ implement: null, critique: null })
    void Promise.all([
      window.loops.prompt(activeLoopId, 'implement', round),
      window.loops.prompt(activeLoopId, 'critique', round),
    ]).then(([implement, critique]) => {
      if (!disposed) setExactPrompts({
        implement: implement.ok ? implement.value.prompt : null,
        critique: critique.ok ? critique.value.prompt : null,
      })
    }).catch((cause: unknown) => {
      if (!disposed) setError(`Could not load exact prompts: ${errorMessage(cause, 'IPC request failed.')}`)
    })
    return () => { disposed = true }
  }, [activeLoopId, selectedRound])

  useEffect(() => {
    if (!activeLoopId) return
    let disposed = false
    void window.loops.playState(activeLoopId).then((state) => {
      if (!disposed) setPlay(state)
    }).catch((cause: unknown) => {
      if (!disposed) setPlay({ running: false, url: null, error: `Could not load game process state: ${errorMessage(cause, 'IPC request failed.')}`, round: null })
    })
    const removePlayState = window.loops.onPlayState((state) => { if (!disposed && state.loopId === activeLoopId) setPlay(state) })
    return () => { disposed = true; removePlayState() }
  }, [activeLoopId])

  const loop = snapshot?.loop ?? null

  const start = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const result = await window.loops.start({ prompt, workspaceDir, referenceMode, attachmentIds: attachments.map((item) => item.id), maxRounds: Number(maxRounds) || 10, budgetUsd: budget.trim() ? Number(budget) : null, ...impl, ...critic, ...research, ...assets })
      if (!result.ok) { setError(result.error ?? 'Failed to start.'); return }
      loopIdRef.current = result.loopId ?? null
      setLines([])
      setSelectedRound(null)
      setComposing(false)
      setSelectedReportId(null)
      setProjectOpen(false)
      const nextSnapshot = result.loopId ? await window.loops.get(result.loopId) : await window.loops.active()
      if (nextSnapshot) {
        setSnapshot(nextSnapshot)
        setSnapshots((current) => selectSnapshotInList(current, nextSnapshot))
        setExpandedRuns((current) => new Set(current).add(nextSnapshot.loop.id))
      }
      setPrompt('')
      for (const item of attachments) void window.attachments.remove(item.id)
      setAttachments([])
    } catch (cause) {
      setError(`Could not start run: ${errorMessage(cause, 'IPC request failed.')}`)
    } finally {
      setBusy(false)
    }
  }

  const selectRun = async (next: LoopSnapshot, round: number | null = null): Promise<void> => {
    selectionGeneration.current += 1
    setError(null)
    try {
      const detail = await window.loops.get(next.loop.id)
      if (!detail) throw new Error('Run history is no longer available.')
      loopIdRef.current = detail.loop.id
      setSnapshot(detail)
      setSnapshots((current) => selectSnapshotInList(current, detail))
      setImpl({ orchestratorModel: detail.loop.models.orchestratorModel, orchestratorEffort: newRunOrchestratorEffort(detail.loop.models.orchestratorEffort), subagentModel: detail.loop.models.subagentModel, subagentEffort: detail.loop.models.subagentEffort })
      setCritic({ criticModel: detail.loop.models.criticModel, criticEffort: detail.loop.models.criticEffort })
      setResearch({ researchModel: detail.loop.models.researchModel, researchEffort: detail.loop.models.researchEffort })
      setSelectedRound(round)
      setComposing(false)
      setSelectedReportId(null)
      setProjectOpen(false)
      setNotice(null)
      setLines(await window.loops.log(detail.loop.id))
    } catch (cause) {
      setLines([])
      setError(`Could not load run history: ${errorMessage(cause, 'IPC request failed.')}`)
    }
  }

  const beginNewRun = (): void => {
    setComposing(true)
    setSelectedReportId(null)
    setSelectedRound(null)
    setError(null)
    setNotice(null)
    setProjectOpen(false)
  }

  const renameLoop = async (title: string): Promise<OperationResult<LoopRecord>> => {
    if (!loop) return { ok: false, error: 'Run is no longer selected.' }
    const result = await window.loops.rename(loop.id, title)
    if (!result.ok) return result
    const updated = result.value
    setSnapshot((current) => current && current.loop.id === updated.id ? { ...current, loop: updated } : current)
    setSnapshots((current) => current.map((item) => item.loop.id === updated.id ? { ...item, loop: updated } : item))
    return result
  }

  const importRun = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const result = await window.loops.importRun()
      if (result.canceled) return
      if (!result.ok || !result.snapshot) { setError(result.error ?? 'Failed to import run.'); return }
      const imported = result.snapshot
      const page = await window.loops.list()
      loopIdRef.current = imported.loop.id
      setSnapshot(imported)
      setSnapshots(selectSnapshotInList(page.snapshots, imported))
      setHasMoreHistories(page.hasMore)
      setHistoryOffset(page.offset)
      setHistoryPageCount(page.snapshots.length)
      setHistoryWarning(page.hasMore ? `Showing the newest ${page.snapshots.length} of ${page.total} histories.` : null)
      setLines(await window.loops.log(imported.loop.id, LOG_LIMIT))
      setExpandedRuns((current) => new Set(current).add(imported.loop.id))
      setSelectedRound(null)
      setProjectOpen(false)
      setComposing(false)
      setSelectedReportId(null)
      setNotice(`Opened the complete run folder at ${imported.loop.workspaceDir}. Its project files and SQLite history remain together.`)
    } catch (cause) {
      setError(`Could not import run: ${errorMessage(cause, 'IPC request failed.')}`)
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
      if (!result.ok) { setError(result.error ?? 'Failed to export run.'); return }
      setNotice(`Exported the complete project and SQLite history to ${result.filePath ?? 'the selected folder'}. ${result.warning ?? ''}`.trim())
    } catch (cause) {
      setError(`Could not export run: ${errorMessage(cause, 'IPC request failed.')}`)
    } finally {
      setBusy(false)
    }
  }

  const deleteCheckedRuns = async (): Promise<void> => {
    const loopIds = [...checkedRuns]
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const result = await window.loops.deleteRuns(loopIds, deleteFiles)
      const removed = new Set(result.deletedIds)
      if (removed.size > 0) {
        const remaining = snapshots.filter((item) => !removed.has(item.loop.id))
        setSnapshots(remaining)
        setCheckedRuns((current) => new Set([...current].filter((id) => !removed.has(id))))
        if (loopIdRef.current && removed.has(loopIdRef.current)) {
          const next = remaining[0] ?? null
          loopIdRef.current = next?.loop.id ?? null
          setSnapshot(next)
          setSelectedRound(null)
          setLines(next ? await window.loops.log(next.loop.id) : [])
          if (!next) setComposing(true)
        }
        setNotice(`Deleted ${removed.size} ${removed.size === 1 ? 'run' : 'runs'}${deleteFiles ? ' and removed the project folders from disk' : '. The project folders remain on disk and can be imported again'}.`)
      }
      if (result.errors.length > 0) setError(result.errors.join(' '))
      setDeleteOpen(false)
      setDeleteFiles(false)
      if (removed.size > 0 && checkedRuns.size === removed.size) setEditingRuns(false)
    } catch (cause) {
      setError(`Could not delete runs: ${errorMessage(cause, 'IPC request failed.')}`)
    } finally {
      setBusy(false)
    }
  }

  const createReport = async (name: string): Promise<void> => {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const created = await window.reports.create(name, [...checkedRuns])
      if (!created) { setError('Could not create that report.'); return }
      setReports((current) => [created, ...current])
      setSelectedReportId(created.id)
      setNamingReport(false)
      setEditingRuns(false)
      setCheckedRuns(new Set())
      setComposing(false)
    } catch (cause) {
      setError(`Could not create report: ${errorMessage(cause, 'IPC request failed.')}`)
    } finally {
      setBusy(false)
    }
  }

  const importReport = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const result = await window.reports.importReport()
      if (result.canceled) return
      if (!result.ok || !result.report) { setError(result.error ?? 'Could not import that report.'); return }
      const imported = result.report
      setReports((current) => [imported, ...current.filter((item) => item.id !== imported.id)])
      setSelectedReportId(imported.id)
      setComposing(false)
      setNotice(`Opened “${imported.name}” with ${imported.rows.length} ${imported.rows.length === 1 ? 'run' : 'runs'}.`)
    } catch (cause) {
      setError(`Could not import report: ${errorMessage(cause, 'IPC request failed.')}`)
    } finally {
      setBusy(false)
    }
  }

  const loadRunPage = async (offset: number): Promise<void> => {
    if (!snapshot || runPageBusy) return
    setRunPageBusy(true)
    setError(null)
    try {
      const page = await window.loops.get(snapshot.loop.id, offset)
      if (!page) throw new Error('Run history is no longer available.')
      setSnapshot(page)
      setSnapshots((current) => selectSnapshotInList(current, page))
      setSelectedRound(null)
    } catch (cause) {
      setError(`Could not load attempt page: ${errorMessage(cause, 'IPC request failed.')}`)
    } finally {
      setRunPageBusy(false)
    }
  }

  const loadHistoryPage = async (offset: number): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const page = await window.loops.list(offset)
      setSnapshots(snapshot ? selectSnapshotInList(page.snapshots, snapshot) : page.snapshots)
      setHasMoreHistories(page.hasMore)
      setHistoryOffset(page.offset)
      setHistoryPageCount(page.snapshots.length)
      const first = page.snapshots.length > 0 ? page.offset + 1 : 0
      const last = page.offset + page.snapshots.length
      setHistoryWarning(page.total > page.snapshots.length ? `Showing histories ${first}–${last} of ${page.total}.` : null)
    } catch (cause) {
      setError(`Could not load older histories: ${errorMessage(cause, 'IPC request failed.')}`)
    } finally {
      setBusy(false)
    }
  }

  const resumeLoop = async (): Promise<void> => {
    if (!loop || busy || privilegedActionPending.current) return
    const generation = selectionGeneration.current
    const stillSelected = () => loopIdRef.current === loop.id && selectionGeneration.current === generation
    privilegedActionPending.current = true
    setBusy(true)
    setError(null)
    try {
      const result = await withExistingRunTrust(loop, window.loops.trust, stillSelected, (id) => window.loops.resume(id))
      if (stillSelected() && result && !result.ok) setError(result.error ?? 'Could not resume.')
    } catch (cause) {
      if (stillSelected()) setError(`Could not resume: ${errorMessage(cause, 'IPC request failed.')}`)
    } finally {
      privilegedActionPending.current = false
      setBusy(false)
    }
  }

  const startPlay = async (round: number | null): Promise<void> => {
    if (!loop || privilegedActionPending.current) return
    const generation = selectionGeneration.current
    const stillSelected = () => loopIdRef.current === loop.id && selectionGeneration.current === generation
    privilegedActionPending.current = true
    try {
      const state = await withExistingRunTrust(loop, window.loops.trust, stillSelected, (id) => window.loops.playStart(id, round))
      if (stillSelected() && state) setPlay(state)
    } catch (cause) {
      if (stillSelected()) setPlay({ running: false, url: null, error: `Could not start game process: ${errorMessage(cause, 'IPC request failed.')}`, round })
    } finally {
      privilegedActionPending.current = false
    }
  }

  const stopPlay = async (): Promise<void> => {
    if (!loop) return
    try {
      await window.loops.playStop(loop.id)
    } catch (cause) {
      setPlay((current) => ({ ...current, error: `Could not stop game process: ${errorMessage(cause, 'IPC request failed.')}` }))
    }
  }

  const stopLoop = async (): Promise<void> => {
    if (!loop || busy) return
    setBusy(true)
    setError(null)
    try {
      const result = await window.loops.stop(loop.id)
      if (!result.ok) setError(result.error)
    } catch (cause) {
      setError(`Could not stop run: ${errorMessage(cause, 'IPC request failed.')}`)
    } finally {
      setBusy(false)
    }
  }

  const readStream = useCallback(async (input: ReadRawStreamInput): Promise<OperationResult<RawStreamChunk>> => {
    try {
      return await window.loops.readStream(input)
    } catch (cause) {
      return { ok: false, error: `Could not read raw stream: ${errorMessage(cause, 'IPC request failed.')}` }
    }
  }, [])

  const pickWorkspace = async (): Promise<void> => {
    try {
      const directory = await window.loops.pickWorkspace()
      if (directory) setWorkspaceDir(directory)
      setProjectOpen(false)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not choose a project folder.')
    }
  }

  const projects = workspaceDir ? [workspaceDir] : []
  const selectedReport = reports.find((item) => item.id === selectedReportId) ?? null

  if (!loaded) return <main className="grid h-screen place-items-center bg-[#100d0e]"><LoaderCircle className="size-5 animate-spin text-[#68615f]" /></main>

  return (
    <div className="flex h-screen overflow-hidden bg-[#100d0e]">
      <RunSidebar
        snapshots={snapshots}
        reports={reports}
        selectedLoopId={composing || selectedReport ? null : (snapshot?.loop.id ?? null)}
        selectedReportId={selectedReport?.id ?? null}
        selectedRound={selectedRound}
        expandedRuns={expandedRuns}
        visibleRounds={visibleRounds}
        editing={editingRuns}
        checkedRuns={checkedRuns}
        onNewRun={beginNewRun}
        onImportRun={() => void importRun()}
        onSelectRun={(next) => void selectRun(next)}
        onSelectRound={(next, round) => void selectRun(next, round)}
        onToggleRun={(loopId) => setExpandedRuns((current) => { const next = new Set(current); if (next.has(loopId)) next.delete(loopId); else next.add(loopId); return next })}
        onLoadMore={(loopId) => setVisibleRounds((current) => ({ ...current, [loopId]: (current[loopId] ?? RUN_ROUNDS_PAGE_SIZE) + RUN_ROUNDS_PAGE_SIZE }))}
        onOpenAgents={onOpenAgents}
        onToggleEditing={() => {
          setEditingRuns((current) => !current)
          setCheckedRuns(new Set())
        }}
        onToggleChecked={(loopId) => setCheckedRuns((current) => {
          const next = new Set(current)
          if (next.has(loopId)) next.delete(loopId)
          else next.add(loopId)
          return next
        })}
        onToggleAllChecked={() => setCheckedRuns((current) => current.size === snapshots.length ? new Set() : new Set(snapshots.map((item) => item.loop.id)))}
        onDeleteChecked={() => { setDeleteFiles(false); setDeleteOpen(true) }}
        onCreateReport={() => setNamingReport(true)}
        onSelectReport={(report) => {
          setSelectedReportId(report.id)
          setComposing(false)
          setNotice(null)
          setError(null)
        }}
        onImportReport={() => void importReport()}
        onLoadOlderHistories={() => void loadHistoryPage(historyOffset + historyPageCount)}
        onLoadNewestHistories={() => void loadHistoryPage(0)}
        busy={busy}
        historyWarning={historyWarning}
        hasMoreHistories={hasMoreHistories}
        hasNewerHistories={historyOffset > 0}
      />
      <main ref={mainRef} className="min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-[min(980px,calc(100%-48px))] py-12 max-sm:w-[calc(100%-28px)] max-sm:py-7">
          {notice && <p className="mb-5 rounded-lg border border-emerald-700/40 bg-emerald-950/20 px-3 py-2.5 text-xs text-emerald-300">{notice}</p>}
          {error && selectedReport && <p className="mb-5 rounded-lg border border-[#603f3f] bg-[#251718] px-3 py-2.5 text-xs text-[#f0aaaa]">{error}</p>}
          {selectedReport ? (
            <ReportPanel
              report={selectedReport}
              snapshots={snapshots}
              onReplace={(next) => setReports((current) => current.map((item) => item.id === next.id ? next : item))}
              onDeleted={(reportId) => {
                setReports((current) => current.filter((item) => item.id !== reportId))
                setSelectedReportId(null)
                setNotice('Deleted that report. The runs it listed are untouched.')
              }}
              onNotice={(text) => { setNotice(text); setError(null) }}
              onError={(text) => { setError(text); setNotice(null) }}
            />
          ) : !snapshot || !loop ? (
            <div className="grid min-h-[60vh] place-content-center gap-3 text-center">
              <p className="text-sm text-[#a89b94]">Create a run to start building.</p>
              <button type="button" onClick={() => setComposing(true)} className="rounded-lg border border-[#49403c] px-5 py-2 text-sm text-[#e5dcd6] hover:bg-white/5">New run</button>
            </div>
          ) : (
            <RunDetail
              key={`${loop.id}:${selectedRound ?? 'all'}`}
              snapshot={snapshot}
              selectedRound={selectedRound}
              lines={lines}
              critiqueRounds={critiqueRounds}
              critiqueError={critiqueError}
              referenceStudies={referenceStudies}
              play={play}
              busy={busy}
              error={error}
              projectionWarning={snapshot.projectionWarning ?? null}
              exactImplementPrompt={exactPrompts.implement}
              exactCritiquePrompt={exactPrompts.critique}
              canLoadOlderRuns={olderRunPageOffset(snapshot) != null}
              canLoadNewerRuns={(snapshot.runOffset ?? 0) > 0}
              loadingOlderRuns={runPageBusy}
              onBack={() => setSelectedRound(null)}
              onRename={renameLoop}
              onPlayStart={(round) => { void startPlay(round) }}
              onPlayStop={() => { void stopPlay() }}
              onExport={() => void exportRun()}
              onStop={() => { void stopLoop() }}
              onResume={() => void resumeLoop()}
              onNewRun={beginNewRun}
              onLoadOlderRuns={() => { const offset = olderRunPageOffset(snapshot); if (offset != null) void loadRunPage(offset) }}
              onLoadNewestRuns={() => void loadRunPage(0)}
              onReadStream={readStream}
              onScrollTop={() => requestAnimationFrame(() => mainRef.current?.scrollTo({ top: 0 }))}
            />
          )}
        </div>
      </main>
      <RunComposerDialog open={composing} busy={busy || attachmentBusy} onOpenChange={setComposing}>
            <RunForm
              settings={formSettings}
              onSettingsChange={setFormSettings}
              onAttachmentBusyChange={setAttachmentBusy}
              attachments={attachments}
              onAttachmentsChange={setAttachments}
              referenceMode={referenceMode}
              onReferenceModeChange={setReferenceMode}
              workspaceDir={workspaceDir}
              projects={projects}
              projectOpen={projectOpen}
              prompt={prompt}
              maxRounds={maxRounds}
              budget={budget}
              impl={impl}
              critic={critic}
              research={research}
              assets={assets}
              error={error}
              busy={busy}
              onProjectOpenChange={setProjectOpen}
              onWorkspaceChange={setWorkspaceDir}
              onAddProject={() => void pickWorkspace()}
              onPromptChange={setPrompt}
              onMaxRoundsChange={setMaxRounds}
              onBudgetChange={setBudget}
              onImplChange={setImpl}
              onCriticChange={setCritic}
              onResearchChange={setResearch}
              onAssetsChange={setAssets}
              onCreate={() => void start()}
            />
      </RunComposerDialog>
      {deleteOpen && (
        <DeleteRunsDialog
          count={checkedRuns.size}
          deleteFiles={deleteFiles}
          busy={busy}
          onToggleFiles={() => setDeleteFiles((current) => !current)}
          onCancel={() => { setDeleteOpen(false); setDeleteFiles(false) }}
          onConfirm={() => void deleteCheckedRuns()}
        />
      )}
      {namingReport && (
        <NameReportDialog
          count={checkedRuns.size}
          busy={busy}
          defaultName={`Comparison — ${new Date().toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`}
          onCancel={() => setNamingReport(false)}
          onConfirm={(name) => void createReport(name)}
        />
      )}
    </div>
  )
}
