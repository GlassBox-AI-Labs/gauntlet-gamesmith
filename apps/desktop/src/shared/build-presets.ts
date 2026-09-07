import { AGENT_EFFORTS, harnessFor, MODEL_IDS as M, MODEL_LADDER, type AssetFields, type CriticFields, type ImplementerFields, type ResearchFields } from './models'

export type BuildPace = 0 | 1 | 2 | 3 | 4
export const BUILD_PACES = ['Quick', 'Light', 'Balanced', 'Thorough', 'Maximum'] as const
export const DEFAULT_BUILD_PACE: BuildPace = 2

const CLAUDE_LEADS = [M.claudeSonnet, M.claudeOpus, M.claudeOpus, M.claudeFable51, M.claudeFable51] as const
const CODEX_LEADS = [M.codexLuna, M.codexTerra, M.codexSol, M.codexAstra, M.codexAstra] as const

// Effort rises with the lean but is not flat across roles. The orchestrator sets
// the level and the critic matches it (same model and effort, fresh eyes on equal
// footing); the subagent sits one model tier and one effort step below at every
// step; research fans out cheap; sculptors track the workers.
const ORCHESTRATOR_EFFORTS = ['medium', 'high', 'high', 'xhigh', 'max'] as const
const RESEARCH_EFFORTS = ['low', 'low', 'medium', 'medium', 'high'] as const
const ASSET_EFFORTS = ['medium', 'medium', 'high', 'high', 'max'] as const

/** One rung lower on the model's own family ladder, or null at the bottom (solo). */
function oneTierBelow(model: string): string | null {
  const ladder = MODEL_LADDER[harnessFor(model)]
  const at = ladder.indexOf(model)
  return at <= 0 ? null : ladder[at - 1]
}

/** One reasoning level lower, floored at the bottom of the ladder. */
function oneEffortBelow(effort: string): string {
  const at = AGENT_EFFORTS.indexOf(effort as (typeof AGENT_EFFORTS)[number])
  return AGENT_EFFORTS[Math.max(0, at - 1)]
}

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
  const worker = oneTierBelow(primary)
  const effort = ORCHESTRATOR_EFFORTS[effortPace]
  return {
    orchestratorModel: primary,
    orchestratorEffort: effort,
    // A tier and a step below the lead at every level; null at the bottom is solo.
    subagentModel: worker,
    subagentEffort: oneEffortBelow(effort),
    // The critic mirrors the orchestrator by default; the Advanced cross-family
    // toggle is how the operator moves it to the other family.
    criticModel: primary,
    criticEffort: effort,
    researchModel: modelPace === 0 ? null : connected.codex
      ? modelPace < 3 ? M.codexLuna : M.codexSol
      : modelPace < 3 ? M.claudeSonnet : M.claudeOpus,
    researchEffort: RESEARCH_EFFORTS[effortPace],
    assetModel: sculpting ? worker ?? primary : null,
    assetEffort: ASSET_EFFORTS[effortPace],
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
