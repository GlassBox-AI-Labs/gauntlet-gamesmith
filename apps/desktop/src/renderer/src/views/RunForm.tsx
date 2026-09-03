import { Check, ChevronDown, FolderGit2, FolderPlus, LoaderCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import {
  AGENT_EFFORTS,
  AGENT_MODEL_CHOICES,
  type AssetFields,
  describeCritic,
  modelLabel,
  orchestratorEfforts,
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
              <FolderPlus className="size-4" /> Add project
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

export interface RunFormProps {
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
  return (
    <Card className="gap-0 overflow-visible border-[#393433] bg-[#1d1919] p-0 shadow-2xl shadow-black/20">
      <div className="border-b border-[#393433] p-3">
        <ProjectChooser
          value={workspaceDir}
          projects={projects}
          open={projectOpen}
          onOpenChange={onProjectOpenChange}
          onChange={onWorkspaceChange}
          onAddProject={onAddProject}
        />
      </div>
      <textarea
        value={prompt}
        onChange={(event) => onPromptChange(event.target.value)}
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
            onValueChange={(value) => onImplChange({
              ...impl,
              orchestratorModel: value,
              // ultracode and ultra belong to different CLIs, so a switch
              // between harnesses must not carry the old level across.
              orchestratorEffort: orchestratorEfforts(value).includes(impl.orchestratorEffort) ? impl.orchestratorEffort : 'high',
            })}
          >
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              {AGENT_MODEL_CHOICES.map((model) => <SelectItem key={model.id} value={model.id}>{model.label}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={impl.orchestratorEffort} onValueChange={(value) => onImplChange({ ...impl, orchestratorEffort: value })}>
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
            onValueChange={(value) => onImplChange({ ...impl, subagentModel: value === SOLO_SUBAGENT ? null : value })}
          >
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              {AGENT_MODEL_CHOICES.map((model) => <SelectItem key={model.id} value={model.id}>{model.label}</SelectItem>)}
              <SelectItem value={SOLO_SUBAGENT}>none (solo)</SelectItem>
            </SelectContent>
          </Select>
          <Select
            value={impl.subagentEffort}
            onValueChange={(value) => onImplChange({ ...impl, subagentEffort: value })}
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
            onValueChange={(value) => onResearchChange({ ...research, researchModel: value === SOLO_SUBAGENT ? null : value })}
          >
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              {AGENT_MODEL_CHOICES.map((model) => <SelectItem key={model.id} value={model.id}>{model.label}</SelectItem>)}
              <SelectItem value={SOLO_SUBAGENT}>none (no fan-out)</SelectItem>
            </SelectContent>
          </Select>
          <Select
            value={research.researchEffort}
            onValueChange={(value) => onResearchChange({ ...research, researchEffort: value })}
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
          <Select value={critic.criticModel} onValueChange={(value) => onCriticChange({ ...critic, criticModel: value })}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              {AGENT_MODEL_CHOICES.map((model) => <SelectItem key={model.id} value={model.id}>{model.label}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={critic.criticEffort} onValueChange={(value) => onCriticChange({ ...critic, criticEffort: value })}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              {AGENT_EFFORTS.map((effort) => <SelectItem key={effort} value={effort}>{effort}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="grid grid-cols-[92px_1fr_1fr] items-center gap-2.5 max-sm:grid-cols-1">
          <span className="text-xs text-[#7d7772]">Asset sculptors</span>
          <Select
            value={assets.assetModel ?? SOLO_SUBAGENT}
            onValueChange={(value) => onAssetsChange({ ...assets, assetModel: value === SOLO_SUBAGENT ? null : value })}
          >
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              {AGENT_MODEL_CHOICES.map((model) => <SelectItem key={model.id} value={model.id}>{model.label}</SelectItem>)}
              <SelectItem value={SOLO_SUBAGENT}>none (implement by hand)</SelectItem>
            </SelectContent>
          </Select>
          <Select
            value={assets.assetEffort}
            onValueChange={(value) => onAssetsChange({ ...assets, assetEffort: value })}
            disabled={assets.assetModel === null}
          >
            <SelectTrigger className={assets.assetModel === null ? 'opacity-50' : undefined}><SelectValue /></SelectTrigger>
            <SelectContent>
              {AGENT_EFFORTS.map((effort) => <SelectItem key={effort} value={effort}>{effort}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="grid grid-cols-2 gap-3 max-sm:grid-cols-1">
          <label className="grid gap-1.5 text-xs text-[#96908d]">
            Max rounds
            <input value={maxRounds} onChange={(event) => onMaxRoundsChange(event.target.value)} inputMode="numeric" className="h-9 rounded-lg border border-[#393433] bg-[#141010] px-3 text-xs text-[#eeeae7] outline-none focus:border-[#5a524f]" />
          </label>
          <label className="grid gap-1.5 text-xs text-[#96908d]">
            Budget $ (optional)
            <input value={budget} onChange={(event) => onBudgetChange(event.target.value)} inputMode="decimal" placeholder="none" className="h-9 rounded-lg border border-[#393433] bg-[#141010] px-3 text-xs text-[#eeeae7] outline-none placeholder:text-[#68615f] focus:border-[#5a524f]" />
          </label>
        </div>
        <p className="text-xs leading-relaxed text-[#7d7772]">
          {modelLabel(impl.orchestratorModel)} at {impl.orchestratorEffort} effort
          {impl.subagentModel ? ` with ${modelLabel(impl.subagentModel)} subagents at ${impl.subagentEffort} effort.` : ' with no subagents.'}{' '}
          {modelLabel(critic.criticModel)} critiques at {critic.criticEffort} effort. {describeCritic(critic.criticModel, impl.subagentModel ?? impl.orchestratorModel)}{' '}
          {research.researchModel ? `Reference Study fans research out to ${modelLabel(research.researchModel)} at ${research.researchEffort} effort.` : 'Reference Study researches without fan-out.'}
          {' '}{assets.assetModel ? `Each implement round can sculpt missing cast members with ${modelLabel(assets.assetModel)} at ${assets.assetEffort} effort.` : 'Cast assets are implemented by the main team.'}
        </p>
      </div>
      {error && <p className="mx-5 mb-3 rounded-lg border border-[#603f3f] bg-[#251718] px-3 py-2.5 text-xs text-[#f0aaaa]">{error}</p>}
      <div className="flex justify-end px-5 pb-5">
        <Button
          className="h-10 bg-[#eeeae7] px-5 text-[#1c1716] hover:bg-white"
          disabled={busy || !prompt.trim() || !workspaceDir}
          onClick={onCreate}
        >
          {busy ? <LoaderCircle className="animate-spin" /> : null} Create
        </Button>
      </div>
    </Card>
  )
}
