import { SteeringSidebar } from './SteeringSidebar'
import { newBuildOrchestratorEffort } from '../../../shared/models'
import { withExistingBuildTrust } from '@/lib/trusted-action'
import { DEFAULT_BUILD_PACE } from '../../../shared/build-presets'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { BuildAttachment } from '../../../shared/attachments'
import type { ReferenceMode } from '../../../shared/build'
import { LoaderCircle } from 'lucide-react'
import { BuildDetail } from '@/views/BuildDetail'
import { BuildComposerDialog } from '@/components/BuildComposerDialog'
import { BuildForm, type BuildFormSettings } from '@/views/BuildForm'
import { BuildSidebar, ATTEMPT_ROUNDS_PAGE_SIZE } from '@/views/BuildSidebar'
import { DeleteBuildsDialog, NameReportDialog, ReportPanel } from '@/views/ReportView'
import { applySnapshotUpdate, olderAttemptPageOffset, pruneExpandedBuilds, pruneVisibleRoundCounts, selectSnapshotInList } from '@/lib/build-pages'
import type { CritiqueRound, BuildLogLine, BuildRecord, BuildSnapshot, PlayState, RawStreamChunk, ReadRawStreamInput, ReferenceStudy } from '../../../shared/build'
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

export function BuildView({ onOpenAgents }: { onOpenAgents: () => void }): React.JSX.Element {
  const [snapshots, setSnapshots] = useState<BuildSnapshot[]>([])
  const [snapshot, setSnapshot] = useState<BuildSnapshot | null>(null)
  const [lines, setLines] = useState<BuildLogLine[]>([])
  const [composing, setComposing] = useState(false)
  const [attachmentBusy, setAttachmentBusy] = useState(false)
  const [formSettings, setFormSettings] = useState<BuildFormSettings>({ pace: DEFAULT_BUILD_PACE, custom: false, initialized: false })
  const [loaded, setLoaded] = useState(false)
  const [prompt, setPrompt] = useState('')
  const [attachments, setAttachments] = useState<BuildAttachment[]>([])
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
  const [editingBuilds, setEditingBuilds] = useState(false)
  const [checkedBuilds, setCheckedBuilds] = useState<Set<string>>(new Set())
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
  const [attemptPageBusy, setAttemptPageBusy] = useState(false)
  const [busy, setBusy] = useState(false)
  const [expandedBuilds, setExpandedBuilds] = useState<Set<string>>(new Set())
  const [visibleRounds, setVisibleRounds] = useState<Record<string, number>>({})
  const [selectedRound, setSelectedRound] = useState<number | null>(null)
  const [play, setPlay] = useState<PlayState>({ running: false, url: null, error: null, round: null })
  const [referenceStudies, setReferenceStudies] = useState<Map<string, ReferenceStudy>>(new Map())
  const [exactPrompts, setExactPrompts] = useState<{ implement: string | null; critique: string | null }>({ implement: null, critique: null })
  const selectionGeneration = useRef(0)
  const privilegedActionPending = useRef(false)
  useEffect(() => () => { selectionGeneration.current += 1 }, [])
  const buildIdRef = useRef<string | null>(null)
  const mainRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    setExpandedBuilds((current) => pruneExpandedBuilds(current, snapshots))
    setVisibleRounds((current) => pruneVisibleRoundCounts(current, snapshots, ATTEMPT_ROUNDS_PAGE_SIZE))
  }, [snapshots])

  useEffect(() => {
    let disposed = false
    const removeUpdate = window.builds.onUpdate((nextSnapshot) => {
      if (!buildIdRef.current || nextSnapshot.build.id === buildIdRef.current) {
        buildIdRef.current = nextSnapshot.build.id
        setSnapshot((current) => applySnapshotUpdate(current, nextSnapshot))
      }
      setSnapshots((current) => {
        const retained = current.find((item) => item.build.id === nextSnapshot.build.id)
        const detail = applySnapshotUpdate(retained ?? null, nextSnapshot)
        const next = selectSnapshotInList(current, detail)
        return next.sort((a, b) => a.build.createdAt < b.build.createdAt ? 1 : a.build.createdAt > b.build.createdAt ? -1 : 0)
      })
    })
    const removeLog = window.builds.onLog((line) => {
      if (line.buildId !== buildIdRef.current) return
      setLines((current) => {
        const next = [...current, line]
        return next.length > LOG_LIMIT ? next.slice(next.length - LOG_LIMIT) : next
      })
      if (line.attemptId) {
        setReferenceStudies((current) => {
          const study = current.get(line.attemptId!)
          if (!study) return current
          const next = new Map(current)
          next.set(line.attemptId!, { ...study, logs: [...study.logs, line].slice(-500) })
          return next
        })
      }
    })
    void (async () => {
      try {
        const [page, active, defaultDir, savedReports] = await Promise.all([
          window.builds.list(),
          window.builds.active(),
          window.builds.defaultWorkspace(),
          window.reports.list(),
        ])
        if (disposed) return
        setReports(savedReports)
        setHasMoreHistories(page.hasMore)
        setHistoryOffset(page.offset)
        setHistoryPageCount(page.snapshots.length)
        setHistoryWarning(page.hasMore ? `Showing the newest ${page.snapshots.length} of ${page.total} histories.` : null)
        let initial = active
        if (!initial && page.snapshots[0]) initial = await window.builds.get(page.snapshots[0].build.id)
        if (disposed) return
        setSnapshots(initial ? selectSnapshotInList(page.snapshots, initial) : page.snapshots)
        setWorkspaceDir((current) => current || defaultDir)
        if (initial) {
          buildIdRef.current = initial.build.id
          setSnapshot(initial)
          setImpl({ orchestratorModel: initial.build.models.orchestratorModel, orchestratorEffort: newBuildOrchestratorEffort(initial.build.models.orchestratorEffort), subagentModel: initial.build.models.subagentModel, subagentEffort: initial.build.models.subagentEffort })
          setCritic({ criticModel: initial.build.models.criticModel, criticEffort: initial.build.models.criticEffort })
          setResearch({ researchModel: initial.build.models.researchModel, researchEffort: initial.build.models.researchEffort })
          setAssets({ assetModel: initial.build.models.assetModel, assetEffort: initial.build.models.assetEffort })
          setExpandedBuilds(new Set([initial.build.id]))
          const history = await window.builds.log(initial.build.id)
          if (!disposed) setLines(history)
        } else {
          setComposing(true)
        }
      } catch (cause) {
        if (!disposed) {
          setComposing(true)
          setError(`Could not load builds: ${cause instanceof Error ? cause.message : 'IPC request failed.'}`)
        }
      } finally {
        if (!disposed) setLoaded(true)
      }
    })()
    return () => { disposed = true; removeUpdate(); removeLog() }
  }, [])

  const [critiqueRounds, setCritiqueRounds] = useState<CritiqueRound[]>([])
  const finishedCritiques = snapshot?.attempts.filter((attempt) => attempt.role === 'critique' && attempt.status !== 'running').length ?? 0
  const activeBuildId = snapshot?.build.id ?? null
  const referenceSignature = `${activeBuildId ?? ''}:${snapshot?.build.status ?? ''}:${snapshot?.totalAttempts ?? snapshot?.attempts.length ?? 0}`

  useEffect(() => {
    if (!activeBuildId) return
    let disposed = false
    void window.builds.critique(activeBuildId).then((result) => {
      if (disposed) return
      if (result.ok) { setCritiqueRounds(result.value); setCritiqueError(null) }
      else { setCritiqueRounds([]); setCritiqueError(`Could not load critique details: ${result.error}`) }
    }).catch((cause: unknown) => {
      if (!disposed) setCritiqueError(`Could not load critique details: ${cause instanceof Error ? cause.message : 'IPC request failed.'}`)
    })
    return () => { disposed = true }
  }, [activeBuildId, finishedCritiques])

  useEffect(() => {
    if (!activeBuildId || !snapshot) return
    let disposed = false
    void window.builds.reference(activeBuildId).then((study) => {
      if (!disposed) setReferenceStudies(study ? new Map([[study.attemptId, study]]) : new Map())
    }).catch((cause: unknown) => {
      if (!disposed) setError(`Could not load reference study: ${errorMessage(cause, 'IPC request failed.')}`)
    })
    return () => { disposed = true }
  }, [activeBuildId, referenceSignature])

  useEffect(() => {
    if (!activeBuildId) return
    let disposed = false
    const round = selectedRound ?? 1
    setExactPrompts({ implement: null, critique: null })
    void Promise.all([
      window.builds.prompt(activeBuildId, 'implement', round),
      window.builds.prompt(activeBuildId, 'critique', round),
    ]).then(([implement, critique]) => {
      if (!disposed) setExactPrompts({
        implement: implement.ok ? implement.value.prompt : null,
        critique: critique.ok ? critique.value.prompt : null,
      })
    }).catch((cause: unknown) => {
      if (!disposed) setError(`Could not load exact prompts: ${errorMessage(cause, 'IPC request failed.')}`)
    })
    return () => { disposed = true }
  }, [activeBuildId, selectedRound])

  useEffect(() => {
    if (!activeBuildId) return
    let disposed = false
    void window.builds.playState(activeBuildId).then((state) => {
      if (!disposed) setPlay(state)
    }).catch((cause: unknown) => {
      if (!disposed) setPlay({ running: false, url: null, error: `Could not load game process state: ${errorMessage(cause, 'IPC request failed.')}`, round: null })
    })
    const removePlayState = window.builds.onPlayState((state) => { if (!disposed && state.buildId === activeBuildId) setPlay(state) })
    return () => { disposed = true; removePlayState() }
  }, [activeBuildId])

  const build = snapshot?.build ?? null

  const start = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const result = await window.builds.start({ prompt, workspaceDir, referenceMode, attachmentIds: attachments.map((item) => item.id), maxRounds: Number(maxRounds) || 10, budgetUsd: budget.trim() ? Number(budget) : null, ...impl, ...critic, ...research, ...assets })
      if (!result.ok) { setError(result.error ?? 'Failed to start.'); return }
      buildIdRef.current = result.buildId ?? null
      setLines([])
      setSelectedRound(null)
      setComposing(false)
      setSelectedReportId(null)
      setProjectOpen(false)
      const nextSnapshot = result.buildId ? await window.builds.get(result.buildId) : await window.builds.active()
      if (nextSnapshot) {
        setSnapshot(nextSnapshot)
        setSnapshots((current) => selectSnapshotInList(current, nextSnapshot))
        setExpandedBuilds((current) => new Set(current).add(nextSnapshot.build.id))
      }
      setPrompt('')
      for (const item of attachments) void window.attachments.remove(item.id)
      setAttachments([])
    } catch (cause) {
      setError(`Could not start build: ${errorMessage(cause, 'IPC request failed.')}`)
    } finally {
      setBusy(false)
    }
  }

  const selectBuild = async (next: BuildSnapshot, round: number | null = null): Promise<void> => {
    selectionGeneration.current += 1
    setError(null)
    try {
      const detail = await window.builds.get(next.build.id)
      if (!detail) throw new Error('Build history is no longer available.')
      buildIdRef.current = detail.build.id
      setSnapshot(detail)
      setSnapshots((current) => selectSnapshotInList(current, detail))
      setImpl({ orchestratorModel: detail.build.models.orchestratorModel, orchestratorEffort: newBuildOrchestratorEffort(detail.build.models.orchestratorEffort), subagentModel: detail.build.models.subagentModel, subagentEffort: detail.build.models.subagentEffort })
      setCritic({ criticModel: detail.build.models.criticModel, criticEffort: detail.build.models.criticEffort })
      setResearch({ researchModel: detail.build.models.researchModel, researchEffort: detail.build.models.researchEffort })
      setSelectedRound(round)
      setComposing(false)
      setSelectedReportId(null)
      setProjectOpen(false)
      setNotice(null)
      setLines(await window.builds.log(detail.build.id))
    } catch (cause) {
      setLines([])
      setError(`Could not load build history: ${errorMessage(cause, 'IPC request failed.')}`)
    }
  }

  const beginNewBuild = (): void => {
    setComposing(true)
    setSelectedReportId(null)
    setSelectedRound(null)
    setError(null)
    setNotice(null)
    setProjectOpen(false)
  }

  const renameBuild = async (title: string): Promise<OperationResult<BuildRecord>> => {
    if (!build) return { ok: false, error: 'Build is no longer selected.' }
    const result = await window.builds.rename(build.id, title)
    if (!result.ok) return result
    const updated = result.value
    setSnapshot((current) => current && current.build.id === updated.id ? { ...current, build: updated } : current)
    setSnapshots((current) => current.map((item) => item.build.id === updated.id ? { ...item, build: updated } : item))
    return result
  }

  const importBuild = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const result = await window.builds.importBuild()
      if (result.canceled) return
      if (!result.ok || !result.snapshot) { setError(result.error ?? 'Failed to import build.'); return }
      const imported = result.snapshot
      const page = await window.builds.list()
      buildIdRef.current = imported.build.id
      setSnapshot(imported)
      setSnapshots(selectSnapshotInList(page.snapshots, imported))
      setHasMoreHistories(page.hasMore)
      setHistoryOffset(page.offset)
      setHistoryPageCount(page.snapshots.length)
      setHistoryWarning(page.hasMore ? `Showing the newest ${page.snapshots.length} of ${page.total} histories.` : null)
      setLines(await window.builds.log(imported.build.id, LOG_LIMIT))
      setExpandedBuilds((current) => new Set(current).add(imported.build.id))
      setSelectedRound(null)
      setProjectOpen(false)
      setComposing(false)
      setSelectedReportId(null)
      setNotice(`Opened the complete build folder at ${imported.build.workspaceDir}. Its project files and SQLite history remain together.`)
    } catch (cause) {
      setError(`Could not import build: ${errorMessage(cause, 'IPC request failed.')}`)
    } finally {
      setBusy(false)
    }
  }

  const exportBuild = async (): Promise<void> => {
    if (!build) return
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const result = await window.builds.exportBuild(build.id)
      if (result.canceled) return
      if (!result.ok) { setError(result.error ?? 'Failed to export build.'); return }
      setNotice(`Exported the complete project and SQLite history to ${result.filePath ?? 'the selected folder'}. ${result.warning ?? ''}`.trim())
    } catch (cause) {
      setError(`Could not export build: ${errorMessage(cause, 'IPC request failed.')}`)
    } finally {
      setBusy(false)
    }
  }

  const deleteCheckedBuilds = async (): Promise<void> => {
    const buildIds = [...checkedBuilds]
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const result = await window.builds.deleteBuilds(buildIds, deleteFiles)
      const removed = new Set(result.deletedIds)
      if (removed.size > 0) {
        const remaining = snapshots.filter((item) => !removed.has(item.build.id))
        setSnapshots(remaining)
        setCheckedBuilds((current) => new Set([...current].filter((id) => !removed.has(id))))
        if (buildIdRef.current && removed.has(buildIdRef.current)) {
          const next = remaining[0] ?? null
          buildIdRef.current = next?.build.id ?? null
          setSnapshot(next)
          setSelectedRound(null)
          setLines(next ? await window.builds.log(next.build.id) : [])
          if (!next) setComposing(true)
        }
        setNotice(`Deleted ${removed.size} ${removed.size === 1 ? 'build' : 'builds'}${deleteFiles ? ' and removed the project folders from disk' : '. The project folders remain on disk and can be imported again'}.`)
      }
      if (result.errors.length > 0) setError(result.errors.join(' '))
      setDeleteOpen(false)
      setDeleteFiles(false)
      if (removed.size > 0 && checkedBuilds.size === removed.size) setEditingBuilds(false)
    } catch (cause) {
      setError(`Could not delete builds: ${errorMessage(cause, 'IPC request failed.')}`)
    } finally {
      setBusy(false)
    }
  }

  const createReport = async (name: string): Promise<void> => {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const created = await window.reports.create(name, [...checkedBuilds])
      if (!created) { setError('Could not create that report.'); return }
      setReports((current) => [created, ...current])
      setSelectedReportId(created.id)
      setNamingReport(false)
      setEditingBuilds(false)
      setCheckedBuilds(new Set())
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
      setNotice(`Opened “${imported.name}” with ${imported.rows.length} ${imported.rows.length === 1 ? 'build' : 'builds'}.`)
    } catch (cause) {
      setError(`Could not import report: ${errorMessage(cause, 'IPC request failed.')}`)
    } finally {
      setBusy(false)
    }
  }

  const loadAttemptPage = async (offset: number): Promise<void> => {
    if (!snapshot || attemptPageBusy) return
    setAttemptPageBusy(true)
    setError(null)
    try {
      const page = await window.builds.get(snapshot.build.id, offset)
      if (!page) throw new Error('Build history is no longer available.')
      setSnapshot(page)
      setSnapshots((current) => selectSnapshotInList(current, page))
      setSelectedRound(null)
    } catch (cause) {
      setError(`Could not load attempt page: ${errorMessage(cause, 'IPC request failed.')}`)
    } finally {
      setAttemptPageBusy(false)
    }
  }

  const loadHistoryPage = async (offset: number): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const page = await window.builds.list(offset)
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

  const resumeBuild = async (): Promise<void> => {
    if (!build || busy || privilegedActionPending.current) return
    const generation = selectionGeneration.current
    const stillSelected = () => buildIdRef.current === build.id && selectionGeneration.current === generation
    privilegedActionPending.current = true
    setBusy(true)
    setError(null)
    try {
      const result = await withExistingBuildTrust(build, window.builds.trust, stillSelected, (id) => window.builds.resume(id))
      if (stillSelected() && result && !result.ok) setError(result.error ?? 'Could not resume.')
    } catch (cause) {
      if (stillSelected()) setError(`Could not resume: ${errorMessage(cause, 'IPC request failed.')}`)
    } finally {
      privilegedActionPending.current = false
      setBusy(false)
    }
  }

  const startPlay = async (round: number | null): Promise<void> => {
    if (!build || privilegedActionPending.current) return
    const generation = selectionGeneration.current
    const stillSelected = () => buildIdRef.current === build.id && selectionGeneration.current === generation
    privilegedActionPending.current = true
    try {
      const state = await withExistingBuildTrust(build, window.builds.trust, stillSelected, (id) => window.builds.playStart(id, round))
      if (stillSelected() && state) setPlay(state)
    } catch (cause) {
      if (stillSelected()) setPlay({ running: false, url: null, error: `Could not start game process: ${errorMessage(cause, 'IPC request failed.')}`, round })
    } finally {
      privilegedActionPending.current = false
    }
  }

  const stopPlay = async (): Promise<void> => {
    if (!build) return
    try {
      await window.builds.playStop(build.id)
    } catch (cause) {
      setPlay((current) => ({ ...current, error: `Could not stop game process: ${errorMessage(cause, 'IPC request failed.')}` }))
    }
  }

  const stopBuild = async (): Promise<void> => {
    if (!build || busy) return
    setBusy(true)
    setError(null)
    try {
      const result = await window.builds.stop(build.id)
      if (!result.ok) setError(result.error)
    } catch (cause) {
      setError(`Could not stop build: ${errorMessage(cause, 'IPC request failed.')}`)
    } finally {
      setBusy(false)
    }
  }

  const readStream = useCallback(async (input: ReadRawStreamInput): Promise<OperationResult<RawStreamChunk>> => {
    try {
      return await window.builds.readStream(input)
    } catch (cause) {
      return { ok: false, error: `Could not read raw stream: ${errorMessage(cause, 'IPC request failed.')}` }
    }
  }, [])

  const pickWorkspace = async (): Promise<void> => {
    try {
      const directory = await window.builds.pickWorkspace()
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
      <BuildSidebar
        snapshots={snapshots}
        reports={reports}
        selectedBuildId={composing || selectedReport ? null : (snapshot?.build.id ?? null)}
        selectedReportId={selectedReport?.id ?? null}
        selectedRound={selectedRound}
        expandedBuilds={expandedBuilds}
        visibleRounds={visibleRounds}
        editing={editingBuilds}
        checkedBuilds={checkedBuilds}
        onNewBuild={beginNewBuild}
        onImportBuild={() => void importBuild()}
        onSelectBuild={(next) => void selectBuild(next)}
        onSelectRound={(next, round) => void selectBuild(next, round)}
        onToggleBuild={(buildId) => setExpandedBuilds((current) => { const next = new Set(current); if (next.has(buildId)) next.delete(buildId); else next.add(buildId); return next })}
        onLoadMore={(buildId) => setVisibleRounds((current) => ({ ...current, [buildId]: (current[buildId] ?? ATTEMPT_ROUNDS_PAGE_SIZE) + ATTEMPT_ROUNDS_PAGE_SIZE }))}
        onOpenAgents={onOpenAgents}
        onToggleEditing={() => {
          setEditingBuilds((current) => !current)
          setCheckedBuilds(new Set())
        }}
        onToggleChecked={(buildId) => setCheckedBuilds((current) => {
          const next = new Set(current)
          if (next.has(buildId)) next.delete(buildId)
          else next.add(buildId)
          return next
        })}
        onToggleAllChecked={() => setCheckedBuilds((current) => current.size === snapshots.length ? new Set() : new Set(snapshots.map((item) => item.build.id)))}
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
                setNotice('Deleted that report. The builds it listed are untouched.')
              }}
              onNotice={(text) => { setNotice(text); setError(null) }}
              onError={(text) => { setError(text); setNotice(null) }}
            />
          ) : !snapshot || !build ? (
            <div className="grid min-h-[60vh] place-content-center gap-3 text-center">
              <p className="text-sm text-[#a89b94]">Create a build to get started.</p>
              <button type="button" onClick={() => setComposing(true)} className="rounded-lg border border-[#49403c] px-5 py-2 text-sm text-[#e5dcd6] hover:bg-white/5">New build</button>
            </div>
          ) : (
            <BuildDetail
              key={`${build.id}:${selectedRound ?? 'all'}`}
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
              canLoadOlderAttempts={olderAttemptPageOffset(snapshot) != null}
              canLoadNewerAttempts={(snapshot.attemptOffset ?? 0) > 0}
              loadingOlderAttempts={attemptPageBusy}
              onBack={() => setSelectedRound(null)}
              onRename={renameBuild}
              onPlayStart={(round) => { void startPlay(round) }}
              onPlayStop={() => { void stopPlay() }}
              onExport={() => void exportBuild()}
              onStop={() => { void stopBuild() }}
              onResume={() => void resumeBuild()}
              onNewBuild={beginNewBuild}
              onLoadOlderAttempts={() => { const offset = olderAttemptPageOffset(snapshot); if (offset != null) void loadAttemptPage(offset) }}
              onLoadNewestAttempts={() => void loadAttemptPage(0)}
              onReadStream={readStream}
              onScrollTop={() => requestAnimationFrame(() => mainRef.current?.scrollTo({ top: 0 }))}
            />
          )}
        </div>
      </main>
      {build && snapshot && !selectedReport && !composing && <SteeringSidebar key={build.id} buildId={build.id} buildName={build.title} round={build.round} buildStatus={build.status}/>}
      <BuildComposerDialog open={composing} busy={busy || attachmentBusy} onOpenChange={setComposing}>
            <BuildForm
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
      </BuildComposerDialog>
      {deleteOpen && (
        <DeleteBuildsDialog
          count={checkedBuilds.size}
          deleteFiles={deleteFiles}
          busy={busy}
          onToggleFiles={() => setDeleteFiles((current) => !current)}
          onCancel={() => { setDeleteOpen(false); setDeleteFiles(false) }}
          onConfirm={() => void deleteCheckedBuilds()}
        />
      )}
      {namingReport && (
        <NameReportDialog
          count={checkedBuilds.size}
          busy={busy}
          defaultName={`Comparison — ${new Date().toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`}
          onCancel={() => setNamingReport(false)}
          onConfirm={(name) => void createReport(name)}
        />
      )}
    </div>
  )
}
