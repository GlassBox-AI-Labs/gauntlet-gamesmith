import { useEffect, useRef, useState } from 'react'
import { Gauge, Paperclip, Sparkles } from 'lucide-react'
import { ModelSelectItems } from '@/components/ModelSelectItems'
import { RunAttachmentChips } from '@/components/RunAttachmentChips'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { AgentsView } from './AgentsView'
import { DEFAULT_RUN_PACE, RUN_PACES, runPreset, type RunPace } from '../../../shared/run-presets'
import { harnessFor } from '../../../shared/models'
import type { RunAttachment, AttachmentResult } from '../../../shared/attachments'
import type { ReferenceMode } from '../../../shared/loop'
import { Check, ChevronDown, FolderGit2, FolderPlus, LoaderCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import {
  AGENT_EFFORTS,
  type AssetFields,
  newRunOrchestratorEffort,
  SOLO_SUBAGENT,
  type CriticFields,
  type ImplementerFields,
  type ResearchFields,
} from '../../../shared/models'

function projectName(workspaceDir: string): string {
  return workspaceDir.split(/[\\/]/).filter(Boolean).at(-1) ?? 'Choose project'
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
        aria-expanded={open}
        aria-controls="project-chooser-menu"
        className="flex max-w-[360px] items-center gap-2 rounded-lg px-2.5 py-2 text-sm font-medium text-[#ded9d6] hover:bg-white/[0.05]"
      >
        <FolderGit2 className="size-4 text-[#bda99f]" />
        <span className="truncate">{projectName(value)}</span>
        <ChevronDown className={`size-3.5 text-[#77706d] transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div id="project-chooser-menu" className="absolute left-0 top-[calc(100%+8px)] z-30 w-[300px] overflow-hidden rounded-xl border border-[#443e3d] bg-[#282424] py-1.5 shadow-2xl">
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
              <FolderPlus className="size-4" /> Choose runs folder
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

export interface RunFormSettings { pace: RunPace; custom: boolean; initialized: boolean }

export interface RunFormProps {
  settings: RunFormSettings
  onSettingsChange: React.Dispatch<React.SetStateAction<RunFormSettings>>
  onAttachmentBusyChange: (busy: boolean) => void
  attachments: RunAttachment[]
  onAttachmentsChange: (items: RunAttachment[]) => void
  referenceMode: ReferenceMode
  onReferenceModeChange: (mode: ReferenceMode) => void
  workspaceDir: string
  projects: string[]
  projectOpen: boolean
  prompt: string
  maxRounds: string
  budget: string
  impl: ImplementerFields
  critic: CriticFields
  research: ResearchFields
  assets: AssetFields
  error: string | null
  busy: boolean
  onProjectOpenChange: (open: boolean) => void
  onWorkspaceChange: (workspaceDir: string) => void
  onAddProject: () => void
  onPromptChange: (prompt: string) => void
  onMaxRoundsChange: (maxRounds: string) => void
  onBudgetChange: (budget: string) => void
  onImplChange: (impl: ImplementerFields) => void
  onCriticChange: (critic: CriticFields) => void
  onResearchChange: (research: ResearchFields) => void
  onAssetsChange: (assets: AssetFields) => void
  onCreate: () => void
}

/** Controlled start form; persistence and IPC stay in RunView. */
export function RunForm({
  attachments, onAttachmentsChange, referenceMode, onReferenceModeChange, settings, onSettingsChange, onAttachmentBusyChange,
  workspaceDir,
  projects,
  projectOpen,
  prompt,
  maxRounds,
  budget,
  impl,
  critic,
  research,
  assets,
  error,
  busy,
  onProjectOpenChange,
  onWorkspaceChange,
  onAddProject,
  onPromptChange,
  onMaxRoundsChange,
  onBudgetChange,
  onImplChange,
  onCriticChange,
  onResearchChange,
  onAssetsChange,
  onCreate,
}: RunFormProps): React.JSX.Element {
  const [optionsOpen, setOptionsOpen] = useState(false)
  const [modelsOpen, setModelsOpen] = useState(false)
  const { pace, custom } = settings
  const setPace = (next: RunPace): void => onSettingsChange((current) => ({ ...current, pace: next, initialized: true }))
  const setCustom = (next: boolean): void => onSettingsChange((current) => ({ ...current, custom: next }))
  const [agentsOpen, setAgentsOpen] = useState(false)
  const [checking, setChecking] = useState(true)
  const [createAttempted, setCreateAttempted] = useState(false)
  const [connected, setConnected] = useState({ claude: false, codex: false })
  const [contextBusy, setContextBusy] = useState(false)
  const [contextError, setContextError] = useState<string | null>(null)
  const [contextNotice, setContextNotice] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const depth = useRef(0)
  const adding = useRef(false)
  const appliedPreset = useRef<string | null>(null)
  useEffect(() => {
    let disposed = false
    let latestProbe = 0
    const refresh = async (): Promise<void> => {
      const probe = ++latestProbe
      setChecking(true)
      try {
        const [claude, codex] = await Promise.all([window.harnesses.probe('claude'), window.harnesses.probe('codex')])
        if (!disposed && probe === latestProbe) setConnected({ claude: claude.loggedIn && claude.billingMode === 'subscription', codex: codex.loggedIn && codex.billingMode === 'subscription' })
      } catch { if (!disposed && probe === latestProbe) { setConnected({ claude: false, codex: false }); setContextError('Could not check agent access. Open Agents to retry.') } }
      finally { if (!disposed && probe === latestProbe) setChecking(false) }
    }
    void refresh()
    const remove = window.harnesses.onAccountsChanged(() => { void refresh() })
    const onFocus = (): void => { void refresh() }
    window.addEventListener('focus', onFocus)
    return () => { disposed = true; remove(); window.removeEventListener('focus', onFocus) }
  }, [agentsOpen])
  const applyPace = (next: RunPace, tools = connected, sculpting = assets.assetModel !== null): void => {
    const preset = runPreset(next, tools, sculpting)
    setPace(next); setCustom(false)
    onImplChange(preset); onCriticChange(preset); onResearchChange(preset); onAssetsChange(preset)
  }
  useEffect(() => {
    if (checking || busy || custom) return
    // Keep the draft when neither provider is available; Create stays disabled.
    if (!connected.claude && !connected.codex) { appliedPreset.current = null; return }
    const next = settings.initialized ? pace : DEFAULT_RUN_PACE
    const signature = `${next}:${connected.claude}:${connected.codex}:${assets.assetModel !== null}`
    if (appliedPreset.current === signature) return
    appliedPreset.current = signature
    if (!settings.initialized) onSettingsChange((current) => ({ ...current, initialized: true }))
    applyPace(next)
  }, [checking, connected.claude, connected.codex, busy, custom, pace, settings.initialized, assets.assetModel !== null])
  const add = async (operation: () => Promise<AttachmentResult<RunAttachment[]>>): Promise<void> => {
    if (adding.current || busy) return
    adding.current = true; setContextBusy(true); onAttachmentBusyChange(true); setContextError(null); setContextNotice(null)
    try {
      const result = await operation()
      if (!result.ok) { setContextError(result.error); return }
      onAttachmentsChange([...attachments, ...result.value])
      const skipped = result.value.reduce((sum, item) => sum + item.skipped, 0)
      if (skipped) setContextNotice(`${skipped} hidden, generated, unsupported, or linked entries were excluded from the folder snapshot.`)
    } catch { setContextError('Could not attach those files. Please choose them again.') }
    finally { adding.current = false; setContextBusy(false); onAttachmentBusyChange(false) }
  }
  const remove = async (id: string): Promise<void> => {
    if (busy || adding.current) return
    setContextError(null)
    try {
      const result = await window.attachments.remove(id)
      if (result.ok) onAttachmentsChange(attachments.filter((item) => item.id !== id))
      else setContextError(result.error)
    } catch { setContextError('Could not remove the attachment. Try again.') }
  }
  const changeImpl = (next: ImplementerFields): void => { setCustom(true); onImplChange(next) }
  const changeCritic = (next: CriticFields): void => { setCustom(true); onCriticChange(next) }
  const changeResearch = (next: ResearchFields): void => { setCustom(true); onResearchChange(next) }
  const changeAssets = (next: AssetFields): void => { setCustom(true); onAssetsChange(next) }
  const needed = [impl.orchestratorModel, impl.subagentModel, critic.criticModel, referenceMode === 'web' ? research.researchModel : null, referenceMode !== 'skip' ? assets.assetModel : null].filter((model): model is string => !!model)
  const agentsReady = needed.every((model) => connected[harnessFor(model)])
  const validLimits = /^\d+$/.test(maxRounds) && Number(maxRounds) >= 1 && Number(maxRounds) <= 100 && (!budget.trim() || Number.isFinite(Number(budget)) && Number(budget) > 0)
  const showConnectionError = createAttempted && !checking && !agentsReady
  const attemptCreate = (): void => {
    if (busy || contextBusy || checking) return
    setCreateAttempted(true)
    if (!agentsReady || !prompt.trim() || !workspaceDir || !validLimits || (referenceMode === 'files' && attachments.length === 0)) return
    onCreate()
  }
  return (
    <div className="mx-auto flex max-w-[880px] flex-col py-1">
      <Card
        onDragEnter={(event) => { if (!busy && !contextBusy && event.dataTransfer.types.includes('Files')) { event.preventDefault(); depth.current++; setDragging(true) } }}
        onDragOver={(event) => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); event.dataTransfer.dropEffect = busy || contextBusy ? 'none' : 'copy' } }}
        onDragLeave={() => { depth.current = Math.max(0, depth.current - 1); if (!depth.current) setDragging(false) }}
        onDrop={(event) => { event.preventDefault(); depth.current = 0; setDragging(false); const files = Array.from(event.dataTransfer.files); if (files.length) void add(() => window.attachments.addFiles(files)) }}
        className={`relative gap-0 overflow-visible border bg-[#1d1a19] p-0 shadow-2xl shadow-black/20 ${dragging ? 'border-[#d9aa93] ring-2 ring-[#d9aa93]/30' : 'border-[#3b3735]'}`}
      >
        {dragging && <div className="pointer-events-none absolute inset-0 z-40 grid place-items-center rounded-xl bg-[#211a17]/95 text-sm text-[#efd2c3]">Drop files or folders to add to context</div>}
        <div className="border-b border-[#34302f] px-2 py-1">
          <ProjectChooser value={workspaceDir} projects={projects} open={projectOpen} onOpenChange={onProjectOpenChange} onChange={onWorkspaceChange} onAddProject={onAddProject} />
        </div>
        <textarea aria-label="Game description" value={prompt} onChange={(event) => onPromptChange(event.target.value)} disabled={busy} rows={7} spellCheck={false} placeholder="Describe the game you want to build…" className="min-h-[220px] w-full resize-y bg-transparent px-5 py-5 text-[14px] leading-relaxed text-[#e4dfdc] outline-none placeholder:text-[#827975] focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-[#89776f]" />
        <div className="px-4 pb-3">
          <RunAttachmentChips items={attachments} disabled={busy || contextBusy} onRemove={(id) => void remove(id)} onError={setContextError} />
          {contextBusy && <p role="status" className="mt-2 text-[11px] text-[#a49790]">Copying context…</p>}
          {contextNotice && <p role="status" className="mt-2 text-[11px] text-[#b7a497]">{contextNotice}</p>}
          {contextError && <p role="alert" className="mt-2 text-xs text-[#f0aaaa]">{contextError}</p>}
        </div>
        <div className="border-t border-[#34302f] px-4 py-3">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
            <label title={custom ? 'Reset models to change pace' : 'Run pace'} className={`flex items-center gap-2 text-[11px] text-[#b2a7a1] ${custom ? 'opacity-40' : ''}`}><Gauge className="size-3.5" /><input aria-label="Speed to quality" type="range" min="0" max={RUN_PACES.length - 1} step="1" value={pace} aria-valuetext={RUN_PACES[pace]} disabled={custom || busy || checking} onChange={(event) => applyPace(Number(event.target.value) as RunPace)} className="h-1 w-20 accent-[#b9ada7]" /><span className="w-[60px]">{RUN_PACES[pace]}</span></label>
            <button type="button" aria-expanded={optionsOpen} onClick={() => setOptionsOpen(!optionsOpen)} className="flex items-center gap-1 text-[11px] text-[#a29791] hover:text-white">Run options{custom ? ' · Custom' : ''}<ChevronDown className={`size-3 ${optionsOpen ? 'rotate-180' : ''}`} /></button>
            <div className="ml-auto flex items-center gap-3">
              <button type="button" disabled={busy || contextBusy} onClick={() => void add(() => window.attachments.pick())} aria-label="Attach files or folders" title="Attach files or folders" className="grid size-9 place-items-center rounded text-[#a49790] hover:text-white disabled:opacity-40"><Paperclip aria-hidden="true" className="size-4" /></button>
              <Button disabled={busy || contextBusy || checking} onClick={attemptCreate} className="h-9 bg-[#eee8e4] px-4 text-xs text-[#201917] hover:bg-white">{busy && <LoaderCircle className="size-3 animate-spin" />}Create run</Button>
            </div>
          </div>
          {showConnectionError && <p role="alert" id="run-connection-error" className="mt-3 text-[11px] text-[#f0aaaa]">Connect the agents used by this configuration, or choose models from a connected agent.</p>}
          {createAttempted && agentsReady && !prompt.trim() && <p role="alert" className="mt-3 text-[11px] text-[#f0aaaa]">Describe the game you want to build.</p>}
          {createAttempted && agentsReady && !workspaceDir && <p role="alert" className="mt-3 text-[11px] text-[#f0aaaa]">Choose a workspace for this run.</p>}
          {referenceMode === 'files' && attachments.length === 0 && <p className="mt-3 text-[11px] text-[#d1a78e]">Attach files for a files-only Reference Study.</p>}
          {!validLimits && <p className="mt-3 text-[11px] text-[#d1a78e]">Choose 1–100 rounds and a positive budget, or leave the budget empty.</p>}
          {optionsOpen && <div className="mt-3 border-t border-[#302b2a] pt-3">
            <fieldset disabled={busy} className="grid gap-4">
              <div><p className="mb-2 text-[10px] uppercase tracking-wide text-[#a2958f]">Reference study</p><div className="flex flex-wrap gap-1 rounded-lg bg-[#151111] p-1">{(['web', 'files', 'skip'] as const).map((mode) => <button type="button" key={mode} aria-pressed={referenceMode === mode} onClick={() => onReferenceModeChange(mode)} className={`flex-1 rounded-md px-3 py-2 text-xs ${referenceMode === mode ? 'bg-[#332925] text-[#f0e9e5]' : 'text-[#9c8e87]'}`}>{mode === 'web' ? 'Web + files' : mode === 'files' ? 'Files only' : 'Skip'}</button>)}</div><p className="mt-2 text-[11px] text-[#a2958f]">{referenceMode === 'skip' ? 'Start implementation directly. No reference agent or web reference research.' : referenceMode === 'files' ? 'A reference agent studies supplied files only. No web research or researcher fan-out.' : 'A reference agent researches the web and studies supplied files.'}</p></div>
              <label className="flex items-center gap-2 text-xs text-[#c6bbb5]"><input type="checkbox" disabled={referenceMode === 'skip'} checked={referenceMode !== 'skip' && assets.assetModel !== null} onChange={(event) => onAssetsChange({ assetModel: event.target.checked ? impl.orchestratorModel : null, assetEffort: 'high' })} />3D model sculpting{referenceMode === 'skip' && <span className="text-[10px] text-[#958780]">Requires a reference cast; implementation builds assets itself.</span>}</label>
              <div className="grid grid-cols-2 gap-3"><label className="grid gap-1 text-[11px] text-[#b2a49d]">Maximum rounds<input aria-label="Maximum rounds" type="number" min="1" max="100" value={maxRounds} onChange={(event) => onMaxRoundsChange(event.target.value)} className="h-9 rounded border border-[#3a3432] bg-[#120f0f] px-3" /></label><label className="grid gap-1 text-[11px] text-[#b2a49d]">Budget · equivalent API cost ($)<input aria-label="Equivalent API cost budget" type="number" min="0.01" step="any" value={budget} onChange={(event) => onBudgetChange(event.target.value)} placeholder="No ceiling" className="h-9 rounded border border-[#3a3432] bg-[#120f0f] px-3" /></label></div>
              <div className="border-t border-[#302b2a] pt-3"><button type="button" aria-expanded={modelsOpen} onClick={() => setModelsOpen(!modelsOpen)} className="flex w-full items-center gap-2 text-left text-[11px] text-[#afa099]"><Sparkles className="size-3" />Fine-tune model configuration<span className="ml-auto">{custom ? 'Custom' : `From ${RUN_PACES[pace]}`}</span><ChevronDown className={`size-3 ${modelsOpen ? 'rotate-180' : ''}`} /></button>
                {modelsOpen && <div className="mt-3">{custom && <button type="button" onClick={() => applyPace(pace)} className="mb-3 text-xs text-[#d7b6a4]">Reset to {RUN_PACES[pace]}</button>}
      <div className="mb-4 grid gap-3 rounded-lg border border-[#393433] bg-[#161212] p-3.5">
        <div className="grid grid-cols-[92px_1fr_1fr] items-center gap-2.5 max-sm:grid-cols-1">
          <span className="text-xs text-[#7d7772]">Orchestrator</span>
          <Select
            value={impl.orchestratorModel}
            onValueChange={(value) => changeImpl({
              ...impl,
              orchestratorModel: value,
              // Keep new runs on explicit reasoning efforts (ADR-019).
              // A historical setting must not re-enable automatic delegation.
              orchestratorEffort: newRunOrchestratorEffort(impl.orchestratorEffort),
            })}
          >
            <SelectTrigger aria-label="Orchestrator model"><SelectValue /></SelectTrigger>
            <SelectContent>
              <ModelSelectItems />
            </SelectContent>
          </Select>
          <Select value={impl.orchestratorEffort} onValueChange={(value) => changeImpl({ ...impl, orchestratorEffort: value })}>
            <SelectTrigger aria-label="Orchestrator effort"><SelectValue /></SelectTrigger>
            <SelectContent>
              {AGENT_EFFORTS.map((effort) => (
                <SelectItem key={effort} value={effort}>
                  {effort}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="grid grid-cols-[92px_1fr_1fr] items-center gap-2.5 max-sm:grid-cols-1">
          <span className="text-xs text-[#7d7772]">Subagents</span>
          <Select
            value={impl.subagentModel ?? SOLO_SUBAGENT}
            onValueChange={(value) => changeImpl({ ...impl, subagentModel: value === SOLO_SUBAGENT ? null : value })}
          >
            <SelectTrigger aria-label="Subagent model"><SelectValue /></SelectTrigger>
            <SelectContent>
              <ModelSelectItems />
              <SelectItem value={SOLO_SUBAGENT}>Solo — orchestrator codes</SelectItem>
            </SelectContent>
          </Select>
          <Select
            value={impl.subagentEffort}
            onValueChange={(value) => changeImpl({ ...impl, subagentEffort: value })}
            disabled={impl.subagentModel === null}
          >
            <SelectTrigger aria-label="Subagent effort" className={impl.subagentModel === null ? 'opacity-50' : undefined}><SelectValue /></SelectTrigger>
            <SelectContent>
              {AGENT_EFFORTS.map((effort) => <SelectItem key={effort} value={effort}>{effort}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        {impl.subagentModel === null && <p className="text-xs text-[#958780]">The orchestrator writes the code itself, without subagents.</p>}
        <div className="grid grid-cols-[92px_1fr_1fr] items-center gap-2.5 max-sm:grid-cols-1">
          <span className="text-xs text-[#7d7772]">Research</span>
          <Select
            value={research.researchModel ?? SOLO_SUBAGENT}
            onValueChange={(value) => changeResearch({ ...research, researchModel: value === SOLO_SUBAGENT ? null : value })}
          >
            <SelectTrigger aria-label="Researcher model"><SelectValue /></SelectTrigger>
            <SelectContent>
              <ModelSelectItems />
              <SelectItem value={SOLO_SUBAGENT}>none (no fan-out)</SelectItem>
            </SelectContent>
          </Select>
          <Select
            value={research.researchEffort}
            onValueChange={(value) => changeResearch({ ...research, researchEffort: value })}
            disabled={research.researchModel === null}
          >
            <SelectTrigger aria-label="Researcher effort" className={research.researchModel === null ? 'opacity-50' : undefined}><SelectValue /></SelectTrigger>
            <SelectContent>
              {AGENT_EFFORTS.map((effort) => <SelectItem key={effort} value={effort}>{effort}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        {referenceMode === 'web' && <>
        <div className="grid grid-cols-[92px_1fr_1fr] items-center gap-2.5 max-sm:grid-cols-1">
          <span className="text-xs text-[#7d7772]">Critic</span>
          <Select value={critic.criticModel} onValueChange={(value) => changeCritic({ ...critic, criticModel: value })}>
            <SelectTrigger aria-label="Critic model"><SelectValue /></SelectTrigger>
            <SelectContent>
              <ModelSelectItems />
            </SelectContent>
          </Select>
          <Select value={critic.criticEffort} onValueChange={(value) => changeCritic({ ...critic, criticEffort: value })}>
            <SelectTrigger aria-label="Critic effort"><SelectValue /></SelectTrigger>
            <SelectContent>
              {AGENT_EFFORTS.map((effort) => <SelectItem key={effort} value={effort}>{effort}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        </>}
        <div className="grid grid-cols-[92px_1fr_1fr] items-center gap-2.5 max-sm:grid-cols-1">
          <span className="text-xs text-[#7d7772]">Asset sculptors</span>
          <Select
            value={assets.assetModel ?? SOLO_SUBAGENT}
            onValueChange={(value) => changeAssets({ ...assets, assetModel: value === SOLO_SUBAGENT ? null : value })}
          >
            <SelectTrigger aria-label="Asset model"><SelectValue /></SelectTrigger>
            <SelectContent>
              <ModelSelectItems />
              <SelectItem value={SOLO_SUBAGENT}>none (implement by hand)</SelectItem>
            </SelectContent>
          </Select>
          <Select
            value={assets.assetEffort}
            onValueChange={(value) => changeAssets({ ...assets, assetEffort: value })}
            disabled={assets.assetModel === null}
          >
            <SelectTrigger aria-label="Asset effort" className={assets.assetModel === null ? 'opacity-50' : undefined}><SelectValue /></SelectTrigger>
            <SelectContent>
              {AGENT_EFFORTS.map((effort) => <SelectItem key={effort} value={effort}>{effort}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
      </div>
                </div>}
              </div>
            </fieldset>
          </div>}
        </div>
        {error && <p role="alert" className="mx-4 mb-3 rounded-lg border border-[#603f3f] bg-[#251718] px-3 py-2.5 text-xs text-[#f0aaaa]">{error}</p>}
      </Card>
      <div className="mt-3 flex flex-wrap items-center gap-2">{(['claude', 'codex'] as const).map((kind) => {
        const needsConnection = showConnectionError && !connected[kind] && ((!connected.claude && !connected.codex) || needed.some((model) => harnessFor(model) === kind))
        return <button type="button" key={kind} onClick={() => setAgentsOpen(true)} aria-describedby={needsConnection ? 'run-connection-error' : undefined} className={`flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs ${needsConnection ? 'border-red-400 bg-red-950/30 text-red-200 ring-1 ring-red-400/30' : 'border-[#3b3534] bg-[#1b1717] text-[#cfc8c4]'}`}><span className={`size-2 rounded-full ${connected[kind] ? 'bg-emerald-400' : needsConnection ? 'bg-red-400' : 'bg-[#69615e]'}`} />{kind === 'claude' ? 'Claude Code' : 'Codex'}<span className={`text-[10px] ${needsConnection ? 'text-red-200' : 'text-[#a3948c]'}`}>{checking ? 'Checking…' : connected[kind] ? 'Connected · Manage' : 'Connect'}</span></button>
      })}</div>
      <Sheet open={agentsOpen} onOpenChange={setAgentsOpen}><SheetContent className="overflow-y-auto"><SheetHeader><SheetTitle>Agent connections</SheetTitle><SheetDescription>Sign in through the installed CLI. Your run draft stays here.</SheetDescription></SheetHeader><div className="px-4 pb-6"><AgentsView /></div></SheetContent></Sheet>
    </div>
  )
}
