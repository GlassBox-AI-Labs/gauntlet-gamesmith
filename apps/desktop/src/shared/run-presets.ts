import { MODEL_IDS as M, type AssetFields, type CriticFields, type ImplementerFields, type ResearchFields } from './models'

export type RunPace = 0 | 1 | 2 | 3 | 4
export const RUN_PACES = ['Quick', 'Light', 'Balanced', 'Thorough', 'Maximum'] as const
export const DEFAULT_RUN_PACE: RunPace = 2

const CLAUDE_LEADS = [M.claudeSonnet, M.claudeOpus, M.claudeOpus, M.claudeFable51, M.claudeFable51] as const
const CODEX_LEADS = [M.codexLuna, M.codexTerra, M.codexSol, M.codexAstra, M.codexAstra] as const
const CLAUDE_WORKERS = [null, M.claudeSonnet, M.claudeSonnet, M.claudeOpus, M.claudeFable51] as const
const CODEX_WORKERS = [null, M.codexLuna, M.codexTerra, M.codexSol, M.codexAstra] as const
const EFFORTS = ['medium', 'medium', 'high', 'high', 'max'] as const

/** Only model configuration changes; reference mode, budget and rounds belong to the caller. */
export function runPreset(pace: RunPace, connected: { claude: boolean; codex: boolean }, sculpting: boolean): ImplementerFields & CriticFields & ResearchFields & AssetFields {
  const useClaude = connected.claude || !connected.codex
  const primary = (useClaude ? CLAUDE_LEADS : CODEX_LEADS)[pace]
  const worker = (useClaude ? CLAUDE_WORKERS : CODEX_WORKERS)[pace]
  const effort = EFFORTS[pace]
  return {
    orchestratorModel: primary,
    orchestratorEffort: effort,
    subagentModel: worker,
    subagentEffort: effort,
    criticModel: (connected.codex ? CODEX_LEADS : CLAUDE_LEADS)[pace],
    criticEffort: effort,
    researchModel: pace === 0 ? null : connected.codex
      ? pace < 3 ? M.codexLuna : M.codexSol
      : pace < 3 ? M.claudeSonnet : M.claudeOpus,
    researchEffort: effort,
    assetModel: sculpting ? worker ?? primary : null,
    assetEffort: effort,
  }
}

/**
 * The preset cut into the four groups the run form stores separately.
 *
 * The form keeps `impl`, `critic`, `research` and `assets` in four states and
 * merges them by spreading, in that order, when the run starts. Handing the
 * whole preset object to all four setters therefore made every group carry all
 * ten fields, and the last spread silently overwrote every earlier edit — a run
 * configured by hand started on the preset's models instead. Each setter gets
 * only its own fields.
 */
export function presetSlices(pace: RunPace, connected: { claude: boolean; codex: boolean }, sculpting: boolean): {
  impl: ImplementerFields
  critic: CriticFields
  research: ResearchFields
  assets: AssetFields
} {
  const preset = runPreset(pace, connected, sculpting)
  return {
    impl: {
      orchestratorModel: preset.orchestratorModel,
      orchestratorEffort: preset.orchestratorEffort,
      subagentModel: preset.subagentModel,
      subagentEffort: preset.subagentEffort,
    },
    critic: { criticModel: preset.criticModel, criticEffort: preset.criticEffort },
    research: { researchModel: preset.researchModel, researchEffort: preset.researchEffort },
    assets: { assetModel: preset.assetModel, assetEffort: preset.assetEffort },
  }
}
