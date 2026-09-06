import { useEffect, useRef, useState } from 'react'
import { ImageLightbox } from '@/components/ImageLightbox'
import type { ContextFolder } from '../../../shared/build-context'
import { Sheet, SheetClose, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet'
import {
  ArrowLeft,
  ArrowRight,
  Box,
  Check,
  ChevronDown,
  ChevronRight,
  CircleGauge,
  FileImage,
  FileText,
  FolderGit2,
  Gauge,
  KeyRound,
  Link2,
  Paperclip,
  Plus,
  Search,
  ShieldCheck,
  Sparkles,
  WandSparkles,
  X,
  Zap,
} from 'lucide-react'

/** Variant A is selected. Continue the quiet composer; B/C remain available for comparison. All actions and data are simulated. */

type Variant = 'A' | 'B' | 'C'
type Quality = 0 | 1 | 2
type ReferenceMode = 'web' | 'attachments' | 'skip'
type HarnessKind = 'claude' | 'codex'
type AuthMode = 'subscription' | 'api_key'
type ModelRole = 'Reference' | 'Implement' | '3D assets' | 'Critique'

interface ModelOverride {
  model: string
  effort: string
}

interface AttachmentSeed {
  id: string
  name: string
  detail: string
  kind: 'image' | 'document' | 'folder'
  file?: File
  folder?: ContextFolder
}

interface HarnessSeed {
  kind: HarnessKind
  label: string
  connected: boolean
  authMode: AuthMode | null
  account: string | null
}

interface PrototypeState {
  goal: string
  contextError?: string
  quality: Quality
  referenceMode: ReferenceMode
  sculpting: boolean
  maxRounds: string
  budget: string
  attachments: AttachmentSeed[]
  harnesses: HarnessSeed[]
  modelOverrides: Partial<Record<ModelRole, ModelOverride>>
}

interface ResolvedPlan {
  ready: boolean
  title: string
  duration: string
  rows: Array<{ role: ModelRole; assignment: string; automaticAssignment?: string; note: string }>
  notes: string[]
}

const VARIANTS: Array<{ key: Variant; name: string }> = [
  { key: 'A', name: 'Quiet composer' },
  { key: 'B', name: 'Guided steps' },
  { key: 'C', name: 'Plan first' },
]

const QUALITY_LABELS = ['Fast', 'Balanced', 'Best'] as const
const REFERENCE_LABELS: Record<ReferenceMode, string> = {
  web: 'Web + attachments',
  attachments: 'Attachments only',
  skip: 'Skip reference study',
}

const initialState: PrototypeState = {
  goal: 'Build a fast, readable 2D action roguelike inspired by Hades, with short runs, expressive combat feedback, and a warm mythic-noir visual style.',
  quality: 1,
  referenceMode: 'attachments',
  sculpting: false,
  maxRounds: '6',
  budget: '35',
  attachments: [],
  harnesses: [
    { kind: 'claude', label: 'Claude Code', connected: true, authMode: 'subscription', account: 'Claude Max · Account 1' },
    { kind: 'codex', label: 'Codex', connected: false, authMode: null, account: null },
  ],
  modelOverrides: {},
}

function updateState<K extends keyof PrototypeState>(
  setState: React.Dispatch<React.SetStateAction<PrototypeState>>,
  key: K,
  value: PrototypeState[K],
): void {
  setState((current) => ({ ...current, [key]: value }))
}

function resolvePlan(state: PrototypeState): ResolvedPlan {
  const claude = state.harnesses.find((harness) => harness.kind === 'claude' && harness.connected)
  const codex = state.harnesses.find((harness) => harness.kind === 'codex' && harness.connected)
  const primary = claude ?? codex
  if (!primary) {
    return {
      ready: false,
      title: 'Connect an agent to continue',
      duration: 'Waiting for authentication',
      rows: [],
      notes: ['A subscription or API-key-backed CLI profile is required. No secret is entered into the build form.'],
    }
  }

  const implementations = primary.kind === 'claude'
    ? [
        ['Sonnet 5 · medium', 'Solo implementation'],
        ['Opus 5 · high', 'Sonnet 5 subagents'],
        ['Opus 5 · max', 'Opus 5 subagents · high'],
      ]
    : [
        ['gpt-5.6-luna · medium', 'Solo implementation'],
        ['gpt-5.6-terra · high', 'Terra subagents · medium'],
        ['gpt-5.6-sol · max', 'Sol subagents · high'],
      ]
  const critic = codex
    ? (state.quality === 0 ? 'gpt-5.6-luna · medium' : state.quality === 1 ? 'gpt-5.6-terra · high' : 'gpt-5.6-sol · max')
    : primary.kind === 'claude'
      ? (state.quality === 0 ? 'Sonnet 5 · medium' : state.quality === 1 ? 'Opus 5 · high' : 'Opus 5 · max')
      : (state.quality === 0 ? 'gpt-5.6-luna · medium' : state.quality === 1 ? 'gpt-5.6-terra · high' : 'gpt-5.6-sol · max')
  const duration = state.quality === 0 ? '~20–40 min / round' : state.quality === 1 ? '~45–90 min / round' : '~1.5–3 hr / round'
  const rows: ResolvedPlan['rows'] = []
  if (state.referenceMode !== 'skip') {
    rows.push({
      role: 'Reference',
      assignment: implementations[state.quality][0],
      note: state.referenceMode === 'web' ? 'Builds and freezes the full evidence pack' : `Uses ${state.attachments.length} attached files; network research disabled`,
    })
  }
  rows.push({ role: 'Implement', assignment: implementations[state.quality][0], note: implementations[state.quality][1] })
  if (state.sculpting) rows.push({ role: '3D assets', assignment: state.quality === 2 ? 'Opus 5 · high' : 'Sonnet 5 · medium', note: 'img2threejs sculpting in bounded waves' })
  rows.push({
    role: 'Critique',
    assignment: critic,
    note: codex && primary.kind === 'claude' ? 'Independent cross-harness critic' : 'Same-harness critic; connect the other agent for fresh eyes',
  })
  const configuredRows = rows.map((row) => {
    const override = state.modelOverrides[row.role]
    return {
      ...row,
      automaticAssignment: row.assignment,
      assignment: override ? `${override.model} · ${override.effort}` : row.assignment,
      note: override ? `Custom override · ${row.note}` : row.note,
    }
  })
  return {
    ready: true,
    title: `${QUALITY_LABELS[state.quality]} plan · ${configuredRows.length} phases`,
    duration,
    rows: configuredRows,
    notes: [
      `${state.maxRounds || '—'} rounds maximum${state.budget ? ` · $${state.budget} equivalent API cost ceiling` : ''}`,
      state.referenceMode === 'skip' ? 'Critique uses the goal as its rubric; no AAA comparison pack.' : `Reference mode: ${REFERENCE_LABELS[state.referenceMode]}.`,
      state.sculpting ? 'Procedural 3D sculpting enabled.' : 'img2threejs disabled; no 3D asset phase will be queued.',
    ],
  }
}

function PrototypeSidebar(): React.JSX.Element {
  return (
    <aside className="flex h-screen w-[244px] shrink-0 flex-col border-r border-[#292526] bg-[#141112] max-md:hidden">
      <div className="px-4 pb-4 pt-6">
        <button type="button" className="flex w-full items-center gap-2 rounded-lg bg-white/[0.055] px-3 py-2.5 text-left text-sm font-medium text-[#eeeae7]">
          <Plus className="size-4" /> Attempt
        </button>
      </div>
      <div className="border-t border-[#2c2829] px-4 py-5">
        <p className="mb-3 text-xs font-medium text-[#77706d]">Recent builds</p>
        {[
          ['Neon dungeon racer', 'passed'],
          ['Mythic arena combat', 'round 4'],
          ['Cozy orbital builder', 'stopped'],
        ].map(([name, status]) => (
          <button key={name} type="button" className="mb-1 flex w-full items-center justify-between rounded-lg px-2 py-2 text-left text-xs text-[#8f8885] hover:bg-white/[0.035]">
            <span className="truncate">{name}</span><span className="ml-2 shrink-0 text-[9px] text-[#5f5957]">{status}</span>
          </button>
        ))}
      </div>
      <div className="mt-auto border-t border-[#2c2829] p-4">
        <div className="flex items-center gap-2 text-xs text-[#8f8885]"><Sparkles className="size-3.5" /> Agents</div>
      </div>
    </aside>
  )
}

function QualitySlider({ value, onChange, compact = false }: { value: Quality; onChange: (value: Quality) => void; compact?: boolean }): React.JSX.Element {
  return (
    <div className={compact ? '' : 'rounded-xl border border-[#393333] bg-[#171313] p-4'}>
      <div className="mb-2.5 flex items-center justify-between">
        <span className="flex items-center gap-2 text-xs font-medium text-[#c7c0bc]"><Gauge className="size-3.5 text-[#d8a993]" /> Build pace</span>
        <strong className="text-xs font-medium text-[#efc4b2]">{QUALITY_LABELS[value]}</strong>
      </div>
      <input
        aria-label="Speed to quality"
        type="range"
        min="0"
        max="2"
        step="1"
        value={value}
        onChange={(event) => onChange(Number(event.target.value) as Quality)}
        className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-[#49403d] accent-[#e8b7a1]"
      />
      <div className="mt-2 flex justify-between text-[10px] text-[#716a67]"><span>Faster</span><span>Balanced</span><span>Highest quality</span></div>
    </div>
  )
}

function QuietQualityControl({ value, onChange, disabled = false }: { value: Quality; onChange: (value: Quality) => void; disabled?: boolean }): React.JSX.Element {
  return (
    <label className={`flex items-center gap-2 text-[11px] transition-opacity ${disabled ? 'cursor-not-allowed opacity-35' : 'text-[#99918d]'}`} title={disabled ? 'Reset fine-tuned models to change build pace' : 'Build pace: faster to highest quality'}>
      <Gauge className="size-3.5 shrink-0 text-[#8f8783]" />
      <input
        aria-label="Speed to quality"
        disabled={disabled}
        type="range"
        min="0"
        max="2"
        step="1"
        value={value}
        onChange={(event) => onChange(Number(event.target.value) as Quality)}
        className="h-1 w-20 cursor-pointer appearance-none rounded-full bg-[#484341] accent-[#b9ada7] disabled:cursor-not-allowed"
      />
      <span className="w-[52px] text-[#aaa29e]">{QUALITY_LABELS[value]}</span>
    </label>
  )
}

function ModelConfiguration({ state, setState, plan }: VariantProps): React.JSX.Element {
  const connected = new Set(state.harnesses.filter((harness) => harness.connected).map((harness) => harness.kind))
  const modelChoices = [
    ...(connected.has('claude') ? ['Sonnet 5', 'Opus 5'] : []),
    ...(connected.has('codex') ? ['gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-5.6-sol'] : []),
  ]
  const overrideCount = Object.keys(state.modelOverrides).length
  const updateOverride = (role: ModelRole, model: string): void => {
    setState((current) => {
      const next = { ...current.modelOverrides }
      if (!model) delete next[role]
      else next[role] = { model, effort: next[role]?.effort ?? 'high' }
      return { ...current, modelOverrides: next }
    })
  }
  const updateEffort = (role: ModelRole, effort: string): void => {
    setState((current) => ({
      ...current,
      modelOverrides: {
        ...current.modelOverrides,
        [role]: { model: current.modelOverrides[role]?.model ?? modelChoices[0], effort },
      },
    }))
  }
  return (
    <div>
      <div className="mb-3 flex items-start justify-between gap-4">
        <div><p className="text-xs font-medium text-[#c8c1bd]">Fine-tune models</p><p className="mt-0.5 text-[10px] text-[#716a67]">Changing a phase locks the pace slider until these overrides are reset.</p></div>
        {overrideCount > 0 && <button type="button" onClick={() => updateState(setState, 'modelOverrides', {})} className="shrink-0 rounded-md border border-[#443c39] px-2 py-1 text-[10px] text-[#b8aaa4] hover:border-[#5a4f4a] hover:text-[#ddd3ce]">Reset to {QUALITY_LABELS[state.quality]}</button>}
      </div>
      <div className="overflow-hidden rounded-lg border border-[#363130]">
        {plan.rows.map((row) => {
          const override = state.modelOverrides[row.role]
          return (
            <div key={row.role} className="grid grid-cols-[76px_minmax(0,1fr)_100px] items-center gap-2 border-b border-[#302b2a] px-3 py-2.5 last:border-0 max-sm:grid-cols-[68px_1fr]">
              <span className="text-[9px] uppercase tracking-wide text-[#6d6562]">{row.role}</span>
              <select aria-label={`${row.role} model`} value={override?.model ?? ''} onChange={(event) => updateOverride(row.role, event.target.value)} className="h-8 min-w-0 rounded-md border border-[#3c3634] bg-[#151212] px-2 text-[11px] text-[#bcb4b0] outline-none">
                <option value="">Auto · {row.automaticAssignment ?? row.assignment}</option>
                {modelChoices.map((model) => <option key={model} value={model}>{model}</option>)}
              </select>
              {override ? <select aria-label={`${row.role} effort`} value={override.effort} onChange={(event) => updateEffort(row.role, event.target.value)} className="h-8 rounded-md border border-[#3c3634] bg-[#151212] px-2 text-[11px] text-[#bcb4b0] outline-none max-sm:col-start-2">
                {['low', 'medium', 'high', 'xhigh', 'max'].map((effort) => <option key={effort} value={effort}>{effort}</option>)}
              </select> : <span className="text-right text-[9px] text-[#625b58] max-sm:col-start-2 max-sm:text-left">from pace</span>}
            </div>
          )
        })}
      </div>
      {modelChoices.length === 0 && <p className="mt-2 text-[10px] text-amber-300/70">Connect an agent before choosing manual overrides.</p>}
    </div>
  )
}

async function addContextFiles(files: File[], setState: VariantProps['setState'], browserFolders = new Set<string>()): Promise<void> {
  const added: AttachmentSeed[] = []
  const errors: string[] = []
  for (const file of files.slice(0, 100)) {
    if (window.buildContext) {
      const result = await window.buildContext.droppedFolder(file)
      if (!result.ok) { errors.push(result.error); continue }
      if (result.value) {
        added.push({ id: result.value.id, name: result.value.name, detail: 'Folder', kind: 'folder', folder: result.value })
        continue
      }
    } else if (browserFolders.has(file.name)) {
      errors.push('Use the desktop prototype to attach folders and open them in Finder.')
      continue
    }
    added.push({
      id: crypto.randomUUID(), name: file.name, file,
      detail: file.size > 1_000_000 ? `${(file.size / 1_000_000).toFixed(1)} MB` : `${Math.max(1, Math.round(file.size / 1_000))} KB`,
      kind: file.type.startsWith('image/') ? 'image' : 'document',
    })
  }
  if (files.length > 100) errors.push('Add up to 100 items at a time.')
  setState((current) => ({ ...current, attachments: [...current.attachments, ...added.filter((item) => !current.attachments.some((existing) => existing.id === item.id))], contextError: errors.join(' ') || undefined }))
}

function AttachmentList({ state, setState, compact = false }: { state: PrototypeState; setState: VariantProps['setState']; compact?: boolean }): React.JSX.Element {
  const inputRef = useRef<HTMLInputElement | null>(null)
  const pickFolder = async (): Promise<void> => {
    if (!window.buildContext) { updateState(setState, 'contextError', 'Open the desktop prototype to attach folders and use Finder.'); return }
    const result = await window.buildContext.pickFolder()
    if (!result.ok) { updateState(setState, 'contextError', result.error); return }
    const folder = result.value
    if (folder) setState((current) => ({ ...current, contextError: undefined, attachments: current.attachments.some((item) => item.id === folder.id) ? current.attachments : [...current.attachments, { id: folder.id, name: folder.name, detail: 'Folder', kind: 'folder', folder }] }))
  }
  const openFolder = async (folder: ContextFolder): Promise<void> => {
    const result = await window.buildContext?.openFolder(folder.id)
    updateState(setState, 'contextError', result?.ok ? undefined : result?.error ?? 'Open the desktop prototype to use Finder.')
  }
  return (
    <div>
      <input ref={inputRef} type="file" multiple className="hidden" onChange={(event) => {
        const files = Array.from(event.target.files ?? [])
        event.target.value = ''
        void addContextFiles(files, setState)
      }} />
      <div className={`flex flex-wrap ${compact ? 'gap-1.5' : 'gap-2'}`}>
        {state.attachments.map((attachment) => {
          const Icon = attachment.kind === 'image' ? FileImage : attachment.kind === 'folder' ? FolderGit2 : FileText
          const label = <><Icon className="size-3.5 shrink-0 text-[#b98f7d]" /><span className="max-w-[190px] truncate">{attachment.name}</span><span className="text-[9px] text-[#8b817c]">{attachment.detail}</span></>
          const buttonClass = 'inline-flex min-w-0 items-center gap-1.5 rounded px-1 py-1 hover:bg-white/5 focus-visible:outline focus-visible:outline-2'
          return (
            <span key={attachment.id} className="inline-flex max-w-full items-center gap-1 rounded-lg border border-[#423b39] bg-[#221d1c] py-0.5 pl-1 pr-1 text-[11px] text-[#bcb4b0]">
              {attachment.kind === 'image' && attachment.file ? <ImageLightbox file={attachment.file}><button type="button" aria-label={`Preview ${attachment.name}`} className={buttonClass}>{label}</button></ImageLightbox>
                : attachment.folder ? <button type="button" aria-label={`Open ${attachment.name} in Finder`} title={attachment.folder.path} onClick={() => void openFolder(attachment.folder!)} className={buttonClass}>{label}</button>
                  : <span className="inline-flex min-w-0 items-center gap-1.5 px-1 py-1">{label}</span>}
              <button type="button" aria-label={`Remove ${attachment.name}`} onClick={() => setState((current) => ({ ...current, attachments: current.attachments.filter((item) => item.id !== attachment.id) }))} className="grid size-5 place-items-center rounded text-[#8b817c] hover:bg-white/5 hover:text-[#d8d1ce]"><X className="size-3" /></button>
            </span>
          )
        })}
        <button type="button" onClick={() => inputRef.current?.click()} className="inline-flex items-center gap-1.5 rounded-lg border border-dashed border-[#49413e] px-2.5 py-1.5 text-[11px] text-[#8e8581] hover:border-[#655a56] hover:text-[#ccc4c0]"><Paperclip className="size-3.5" /> Attach files</button>
        <button type="button" onClick={() => void pickFolder()} className="inline-flex items-center gap-1.5 rounded-lg border border-dashed border-[#49413e] px-2.5 py-1.5 text-[11px] text-[#8e8581] hover:border-[#655a56] hover:text-[#ccc4c0]"><FolderGit2 className="size-3.5" /> Add folder</button>
      </div>
      {state.contextError && <p role="alert" className="mt-2 text-xs text-[#dfac96]">{state.contextError}</p>}
    </div>
  )
}

function ReferencePicker({ value, onChange, vertical = false }: { value: ReferenceMode; onChange: (value: ReferenceMode) => void; vertical?: boolean }): React.JSX.Element {
  const choices: Array<{ value: ReferenceMode; label: string; detail: string }> = [
    { value: 'web', label: 'Web + files', detail: 'Build the full sourced reference pack' },
    { value: 'attachments', label: 'Files only', detail: 'No web research; use what I supplied' },
    { value: 'skip', label: 'Skip', detail: 'Judge against the goal instead' },
  ]
  return (
    <div className={vertical ? 'grid gap-2' : 'grid grid-cols-3 gap-1 rounded-lg bg-[#151111] p-1 max-sm:grid-cols-1'}>
      {choices.map((choice) => (
        <button
          type="button"
          key={choice.value}
          onClick={() => onChange(choice.value)}
          className={`${vertical ? 'flex items-start gap-3 border px-3 py-3 text-left' : 'px-2 py-2 text-center'} rounded-lg transition-colors ${value === choice.value ? 'border-[#5b4d47] bg-[#332925] text-[#f0e9e5]' : vertical ? 'border-[#342f2e] text-[#8d8581] hover:border-[#49413e]' : 'text-[#766f6c] hover:text-[#bdb5b1]'}`}
        >
          {vertical && <span className={`mt-0.5 grid size-4 shrink-0 place-items-center rounded-full border ${value === choice.value ? 'border-[#e3b29d] bg-[#e3b29d] text-[#211815]' : 'border-[#625a57]'}`}>{value === choice.value && <Check className="size-3" />}</span>}
          <span><strong className="block text-xs font-medium">{choice.label}</strong>{vertical && <span className="mt-0.5 block text-[10px] leading-relaxed text-[#716966]">{choice.detail}</span>}</span>
        </button>
      ))}
    </div>
  )
}

function SculptingToggle({ checked, onChange, detailed = false }: { checked: boolean; onChange: (value: boolean) => void; detailed?: boolean }): React.JSX.Element {
  return (
    <button type="button" role="switch" aria-checked={checked} onClick={() => onChange(!checked)} className={`flex w-full items-center ${detailed ? 'rounded-xl border border-[#393333] bg-[#171313] p-3.5' : ''}`}>
      <span className="grid size-8 place-items-center rounded-lg bg-[#2b2421] text-[#bc927f]"><Box className="size-4" /></span>
      <span className="ml-2.5 min-w-0 flex-1 text-left"><strong className="block text-xs font-medium text-[#c7c0bc]">3D model sculpting</strong>{detailed && <span className="mt-0.5 block text-[10px] text-[#716966]">Use img2threejs for cast assets</span>}</span>
      <span className={`relative h-5 w-9 rounded-full transition-colors ${checked ? 'bg-[#d9a790]' : 'bg-[#4b4542]'}`}><span className={`absolute top-0.5 size-4 rounded-full bg-white transition-transform ${checked ? 'translate-x-[18px]' : 'translate-x-0.5'}`} /></span>
    </button>
  )
}

function Harnesses({ state, setState, detailed = false }: { state: PrototypeState; setState: React.Dispatch<React.SetStateAction<PrototypeState>>; detailed?: boolean }): React.JSX.Element {
  const connect = (kind: HarnessKind, authMode: AuthMode): void => setState((current) => ({
    ...current,
    harnesses: current.harnesses.map((harness) => harness.kind === kind ? { ...harness, connected: true, authMode, account: authMode === 'subscription' ? `${kind === 'claude' ? 'Claude Max' : 'ChatGPT Plus'} · Account 1` : 'API key · Personal' } : harness),
  }))
  const disconnect = (kind: HarnessKind): void => setState((current) => ({
    ...current,
    harnesses: current.harnesses.map((harness) => harness.kind === kind ? { ...harness, connected: false, authMode: null, account: null } : harness),
  }))
  return (
    <div className={detailed ? 'grid gap-2' : 'flex flex-wrap gap-2'}>
      {state.harnesses.map((harness) => (
        <div key={harness.kind} className={`${detailed ? 'grid grid-cols-[1fr_auto] items-center gap-3 rounded-xl border border-[#393333] bg-[#171313] px-3.5 py-3' : 'flex items-center gap-2 rounded-full border border-[#3b3534] bg-[#1b1717] px-3 py-1.5'} text-xs`}>
          <div className="flex min-w-0 items-center gap-2.5">
            <span className={`size-2 rounded-full ${harness.connected ? 'bg-emerald-400' : 'bg-[#69615e]'}`} />
            <span className="min-w-0"><strong className="block truncate font-medium text-[#cfc8c4]">{harness.label}</strong>{detailed && <span className="mt-0.5 block truncate text-[10px] text-[#716966]">{harness.connected ? harness.account : 'Not connected'}</span>}</span>
          </div>
          {harness.connected ? (
            <button type="button" onClick={() => disconnect(harness.kind)} className="text-[10px] text-[#746c69] hover:text-[#bbb2ae]">Disconnect</button>
          ) : detailed ? (
            <div className="flex gap-1.5">
              <button type="button" onClick={() => connect(harness.kind, 'subscription')} className="rounded-md bg-[#ebe3de] px-2.5 py-1.5 text-[10px] font-medium text-[#211b19]">Subscription</button>
              <button type="button" onClick={() => connect(harness.kind, 'api_key')} className="rounded-md border border-[#4a4240] px-2.5 py-1.5 text-[10px] text-[#b6ada9]">API key</button>
            </div>
          ) : (
            <button type="button" onClick={() => connect(harness.kind, 'subscription')} className="font-medium text-[#d8a993] hover:text-[#efc4b2]">Connect</button>
          )}
        </div>
      ))}
    </div>
  )
}

function PlanSummary({ plan, expanded = false }: { plan: ResolvedPlan; expanded?: boolean }): React.JSX.Element {
  return (
    <div className={`${expanded ? 'rounded-2xl border border-[#403937] bg-[#181414] p-5' : ''}`}>
      <div className="flex items-start justify-between gap-4">
        <div><p className="text-sm font-semibold text-[#e8e1dd]">{plan.title}</p><p className="mt-1 text-[11px] text-[#77706d]">{plan.duration}</p></div>
        <span className={`rounded-full px-2 py-1 text-[9px] font-semibold uppercase tracking-wide ${plan.ready ? 'bg-emerald-950/60 text-emerald-300' : 'bg-amber-950/60 text-amber-300'}`}>{plan.ready ? 'Ready' : 'Action needed'}</span>
      </div>
      {plan.rows.length > 0 && <div className="mt-4 grid gap-2.5">{plan.rows.map((row, index) => (
        <div key={`${row.role}-${index}`} className="grid grid-cols-[72px_1fr] gap-3 border-t border-[#2e2928] pt-2.5 first:border-0 first:pt-0">
          <span className="text-[10px] uppercase tracking-wide text-[#685f5c]">{row.role}</span>
          <span><strong className="block text-xs font-medium text-[#c8c0bc]">{row.assignment}</strong><span className="mt-0.5 block text-[10px] leading-relaxed text-[#756d69]">{row.note}</span></span>
        </div>
      ))}</div>}
      {expanded && <div className="mt-4 rounded-lg bg-[#211c1b] p-3">{plan.notes.map((note) => <p key={note} className="mb-1 text-[10px] leading-relaxed text-[#817875] last:mb-0">• {note}</p>)}</div>}
    </div>
  )
}

function CreateButton({ plan, compact = false, ...props }: { plan: ResolvedPlan; compact?: boolean } & React.ComponentProps<'button'>): React.JSX.Element {
  return (
    <button {...props} type="button" disabled={props.disabled ?? !plan.ready} className={`inline-flex items-center justify-center gap-2 bg-[#eee8e4] font-semibold text-[#201917] shadow-lg shadow-black/20 hover:bg-white disabled:bg-[#393332] disabled:text-[#77706d] ${compact ? 'h-9 rounded-md px-4 text-xs' : 'h-11 rounded-lg px-5 text-sm'}`}>
      {!compact && (plan.ready ? <WandSparkles className="size-4" /> : <KeyRound className="size-4" />)}{plan.ready ? 'Create build' : 'Connect an agent'}
    </button>
  )
}

function VariantA({ state, setState, plan }: VariantProps): React.JSX.Element {
  const [dragging, setDragging] = useState(false)
  const dragDepth = useRef(0)
  const openModelConfig = new URLSearchParams(window.location.search).get('config') === '1'
  const [showOptions, setShowOptions] = useState(openModelConfig)
  const [showModelConfig, setShowModelConfig] = useState(openModelConfig)
  const overrideCount = Object.keys(state.modelOverrides).length
  const missingGoal = !state.goal.trim()
  const missingFiles = state.referenceMode === 'attachments' && state.attachments.length === 0
  const incomplete = missingGoal ? 'Describe the game to continue.' : missingFiles ? 'Attach reference files or choose another reference mode.' : null
  return (
    <main className="min-w-0 flex-1 overflow-y-auto bg-[#100d0e]">
      <div className="mx-auto flex min-h-screen w-[min(880px,calc(100%-40px))] flex-col justify-center py-14">
        <p className="mb-3 text-[11px] text-[#6f6865]">New build</p>
        <div
          onDragEnter={(event) => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); dragDepth.current += 1; setDragging(true) } }}
          onDragOver={(event) => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy' } }}
          onDragLeave={(event) => { event.preventDefault(); dragDepth.current = Math.max(0, dragDepth.current - 1); if (dragDepth.current === 0) setDragging(false) }}
          onDrop={(event) => {
            event.preventDefault(); dragDepth.current = 0; setDragging(false)
            const folders = new Set(Array.from(event.dataTransfer.items).filter((item) => item.webkitGetAsEntry?.()?.isDirectory).map((item) => item.getAsFile()?.name ?? ''))
            void addContextFiles(Array.from(event.dataTransfer.files), setState, folders)
          }}
          className={`relative overflow-hidden rounded-xl border bg-[#1d1a19] shadow-2xl shadow-black/20 ${dragging ? 'border-[#d9aa93] ring-2 ring-[#d9aa93]/30' : 'border-[#3b3735]'}`}
        >
          {dragging && <div className="pointer-events-none absolute inset-0 z-20 grid place-items-center bg-[#211a17]/95 text-sm text-[#efd2c3]">Drop files or folders to add to context</div>}
          <div className="flex items-center gap-2 border-b border-[#34302f] px-4 py-3 text-xs text-[#aaa29e]"><FolderGit2 className="size-3.5 text-[#77706d]" /><span className="font-medium">Gauntlet Games</span><ChevronDown className="ml-auto size-3.5 text-[#736c69]" /></div>
          <textarea aria-label="Game description" value={state.goal} onChange={(event) => updateState(setState, 'goal', event.target.value)} rows={7} className="min-h-[220px] w-full resize-y bg-transparent px-5 py-5 text-[14px] leading-relaxed text-[#e4dfdc] outline-none placeholder:text-[#625b58]" placeholder="Describe the game you want to build…" />
          <div className="px-4 pb-3"><AttachmentList state={state} setState={setState} compact /></div>
          <div className="border-t border-[#34302f] px-4 py-3">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
              <QuietQualityControl value={state.quality} onChange={(value) => updateState(setState, 'quality', value)} disabled={overrideCount > 0} />
              <button type="button" aria-expanded={showOptions} onClick={() => setShowOptions((current) => !current)} className={`flex items-center gap-1 text-[11px] hover:text-[#bbb3af] ${overrideCount > 0 ? 'text-[#aa8d81]' : 'text-[#88817d]'}`}>Build options{overrideCount > 0 ? ` · ${overrideCount} custom` : ''}<ChevronDown className={`size-3 transition-transform ${showOptions ? 'rotate-180' : ''}`} /></button>
              <div className="ml-auto">
                <Sheet>
                  <SheetTrigger asChild><CreateButton plan={plan} compact disabled={!plan.ready || !!incomplete} /></SheetTrigger>
                  <SheetContent className="overflow-y-auto">
                    <SheetHeader>
                      <SheetTitle>Build preview</SheetTitle>
                      <SheetDescription>Simulated creation · no agents have started and nothing has been saved.</SheetDescription>
                    </SheetHeader>
                    <div className="grid gap-5 px-6 pb-6">
                      <p className="whitespace-pre-wrap text-sm leading-relaxed text-[#d5ceca]">{state.goal}</p>
                      <PlanSummary plan={plan} expanded />
                      <div className="text-xs leading-relaxed text-[#a69c97]">
                        <p className="mb-2 font-medium">Attached files · {state.attachments.length}</p>
                        {state.attachments.map((file) => <p key={file.id} className="break-all">{file.name} · {file.detail}</p>)}
                        {state.attachments.length === 0 && <p>No files attached.</p>}
                      </div>
                      <SheetClose className="h-9 rounded-md border border-[#49413e] text-xs text-[#d5ceca] hover:bg-white/5">Back to editing</SheetClose>
                    </div>
                  </SheetContent>
                </Sheet>
              </div>
            </div>
            {incomplete && <p role="status" className="mt-3 text-[11px] text-[#c9a493]">{incomplete}</p>}
            {showOptions && <div className="mt-3 border-t border-[#302b2a] pt-3">
              <div className="grid grid-cols-2 gap-4 max-sm:grid-cols-1">
                <div><p className="mb-2 text-[10px] uppercase tracking-wide text-[#67605d]">Reference study</p><ReferencePicker value={state.referenceMode} onChange={(value) => updateState(setState, 'referenceMode', value)} /></div>
                <div className="grid gap-3"><SculptingToggle checked={state.sculpting} onChange={(value) => updateState(setState, 'sculpting', value)} /><div className="grid grid-cols-2 gap-2"><input aria-label="Maximum rounds" value={state.maxRounds} onChange={(event) => updateState(setState, 'maxRounds', event.target.value)} className="h-9 rounded-lg border border-[#3a3432] bg-[#120f0f] px-3 text-xs outline-none" placeholder="Rounds" /><input aria-label="Budget" value={state.budget} onChange={(event) => updateState(setState, 'budget', event.target.value)} className="h-9 rounded-lg border border-[#3a3432] bg-[#120f0f] px-3 text-xs outline-none" placeholder="Budget $" /></div></div>
              </div>
              <div className="mt-3 border-t border-[#302b2a] pt-3">
                <button type="button" aria-expanded={showModelConfig} onClick={() => setShowModelConfig((current) => !current)} className="flex w-full items-center gap-2 text-left text-[11px] text-[#918985] hover:text-[#c4bbb7]"><Sparkles className="size-3" /><span>Fine-tune model configuration</span><span className="text-[9px] text-[#665f5c]">{overrideCount > 0 ? `${overrideCount} custom` : `From ${QUALITY_LABELS[state.quality]}`}</span><ChevronDown className={`ml-auto size-3 transition-transform ${showModelConfig ? 'rotate-180' : ''}`} /></button>
                {showModelConfig && <div className="mt-3"><ModelConfiguration state={state} setState={setState} plan={plan} /></div>}
              </div>
            </div>}
          </div>
        </div>
        <div className="mt-3 flex items-center justify-between gap-4 max-sm:items-end">
          <Harnesses state={state} setState={setState} />
          <p className="text-[10px] text-[#5f5956]">Prototype only</p>
        </div>
      </div>
    </main>
  )
}

function StepHeading({ number, title, detail, complete }: { number: string; title: string; detail: string; complete?: boolean }): React.JSX.Element {
  return (
    <div className="mb-4 flex items-start gap-3">
      <span className={`grid size-7 shrink-0 place-items-center rounded-full border text-[11px] font-semibold ${complete ? 'border-emerald-700/50 bg-emerald-950/30 text-emerald-300' : 'border-[#4b4340] text-[#a79d98]'}`}>{complete ? <Check className="size-3.5" /> : number}</span>
      <span><strong className="block text-sm font-semibold text-[#ddd6d2]">{title}</strong><span className="mt-0.5 block text-[11px] text-[#746c68]">{detail}</span></span>
    </div>
  )
}

function VariantB({ state, setState, plan }: VariantProps): React.JSX.Element {
  return (
    <main className="min-w-0 flex-1 overflow-y-auto bg-[#100d0e]">
      <div className="mx-auto w-[min(1060px,calc(100%-40px))] py-10">
        <div className="mb-8 flex items-end justify-between gap-4"><div><p className="mb-1 text-xs text-[#786f6b]">New build</p><h1 className="text-2xl font-semibold tracking-tight">Set up your game</h1></div><span className="rounded-full border border-[#3b3533] px-3 py-1.5 text-[10px] text-[#756d69]">Nothing launches until you confirm</span></div>
        <div className="grid grid-cols-[minmax(0,1fr)_340px] items-start gap-7 max-lg:grid-cols-1">
          <div className="grid gap-4">
            <section className="rounded-2xl border border-[#393433] bg-[#1b1717] p-5">
              <StepHeading number="1" title="Describe the game" detail="The goal is preserved exactly in every phase." complete={state.goal.trim().length > 0} />
              <textarea value={state.goal} onChange={(event) => updateState(setState, 'goal', event.target.value)} rows={5} className="w-full resize-y rounded-xl border border-[#3b3533] bg-[#120f0f] px-4 py-3 text-sm leading-relaxed outline-none focus:border-[#5e534f]" />
            </section>
            <section className="rounded-2xl border border-[#393433] bg-[#1b1717] p-5">
              <StepHeading number="2" title="Set the reference source" detail="Choose what the agents may use as evidence." complete={state.referenceMode === 'skip' || state.attachments.length > 0} />
              <ReferencePicker value={state.referenceMode} onChange={(value) => updateState(setState, 'referenceMode', value)} vertical />
              <div className="mt-3"><AttachmentList state={state} setState={setState} /></div>
            </section>
            <section className="rounded-2xl border border-[#393433] bg-[#1b1717] p-5">
              <StepHeading number="3" title="Choose pace and tools" detail="High-level choices become a reproducible agent plan." complete />
              <QualitySlider value={state.quality} onChange={(value) => updateState(setState, 'quality', value)} />
              <div className="mt-3 grid grid-cols-2 gap-3 max-sm:grid-cols-1"><SculptingToggle checked={state.sculpting} onChange={(value) => updateState(setState, 'sculpting', value)} detailed /><div className="grid grid-cols-2 gap-2 rounded-xl border border-[#393333] bg-[#171313] p-3.5"><label className="text-[10px] text-[#746c68]">Rounds<input value={state.maxRounds} onChange={(event) => updateState(setState, 'maxRounds', event.target.value)} className="mt-1 h-8 w-full rounded-md border border-[#3d3634] bg-[#100d0e] px-2 text-xs text-[#ddd5d1] outline-none" /></label><label className="text-[10px] text-[#746c68]">Budget $<input value={state.budget} onChange={(event) => updateState(setState, 'budget', event.target.value)} className="mt-1 h-8 w-full rounded-md border border-[#3d3634] bg-[#100d0e] px-2 text-xs text-[#ddd5d1] outline-none" /></label></div></div>
            </section>
            <section className="rounded-2xl border border-[#393433] bg-[#1b1717] p-5">
              <StepHeading number="4" title="Check agent access" detail="The final plan adapts to the CLIs that are connected." complete={plan.ready} />
              <Harnesses state={state} setState={setState} detailed />
            </section>
          </div>
          <aside className="sticky top-7 rounded-2xl border border-[#423a37] bg-[#201b1a] p-5 shadow-xl shadow-black/20">
            <div className="mb-4 flex items-center gap-2 text-xs font-medium text-[#aaa19d]"><ShieldCheck className="size-4 text-[#d5a38d]" /> Review before launch</div>
            <PlanSummary plan={plan} expanded />
            <div className="mt-5 grid"><CreateButton plan={plan} /></div>
            <p className="mt-3 text-center text-[9px] text-[#625b58]">Prototype only · actions are simulated</p>
          </aside>
        </div>
      </div>
    </main>
  )
}

function ControlRow({ icon: Icon, title, detail, children }: { icon: typeof Search; title: string; detail: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="grid grid-cols-[34px_minmax(120px,1fr)_minmax(240px,1.5fr)] items-center gap-3 border-b border-[#302b2a] px-4 py-3.5 last:border-0 max-lg:grid-cols-[34px_1fr]">
      <span className="grid size-8 place-items-center rounded-lg bg-[#2a2321] text-[#bb8f7c]"><Icon className="size-4" /></span>
      <span><strong className="block text-xs font-medium text-[#cfc7c3]">{title}</strong><span className="mt-0.5 block text-[10px] text-[#706865]">{detail}</span></span>
      <div className="max-lg:col-span-2 max-lg:pl-[46px]">{children}</div>
    </div>
  )
}

function VariantC({ state, setState, plan }: VariantProps): React.JSX.Element {
  return (
    <main className="min-w-0 flex-1 overflow-y-auto bg-[#0e0b0c]">
      <header className="sticky top-0 z-10 flex items-center justify-between border-b border-[#2c2727] bg-[#0e0b0c]/95 px-7 py-4 backdrop-blur">
        <div><p className="text-[10px] uppercase tracking-[0.16em] text-[#655e5b]">Build planner</p><h1 className="mt-0.5 text-lg font-semibold">See the plan before you launch</h1></div>
        <div className="flex items-center gap-3"><span className="hidden text-[10px] text-[#6c6461] sm:block">Resolved from intent + connected agents</span><CreateButton plan={plan} /></div>
      </header>
      <div className="grid min-h-[calc(100vh-78px)] grid-cols-[minmax(400px,0.95fr)_minmax(420px,1.05fr)] max-lg:grid-cols-1">
        <section className="border-r border-[#2c2727] px-7 py-7 max-lg:border-b max-lg:border-r-0">
          <div className="mb-5 flex items-center gap-2 text-xs text-[#8c837f]"><FolderGit2 className="size-3.5" /> Gauntlet Games <ChevronRight className="size-3" /> New project</div>
          <textarea value={state.goal} onChange={(event) => updateState(setState, 'goal', event.target.value)} rows={7} className="w-full resize-y rounded-xl border border-[#3b3533] bg-[#171313] px-4 py-4 text-sm leading-relaxed outline-none focus:border-[#5e534f]" />
          <div className="mt-3"><AttachmentList state={state} setState={setState} /></div>
          <div className="mt-7 overflow-hidden rounded-xl border border-[#393332] bg-[#171313]">
            <ControlRow icon={CircleGauge} title="Quality target" detail="Changes models and delegation"><QualitySlider value={state.quality} onChange={(value) => updateState(setState, 'quality', value)} compact /></ControlRow>
            <ControlRow icon={Search} title="Reference study" detail="Controls evidence gathering"><ReferencePicker value={state.referenceMode} onChange={(value) => updateState(setState, 'referenceMode', value)} /></ControlRow>
            <ControlRow icon={Box} title="Asset pipeline" detail="Keep 3D sculpting explicit"><SculptingToggle checked={state.sculpting} onChange={(value) => updateState(setState, 'sculpting', value)} /></ControlRow>
            <ControlRow icon={Zap} title="Guardrails" detail="Hard limits for this build"><div className="grid grid-cols-2 gap-2"><label className="text-[10px] text-[#746c68]">Rounds<input value={state.maxRounds} onChange={(event) => updateState(setState, 'maxRounds', event.target.value)} className="mt-1 h-8 w-full rounded-md border border-[#3d3634] bg-[#100d0e] px-2 text-xs outline-none" /></label><label className="text-[10px] text-[#746c68]">Budget $<input value={state.budget} onChange={(event) => updateState(setState, 'budget', event.target.value)} className="mt-1 h-8 w-full rounded-md border border-[#3d3634] bg-[#100d0e] px-2 text-xs outline-none" /></label></div></ControlRow>
          </div>
          <div className="mt-6"><p className="mb-2 text-[10px] uppercase tracking-wide text-[#625a57]">Agent access</p><Harnesses state={state} setState={setState} detailed /></div>
        </section>
        <section className="bg-[radial-gradient(circle_at_50%_0%,rgba(137,83,62,0.13),transparent_42%)] px-8 py-8">
          <div className="mx-auto max-w-[560px]">
            <div className="mb-6 flex items-center justify-between"><div className="flex items-center gap-2 text-sm font-semibold"><Link2 className="size-4 text-[#cf9d87]" /> Resolved execution</div><span className="font-mono text-[9px] text-[#665e5b]">PLAN PREVIEW · V1</span></div>
            <PlanSummary plan={plan} expanded />
            <div className="mt-5 grid gap-2">
              {plan.rows.map((row, index) => (
                <div key={`${row.role}-flow`} className="flex items-stretch gap-3">
                  <div className="flex w-8 flex-col items-center"><span className="grid size-7 place-items-center rounded-full border border-[#584a44] bg-[#2b211e] text-[10px] font-semibold text-[#dbac98]">{index + 1}</span>{index < plan.rows.length - 1 && <span className="my-1 w-px flex-1 bg-[#3d3431]" />}</div>
                  <div className="mb-2 flex-1 rounded-xl border border-[#393230] bg-[#181414]/90 p-4"><div className="flex items-center justify-between"><strong className="text-xs font-semibold text-[#d7d0cc]">{row.role}</strong><span className="text-[9px] uppercase tracking-wide text-[#675f5c]">phase {index + 1}</span></div><p className="mt-2 text-xs text-[#a49b97]">{row.assignment}</p><p className="mt-1 text-[10px] leading-relaxed text-[#716966]">{row.note}</p></div>
                </div>
              ))}
            </div>
            <div className="mt-5 flex items-start gap-2 rounded-xl border border-[#443a37] bg-[#1b1615] p-4 text-[10px] leading-relaxed text-[#7e7470]"><ShieldCheck className="mt-0.5 size-3.5 shrink-0 text-[#b98b78]" />The exact model, effort, harness, authentication mode, prompt hash, and phase events remain visible in the build log after launch.</div>
          </div>
        </section>
      </div>
    </main>
  )
}

interface VariantProps {
  state: PrototypeState
  setState: React.Dispatch<React.SetStateAction<PrototypeState>>
  plan: ResolvedPlan
}

function PrototypeSwitcher({ variant, onChange }: { variant: Variant; onChange: (variant: Variant) => void }): React.JSX.Element | null {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const target = event.target
      if (target instanceof HTMLElement && (target.closest('input, textarea, select, button, [role=dialog]') || target.isContentEditable)) return
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
      const index = VARIANTS.findIndex((item) => item.key === variant)
      const delta = event.key === 'ArrowLeft' ? -1 : 1
      onChange(VARIANTS[(index + delta + VARIANTS.length) % VARIANTS.length].key)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [variant, onChange])
  if (!import.meta.env.DEV) return null
  const index = VARIANTS.findIndex((item) => item.key === variant)
  const move = (delta: number): void => onChange(VARIANTS[(index + delta + VARIANTS.length) % VARIANTS.length].key)
  return (
    <div className="fixed bottom-5 left-1/2 z-50 flex -translate-x-1/2 items-center gap-1 rounded-full border border-white/15 bg-[#eee8e4] p-1 text-[#211b19] shadow-2xl shadow-black/50">
      <button type="button" aria-label="Previous prototype variant" onClick={() => move(-1)} className="grid size-8 place-items-center rounded-full hover:bg-black/5"><ArrowLeft className="size-4" /></button>
      <span className="min-w-[156px] px-2 text-center text-[11px] font-semibold">{variant} — {VARIANTS[index].name}{variant === 'A' ? ' · Selected' : ''}</span>
      <button type="button" aria-label="Next prototype variant" onClick={() => move(1)} className="grid size-8 place-items-center rounded-full hover:bg-black/5"><ArrowRight className="size-4" /></button>
    </div>
  )
}

export function BuildFormPrototype(): React.JSX.Element {
  const searchParams = new URLSearchParams(window.location.search)
  const initialVariant = searchParams.get('variant')
  const [variant, setVariant] = useState<Variant>(initialVariant === 'B' || initialVariant === 'C' ? initialVariant : 'A')
  const [state, setState] = useState<PrototypeState>(() => ({
    ...initialState,
    modelOverrides: searchParams.get('custom') === '1' ? { Implement: { model: 'Opus 5', effort: 'max' } } : {},
  }))
  const plan = resolvePlan(state)
  const chooseVariant = (next: Variant): void => {
    const url = new URL(window.location.href)
    url.searchParams.set('prototype', 'build-form')
    url.searchParams.set('variant', next)
    window.history.replaceState({}, '', url)
    setVariant(next)
  }
  return (
    <div className="flex h-screen overflow-hidden bg-[#100d0e]">
      <PrototypeSidebar />
      {variant === 'A' && <VariantA state={state} setState={setState} plan={plan} />}
      {variant === 'B' && <VariantB state={state} setState={setState} plan={plan} />}
      {variant === 'C' && <VariantC state={state} setState={setState} plan={plan} />}
      <PrototypeSwitcher variant={variant} onChange={chooseVariant} />
    </div>
  )
}
