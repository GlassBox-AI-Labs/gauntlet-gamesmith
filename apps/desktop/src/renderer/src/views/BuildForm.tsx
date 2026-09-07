import { useEffect, useRef, useState } from 'react'
import { Gauge, Paperclip, Sparkles } from 'lucide-react'
import { BuildAttachmentChips } from '@/components/BuildAttachmentChips'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { AgentsView } from './AgentsView'
import { DEFAULT_BUILD_PACE, BUILD_PACES, presetSlices, type BuildPace } from '../../../shared/build-presets'
import {
  crossFamilyModel,
  describeCritic,
  harnessFor,
  MODEL_LADDER,
  modelAtTier,
  modelLabel,
  modelTier,
} from '../../../shared/models'
import type { BuildAttachment, AttachmentResult } from '../../../shared/attachments'
import type { ReferenceMode } from '../../../shared/build'
import { Check, ChevronDown, FolderGit2, FolderPlus, LoaderCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import {
  AGENT_EFFORTS,
  type AssetFields,
  newBuildOrchestratorEffort,
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
              <FolderPlus className="size-4" /> Choose project folder
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

const EFFORT_ONLY = AGENT_EFFORTS as readonly string[]
function effortIndex(effort: string): number {
  const at = EFFORT_ONLY.indexOf(effort)
  return at < 0 ? 0 : at
}

/**
 * A row of clickable cells filled up to the chosen level. Blue reads as model
 * tier, amber as effort, so the two axes stay distinct at a glance. This is the
 * one control the operator wanted over a dropdown: the level is the shape.
 */
function Meter({ value, levels, onChange, tone, label, disabled }: {
  value: number
  levels: number
  onChange: (level: number) => void
  tone: 'model' | 'effort'
  label: string
  disabled?: boolean
}): React.JSX.Element {
  const filled = tone === 'model' ? 'bg-[#6f8fd6]' : 'bg-[#d6a24e]'
  return (
    <div role="group" aria-label={label} className={`flex items-center gap-1 ${disabled ? 'pointer-events-none opacity-40' : ''}`}>
      {Array.from({ length: levels }, (_, i) => (
        <button
          type="button"
          key={i}
          disabled={disabled}
          aria-label={`${label}: level ${i + 1} of ${levels}`}
          aria-pressed={i === value}
          onClick={() => onChange(i)}
          className={`h-5 w-3.5 rounded-[3px] transition-colors ${i <= value ? filled : 'bg-[#332e2d]'} ${i === value ? 'ring-1 ring-white/50' : ''}`}
        />
      ))}
    </div>
  )
}

/**
 * One agent's model tier and effort. `model === null` is the role turned off
 * (Solo/no fan-out/by hand), available only where `offLabel` is given; the
 * orchestrator and critic always run. The model meter walks the role's own
 * family ladder; the family pills, shown only when cross-family is on, jump the
 * same tier into the other family so a single role (typically the critic) can
 * differ without moving the rest.
 */
function RoleRow({ label, model, effort, offLabel, crossFamily, onModel, onEffort }: {
  label: string
  model: string | null
  effort: string
  offLabel?: string
  crossFamily: boolean
  onModel: (model: string | null) => void
  onEffort: (effort: string) => void
}): React.JSX.Element {
  const off = model === null
  const family = harnessFor(model)
  const ladder = MODEL_LADDER[family]
  return (
    <div className="grid grid-cols-[104px_1fr] items-start gap-3 max-sm:grid-cols-1">
      <span className="pt-1 text-xs text-[#7d7772]">{label}</span>
      <div className="grid gap-2">
        <div className="flex flex-wrap items-center gap-3">
          {offLabel && (
            <button
              type="button"
              aria-pressed={off}
              onClick={() => onModel(off ? modelAtTier(family, modelTier(model)) : null)}
              className={`rounded-full border px-2 py-0.5 text-[10px] ${off ? 'border-[#5b534f] bg-[#2a2523] text-[#d7cfca]' : 'border-transparent text-[#8b807a] hover:text-[#c9c1bc]'}`}
            >
              {off ? offLabel : 'On'}
            </button>
          )}
          {!off && (
            <>
              <Meter tone="model" label={`${label} model tier`} levels={ladder.length} value={modelTier(model)} onChange={(t) => onModel(modelAtTier(family, t))} />
              <span className="min-w-[96px] text-[11px] text-[#b3a9a3]">{modelLabel(model)}</span>
            </>
          )}
        </div>
        {!off && (
          <div className="flex flex-wrap items-center gap-3">
            <Meter tone="effort" label={`${label} effort`} levels={EFFORT_ONLY.length} value={effortIndex(effort)} onChange={(i) => onEffort(EFFORT_ONLY[i])} />
            <span className="min-w-[96px] text-[11px] text-[#8f857f]">{effort}</span>
          </div>
        )}
        {crossFamily && !off && (
          <div role="group" aria-label={`${label} model family`} className="flex items-center gap-1">
            {(['claude', 'codex'] as const).map((f) => (
              <button
                type="button"
                key={f}
                aria-pressed={family === f}
                onClick={() => { if (family !== f) onModel(crossFamilyModel(model)) }}
                className={`rounded-full px-2 py-0.5 text-[10px] ${family === f ? 'bg-[#332925] text-[#f0e9e5]' : 'text-[#8b807a] hover:text-[#c9c1bc]'}`}
              >
                {f === 'claude' ? 'Claude' : 'Codex'}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

export interface BuildFormSettings { pace: BuildPace; custom: boolean; initialized: boolean }

export interface BuildFormProps {
  settings: BuildFormSettings
  onSettingsChange: React.Dispatch<React.SetStateAction<BuildFormSettings>>
  onAttachmentBusyChange: (busy: boolean) => void
  attachments: BuildAttachment[]
  onAttachmentsChange: (items: BuildAttachment[]) => void
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

/** Controlled start form; persistence and IPC stay in BuildView. */
export function BuildForm({
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
}: BuildFormProps): React.JSX.Element {
  const [optionsOpen, setOptionsOpen] = useState(false)
  const [modelsOpen, setModelsOpen] = useState(false)
  // The two Advanced leans and the per-role family toggle are view state: they
  // set the same four field groups the collapsed scrubber does, so nothing here
  // needs to persist. Leans track the pace until the operator moves them apart.
  const [modelLean, setModelLean] = useState<BuildPace>(settings.pace)
  const [effortLean, setEffortLean] = useState<BuildPace>(settings.pace)
  const [crossFamily, setCrossFamily] = useState(false)
  const { pace, custom } = settings
  const setPace = (next: BuildPace): void => onSettingsChange((current) => ({ ...current, pace: next, initialized: true }))
  const setCustom = (next: boolean): void => onSettingsChange((current) => ({ ...current, custom: next }))
  const [agentsOpen, setAgentsOpen] = useState(false)
  const [checking, setChecking] = useState(true)
  const [createAttempted, setCreateAttempted] = useState(false)
  const [connected, setConnected] = useState({ claude: false, codex: false })
  const [contextBusy, setContextBusy] = useState(false)
  const [copyingDroppedContext, setCopyingDroppedContext] = useState(false)
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
  const applyPace = (next: BuildPace, tools = connected, sculpting = assets.assetModel !== null): void => {
    const preset = presetSlices(next, next, tools, sculpting)
    setPace(next); setCustom(false); setModelLean(next); setEffortLean(next)
    onImplChange(preset.impl); onCriticChange(preset.critic); onResearchChange(preset.research); onAssetsChange(preset.assets)
  }
  // The Advanced leans decouple what the pace ties together. Applying them is a
  // hand edit (custom), so the collapsed scrubber steps aside until a preset is
  // chosen again; per-role meters then nudge individual roles off the lean.
  const applyLeans = (model: BuildPace, effort: BuildPace): void => {
    const preset = presetSlices(model, effort, connected, assets.assetModel !== null)
    setModelLean(model); setEffortLean(effort); setCustom(true)
    onImplChange(preset.impl); onCriticChange(preset.critic); onResearchChange(preset.research); onAssetsChange(preset.assets)
  }
  useEffect(() => {
    if (checking || busy || custom) return
    // Keep the draft when neither provider is available; Create explains the missing connection.
    if (!connected.claude && !connected.codex) { appliedPreset.current = null; return }
    const next = settings.initialized ? pace : DEFAULT_BUILD_PACE
    const signature = `${next}:${connected.claude}:${connected.codex}:${assets.assetModel !== null}`
    if (appliedPreset.current === signature) return
    appliedPreset.current = signature
    if (!settings.initialized) onSettingsChange((current) => ({ ...current, initialized: true }))
    applyPace(next)
  }, [checking, connected.claude, connected.codex, busy, custom, pace, settings.initialized, assets.assetModel !== null])
  const [copyProgress, setCopyProgress] = useState<{ files: number; bytes: number } | null>(null)
  useEffect(() => window.attachments.onProgress(value => { setCopyProgress(value); setCopyingDroppedContext(true) }), [])
  const add = async (operation: () => Promise<AttachmentResult<BuildAttachment[]>>, fromPicker = false): Promise<void> => {
    if (adding.current || busy) return
    adding.current = true; setCopyProgress(null); setCopyingDroppedContext(!fromPicker); setContextBusy(true); onAttachmentBusyChange(true); setContextError(null); setContextNotice(null)
    try {
      const result = await operation()
      if (!result.ok) { setContextError(result.error); return }
      onAttachmentsChange([...attachments, ...result.value])
      const skipped = result.value.reduce((sum, item) => sum + item.skipped, 0)
      if (skipped) setContextNotice(`${skipped} hidden, generated, unsupported, or linked entries were excluded from the folder snapshot.`)
    } catch { setContextError('Could not attach those files. Please choose them again.') }
    finally { adding.current = false; setCopyingDroppedContext(false); setContextBusy(false); onAttachmentBusyChange(false) }
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
          <BuildAttachmentChips items={attachments} disabled={busy || contextBusy} onRemove={(id) => void remove(id)} onError={setContextError} />
          {copyingDroppedContext && <p role="status" className="mt-2 text-[11px] text-[#a49790]">Copying context…{copyProgress ? ` ${copyProgress.files} files · ${(copyProgress.bytes / 1024 / 1024).toFixed(1)} MB` : ''}</p>}
          {contextNotice && <p role="status" className="mt-2 text-[11px] text-[#b7a497]">{contextNotice}</p>}
          {contextError && <p role="alert" className="mt-2 text-xs text-[#f0aaaa]">{contextError}</p>}
        </div>
        <div className="border-t border-[#34302f] px-4 py-3">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
            <label title={custom ? 'Reset models to change pace' : 'Build pace'} className={`flex items-center gap-2 text-[11px] text-[#b2a7a1] ${custom ? 'opacity-40' : ''}`}><Gauge className="size-3.5" /><input aria-label="Speed to quality" type="range" min="0" max={BUILD_PACES.length - 1} step="1" value={pace} aria-valuetext={BUILD_PACES[pace]} disabled={custom || busy || checking} onChange={(event) => applyPace(Number(event.target.value) as BuildPace)} className="h-1 w-20 accent-[#b9ada7]" /><span className="w-[60px]">{BUILD_PACES[pace]}</span></label>
            <button type="button" aria-expanded={optionsOpen} onClick={() => setOptionsOpen(!optionsOpen)} className="flex items-center gap-1 text-[11px] text-[#a29791] hover:text-white">Build options{custom ? ' · Custom' : ''}<ChevronDown className={`size-3 ${optionsOpen ? 'rotate-180' : ''}`} /></button>
            <span title={describeCritic(critic.criticModel, impl.orchestratorModel)} className={`flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] ${harnessFor(critic.criticModel) !== harnessFor(impl.orchestratorModel) ? 'border-[#42557d] bg-[#1a2230] text-[#a9c1ea]' : 'border-[#4a423f] bg-[#241f1e] text-[#a99e98]'}`}>Critic · {harnessFor(critic.criticModel) === 'codex' ? 'Codex' : 'Claude'}{harnessFor(critic.criticModel) !== harnessFor(impl.orchestratorModel) ? ' · cross-family' : ''}</span>
            <div className="ml-auto flex items-center gap-3">
              <button type="button" disabled={busy || contextBusy} onClick={() => void add(() => window.attachments.pick(), true)} aria-label="Attach files or folders" title="Attach files or folders" className="grid size-9 place-items-center rounded text-[#a49790] hover:text-white disabled:opacity-40"><Paperclip aria-hidden="true" className="size-4" /></button>
              <Button disabled={busy || contextBusy || checking} onClick={attemptCreate} className="h-9 bg-[#eee8e4] px-4 text-xs text-[#201917] hover:bg-white">{busy && <LoaderCircle className="size-3 animate-spin" />}Create build</Button>
            </div>
          </div>
          {showConnectionError && <p role="alert" id="build-connection-error" className="mt-3 text-[11px] text-[#f0aaaa]">Connect the agents used by this configuration, or choose models from a connected agent.</p>}
          {createAttempted && agentsReady && !prompt.trim() && <p role="alert" className="mt-3 text-[11px] text-[#f0aaaa]">Describe the game you want to build.</p>}
          {createAttempted && agentsReady && !workspaceDir && <p role="alert" className="mt-3 text-[11px] text-[#f0aaaa]">Choose a workspace for this build.</p>}
          {referenceMode === 'files' && attachments.length === 0 && <p className="mt-3 text-[11px] text-[#d1a78e]">Attach files for a files-only Reference Study.</p>}
          {!validLimits && <p className="mt-3 text-[11px] text-[#d1a78e]">Choose 1–100 rounds and a positive budget, or leave the budget empty.</p>}
          {optionsOpen && <div className="mt-3 border-t border-[#302b2a] pt-3">
            <fieldset disabled={busy} className="grid gap-4">
              <div><p className="mb-2 text-[10px] uppercase tracking-wide text-[#a2958f]">Reference study</p><div className="flex flex-wrap gap-1 rounded-lg bg-[#151111] p-1">{(['web', 'files', 'skip'] as const).map((mode) => <button type="button" key={mode} aria-pressed={referenceMode === mode} onClick={() => onReferenceModeChange(mode)} className={`flex-1 rounded-md px-3 py-2 text-xs ${referenceMode === mode ? 'bg-[#332925] text-[#f0e9e5]' : 'text-[#9c8e87]'}`}>{mode === 'web' ? 'Web + files' : mode === 'files' ? 'Files only' : 'Skip'}</button>)}</div><p className="mt-2 text-[11px] text-[#a2958f]">{referenceMode === 'skip' ? 'Start implementation directly. No reference agent or web reference research.' : referenceMode === 'files' ? 'A reference agent studies supplied files only. No web research or researcher fan-out.' : 'A reference agent researches the web and studies supplied files.'}</p></div>
              <label className="flex items-center gap-2 text-xs text-[#c6bbb5]"><input type="checkbox" disabled={referenceMode === 'skip'} checked={referenceMode !== 'skip' && assets.assetModel !== null} onChange={(event) => onAssetsChange({ assetModel: event.target.checked ? impl.orchestratorModel : null, assetEffort: 'high' })} />3D model sculpting{referenceMode === 'skip' && <span className="text-[10px] text-[#958780]">Requires a reference cast; implementation builds assets itself.</span>}</label>
              <div className="grid grid-cols-2 gap-3"><label className="grid gap-1 text-[11px] text-[#b2a49d]">Maximum rounds<input aria-label="Maximum rounds" type="number" min="1" max="100" value={maxRounds} onChange={(event) => onMaxRoundsChange(event.target.value)} className="h-9 rounded border border-[#3a3432] bg-[#120f0f] px-3" /></label><label className="grid gap-1 text-[11px] text-[#b2a49d]">Budget · equivalent API cost ($)<input aria-label="Equivalent API cost budget" type="number" min="0.01" step="any" value={budget} onChange={(event) => onBudgetChange(event.target.value)} placeholder="No ceiling" className="h-9 rounded border border-[#3a3432] bg-[#120f0f] px-3" /></label></div>
              <div className="border-t border-[#302b2a] pt-3">
                <button type="button" aria-expanded={modelsOpen} onClick={() => setModelsOpen(!modelsOpen)} className="flex w-full items-center gap-2 text-left text-[11px] text-[#afa099]"><Sparkles className="size-3" />Advanced · per-role models &amp; effort<span className="ml-auto">{custom ? 'Custom' : `From ${BUILD_PACES[pace]}`}</span><ChevronDown className={`size-3 ${modelsOpen ? 'rotate-180' : ''}`} /></button>
                {modelsOpen && <div className="mt-3 grid gap-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
                      <div className="flex items-center gap-2"><span className="w-[58px] text-[11px] text-[#8f8681]">Model tier</span><Meter tone="model" label="Model tier lean" levels={BUILD_PACES.length} value={modelLean} onChange={(v) => applyLeans(v as BuildPace, effortLean)} disabled={busy} /></div>
                      <div className="flex items-center gap-2"><span className="w-[58px] text-[11px] text-[#8f8681]">Effort</span><Meter tone="effort" label="Effort lean" levels={BUILD_PACES.length} value={effortLean} onChange={(v) => applyLeans(modelLean, v as BuildPace)} disabled={busy} /></div>
                    </div>
                    <label className="flex items-center gap-2 text-[11px] text-[#b2a7a1]" title="Let a single role run on the other model family"><input type="checkbox" checked={crossFamily} onChange={(event) => setCrossFamily(event.target.checked)} />Cross-family per role</label>
                  </div>
                  {custom && <button type="button" onClick={() => applyPace(pace)} className="justify-self-start text-xs text-[#d7b6a4]">Reset to {BUILD_PACES[pace]}</button>}
                  <div className="grid gap-3 rounded-lg border border-[#393433] bg-[#161212] p-3.5">
                    <RoleRow label="Orchestrator" crossFamily={crossFamily} model={impl.orchestratorModel} effort={newBuildOrchestratorEffort(impl.orchestratorEffort)} onModel={(m) => changeImpl({ ...impl, orchestratorModel: m ?? impl.orchestratorModel })} onEffort={(e) => changeImpl({ ...impl, orchestratorEffort: e })} />
                    <RoleRow label="Subagents" crossFamily={crossFamily} offLabel="Solo, orchestrator codes" model={impl.subagentModel} effort={impl.subagentEffort} onModel={(m) => changeImpl({ ...impl, subagentModel: m })} onEffort={(e) => changeImpl({ ...impl, subagentEffort: e })} />
                    {referenceMode === 'web' && <RoleRow label="Research" crossFamily={crossFamily} offLabel="No fan-out" model={research.researchModel} effort={research.researchEffort} onModel={(m) => changeResearch({ ...research, researchModel: m })} onEffort={(e) => changeResearch({ ...research, researchEffort: e })} />}
                    <RoleRow label="Critic" crossFamily={crossFamily} model={critic.criticModel} effort={critic.criticEffort} onModel={(m) => changeCritic({ ...critic, criticModel: m ?? critic.criticModel })} onEffort={(e) => changeCritic({ ...critic, criticEffort: e })} />
                    <p className="text-[11px] leading-relaxed text-[#8f857f]">{describeCritic(critic.criticModel, impl.orchestratorModel)}</p>
                    {referenceMode !== 'skip' && <RoleRow label="Asset sculptors" crossFamily={crossFamily} offLabel="By hand, no sculptors" model={assets.assetModel} effort={assets.assetEffort} onModel={(m) => changeAssets({ ...assets, assetModel: m })} onEffort={(e) => changeAssets({ ...assets, assetEffort: e })} />}
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
        const label = kind === 'claude' ? 'Claude Code' : 'Codex'
        return <button type="button" key={kind} aria-label={`${label}: ${connected[kind] ? 'connected' : 'not connected'}. Open agent connections`} title="Open agent connections" onClick={() => setAgentsOpen(true)} aria-describedby={needsConnection ? 'build-connection-error' : undefined} className={`flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs ${needsConnection ? 'border-red-400 bg-red-950/30 text-red-200 ring-1 ring-red-400/30' : 'border-[#3b3534] bg-[#1b1717] text-[#cfc8c4]'}`}><span aria-hidden="true" className={`size-2 rounded-full ${connected[kind] ? 'bg-emerald-400' : 'bg-[#69615e]'}`} />{label}</button>
      })}</div>
      <Sheet open={agentsOpen} onOpenChange={setAgentsOpen}><SheetContent className="overflow-y-auto"><SheetHeader><SheetTitle>Agent connections</SheetTitle><SheetDescription>Sign in through the installed CLI. Your build draft stays here.</SheetDescription></SheetHeader><div className="px-4 pb-6"><AgentsView /></div></SheetContent></Sheet>
    </div>
  )
}
