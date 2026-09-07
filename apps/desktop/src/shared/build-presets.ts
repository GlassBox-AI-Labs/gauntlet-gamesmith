import { MODEL_IDS as M, type AssetFields, type CriticFields, type ImplementerFields, type ResearchFields } from './models'

export type BuildPace = 0 | 1 | 2 | 3 | 4
export const BUILD_PACES = ['Quick', 'Light', 'Balanced', 'Thorough', 'Maximum'] as const
export const DEFAULT_BUILD_PACE: BuildPace = 2

const CLAUDE_LEADS = [M.claudeSonnet, M.claudeOpus, M.claudeOpus, M.claudeFable51, M.claudeFable51] as const
const CODEX_LEADS = [M.codexLuna, M.codexTerra, M.codexSol, M.codexAstra, M.codexAstra] as const
const CLAUDE_WORKERS = [null, M.claudeSonnet, M.claudeSonnet, M.claudeOpus, M.claudeFable51] as const
const CODEX_WORKERS = [null, M.codexLuna, M.codexTerra, M.codexSol, M.codexAstra] as const
const EFFORTS = ['medium', 'medium', 'high', 'high', 'max'] as const

/**
 * Only model configuration changes; reference mode, budget and rounds belong to
 * the caller. `modelPace` picks each role's model along its staircase and
 * `effortPace` picks the effort; the collapsed investment scrubber passes the
 * same value for both, while the Advanced "Model tier" and "Effort" leans move
 * them apart.
 */
export function buildPreset(modelPace: BuildPace, effortPace: BuildPace, connected: { claude: boolean; codex: boolean }, sculpting: boolean): ImplementerFields & CriticFields & ResearchFields & AssetFields {
  const useClaude = connected.claude || !connected.codex
  const primary = (useClaude ? CLAUDE_LEADS : CODEX_LEADS)[modelPace]
  const worker = (useClaude ? CLAUDE_WORKERS : CODEX_WORKERS)[modelPace]
  const effort = EFFORTS[effortPace]
  return {
    orchestratorModel: primary,
    orchestratorEffort: effort,
    subagentModel: worker,
    subagentEffort: effort,
    criticModel: (connected.codex ? CODEX_LEADS : CLAUDE_LEADS)[modelPace],
    criticEffort: effort,
    researchModel: modelPace === 0 ? null : connected.codex
      ? modelPace < 3 ? M.codexLuna : M.codexSol
      : modelPace < 3 ? M.claudeSonnet : M.claudeOpus,
    researchEffort: effort,
    assetModel: sculpting ? worker ?? primary : null,
    assetEffort: effort,
  }
}

/**
 * The preset cut into the four groups the build form stores separately.
 *
 * The form keeps `impl`, `critic`, `research` and `assets` in four states and
 * merges them by spreading, in that order, when the build starts. Handing the
 * whole preset object to all four setters therefore made every group carry all
 * ten fields, and the last spread silently overwrote every earlier edit — a build
 * configured by hand started on the preset's models instead. Each setter gets
 * only its own fields.
 */
export function presetSlices(modelPace: BuildPace, effortPace: BuildPace, connected: { claude: boolean; codex: boolean }, sculpting: boolean): {
  impl: ImplementerFields
  critic: CriticFields
  research: ResearchFields
  assets: AssetFields
} {
  const preset = buildPreset(modelPace, effortPace, connected, sculpting)
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
