import type { HarnessKind } from './harness'
import type { LoopModels } from './loop'

/** Per-agent effort. Both CLIs accept these five for any agent. */
export const AGENT_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const

/**
 * Session-level efforts that also switch on the CLI's own fan-out.
 *
 * `ultracode` is not in claude's `--help` and not in its "valid values"
 * warning, but v2.1.203+ accepts it: it sends xhigh to the model AND turns on
 * automatic workflow orchestration. Codex's equivalent is `ultra`, which its
 * model metadata describes as "Maximum reasoning with automatic task
 * delegation" — offered by sol and terra, not luna.
 */
export const CLAUDE_ORCHESTRATOR_EFFORTS = [...AGENT_EFFORTS, 'ultracode'] as const
export const CODEX_ORCHESTRATOR_EFFORTS = [...AGENT_EFFORTS, 'ultra'] as const

export interface ModelChoice {
  id: string
  label: string
}

const CLAUDE_MODELS: readonly ModelChoice[] = [
  { id: 'claude-opus-5', label: 'Opus 5' },
  // Fable 5.1 needs Claude Code 2.1.251+. An older CLI fails the run with
  // `400 ... does not support this model`, so a loop picking it on a stale
  // binary dies on its first call rather than degrading.
  { id: 'claude-fable-5-1', label: 'Fable 5.1' },
  { id: 'claude-fable-5', label: 'Fable 5' },
  { id: 'claude-sonnet-5', label: 'Sonnet 5' },
]

/**
 * Every model any role can be given. The harness follows from the model name,
 * so a run never stores it separately.
 *
 * The codex entries are the gpt-5.6 models it offers, in its own words: sol is
 * the frontier coder, terra is balanced for everyday work, luna is fast and
 * cheap. The list comes from `$CODEX_HOME/models_cache.json`; plain `gpt-5.6`
 * and `gpt-5.6-codex` are not in it and are refused with a 400.
 */
export const AGENT_MODEL_CHOICES: readonly ModelChoice[] = [
  ...CLAUDE_MODELS,
  { id: 'gpt-5.6-sol', label: 'Codex · gpt-5.6-sol' },
  { id: 'gpt-5.6-terra', label: 'Codex · gpt-5.6-terra' },
  { id: 'gpt-5.6-luna', label: 'Codex · gpt-5.6-luna' },
]

export function isCodexModel(id: string | null | undefined): boolean {
  return !!id && id.startsWith('gpt-')
}

/** Which CLI a model runs on. Every role derives its harness this way. */
export function harnessFor(model: string | null | undefined): HarnessKind {
  return isCodexModel(model) ? 'codex' : 'claude'
}

export function orchestratorEfforts(model: string): readonly string[] {
  return isCodexModel(model) ? CODEX_ORCHESTRATOR_EFFORTS : CLAUDE_ORCHESTRATOR_EFFORTS
}

/**
 * True when the workers run on a different CLI than the orchestrator. Neither
 * CLI can host the other's model, so these runs delegate by shelling out —
 * see the delegation rules in loop-runner.
 */
export function isCrossHarness(models: Pick<LoopModels, 'orchestratorModel' | 'subagentModel'>): boolean {
  return !!models.subagentModel && harnessFor(models.subagentModel) !== harnessFor(models.orchestratorModel)
}

export const SOLO_SUBAGENT = 'none'

/** The four fields the run form actually sets for the implementation side. */
export interface ImplementerFields {
  orchestratorModel: string
  orchestratorEffort: string
  subagentModel: string | null
  subagentEffort: string
}

/** Where the run form starts: the combination worth reaching for by default. */
export const DEFAULT_IMPLEMENTER: ImplementerFields = {
  orchestratorModel: 'claude-opus-5',
  orchestratorEffort: 'ultracode',
  subagentModel: 'claude-opus-5',
  subagentEffort: 'high',
}

/** The critic is picked as a model and an effort, the same way subagents are. */
export interface CriticFields {
  criticModel: string
  criticEffort: string
}

/** Where the run form starts: a critic outside the implementer's model family. */
export const DEFAULT_CRITIC: CriticFields = { criticModel: 'gpt-5.6-sol', criticEffort: 'medium' }

/** The Reference Study's deep-research fan-out is picked the same way. */
export interface ResearchFields {
  researchModel: string | null
  researchEffort: string
}

/** Where the run form starts: cheap, parallel researchers — luna is codex's fast/cheap tier. */
export const DEFAULT_RESEARCH: ResearchFields = { researchModel: 'gpt-5.6-luna', researchEffort: 'medium' }

/** The Asset Build's sculptors. Null skips the phase entirely. */
export interface AssetFields {
  assetModel: string | null
  assetEffort: string
}

/**
 * Where the run form starts: the subagent default, because sculptors are
 * fan-out workers. Not the critic's cross-family pick — the critic is in a
 * different model family so it has no attachment to the code, and no such
 * adversarial argument applies to production work. And not the cheap tier
 * research uses: this phase judges its own renders against a reference photo
 * pass after pass, so the vision is the job.
 */
export const DEFAULT_ASSET: AssetFields = { assetModel: 'claude-opus-5', assetEffort: 'high' }

/** The one-line note under the run form, judged against who is implementing. */
export function describeCritic(criticModel: string, implementerModel: string): string {
  return isCodexModel(criticModel) === isCodexModel(implementerModel)
    ? 'Same model family as the implementer, so expect a friendlier grader.'
    : 'A different model family from the implementer, so the critic has no attachment to the code.'
}

export function modelLabel(id: string | null | undefined): string {
  return AGENT_MODEL_CHOICES.find((m) => m.id === id)?.label ?? id ?? 'none'
}

/** Fan-out is an orchestrator effort level, not a separate switch: `ultracode` on claude, `ultra` on codex. */
export function isUltracode(models: Pick<LoopModels, 'orchestratorEffort'>): boolean {
  return models.orchestratorEffort === 'ultracode' || models.orchestratorEffort === 'ultra'
}

function pick<T extends string>(allowed: readonly T[], value: string | null | undefined, fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback
}

/** Clamp whatever the form sent to values the CLIs actually accept. */
export function resolveModels(
  fields: Partial<ImplementerFields> | null | undefined,
  critic: Partial<CriticFields> | null | undefined,
  research?: Partial<ResearchFields> | null,
  asset?: Partial<AssetFields> | null,
): LoopModels {
  const base = DEFAULT_IMPLEMENTER
  const subagentModel =
    fields?.subagentModel === null || fields?.subagentModel === SOLO_SUBAGENT
      ? null
      : AGENT_MODEL_CHOICES.some((m) => m.id === fields?.subagentModel)
        ? fields!.subagentModel!
        : base.subagentModel
  const criticModel = AGENT_MODEL_CHOICES.some((m) => m.id === critic?.criticModel)
    ? critic!.criticModel!
    : DEFAULT_CRITIC.criticModel
  const orchestratorModel = AGENT_MODEL_CHOICES.some((m) => m.id === fields?.orchestratorModel)
    ? fields!.orchestratorModel!
    : base.orchestratorModel
  const resolved: ImplementerFields = {
    orchestratorModel,
    orchestratorEffort: pick(
      orchestratorEfforts(orchestratorModel),
      fields?.orchestratorEffort,
      isCodexModel(orchestratorModel) ? 'high' : base.orchestratorEffort,
    ),
    subagentModel,
    subagentEffort: pick(AGENT_EFFORTS, fields?.subagentEffort, base.subagentEffort as 'high'),
  }
  const researchModel =
    research?.researchModel === null || research?.researchModel === SOLO_SUBAGENT
      ? null
      : AGENT_MODEL_CHOICES.some((m) => m.id === research?.researchModel)
        ? research!.researchModel!
        : DEFAULT_RESEARCH.researchModel
  // `asset` undefined means the caller predates the field and gets the default;
  // an explicit null is the operator turning the phase off, and must survive.
  const assetModel =
    asset?.assetModel === null || asset?.assetModel === SOLO_SUBAGENT
      ? null
      : AGENT_MODEL_CHOICES.some((m) => m.id === asset?.assetModel)
        ? asset!.assetModel!
        : DEFAULT_ASSET.assetModel
  return {
    ...resolved,
    criticHarness: harnessFor(criticModel),
    criticModel,
    criticEffort: pick(AGENT_EFFORTS, critic?.criticEffort, DEFAULT_CRITIC.criticEffort as 'medium'),
    researchModel,
    researchEffort: pick(AGENT_EFFORTS, research?.researchEffort, DEFAULT_RESEARCH.researchEffort as 'medium'),
    assetModel,
    assetEffort: pick(AGENT_EFFORTS, asset?.assetEffort, DEFAULT_ASSET.assetEffort as 'high'),
  }
}

/**
 * Older ledger rows predate these fields. Older still are rows written before
 * ultracode moved from a prompt keyword to an effort level — those carry an
 * `ultracode: true` boolean, which becomes the ultracode effort here. Rows from
 * the critic-preset era carry a `criticId`, which is ignored: they store the
 * model and effort that preset stood for anyway.
 */
export function normalizeModels(raw: (Partial<LoopModels> & { ultracode?: boolean }) | null | undefined): LoopModels {
  if (!raw) return resolveModels(DEFAULT_IMPLEMENTER, DEFAULT_CRITIC)
  const models = resolveModels(
    {
      orchestratorModel: raw.orchestratorModel,
      orchestratorEffort: raw.ultracode && !raw.orchestratorEffort ? 'ultracode' : raw.orchestratorEffort,
      subagentModel: raw.subagentModel,
      subagentEffort: raw.subagentEffort,
    },
    { criticModel: raw.criticModel, criticEffort: raw.criticEffort },
    { researchModel: raw.researchModel, researchEffort: raw.researchEffort },
    // A row written before the asset phase has no key at all, and must not be
    // read as "the operator turned it off" — `undefined` takes the default,
    // and only a stored null keeps the phase off.
    'assetModel' in raw ? { assetModel: raw.assetModel, assetEffort: raw.assetEffort } : undefined,
  )
  // Keep a model name the picker no longer offers rather than silently
  // retitling an old run, but only where it is still a name a CLI would accept.
  const criticModel = raw.criticModel ?? models.criticModel
  return {
    ...models,
    orchestratorModel: raw.orchestratorModel ?? models.orchestratorModel,
    // A stored model name the picker no longer matches must still spawn on the
    // right CLI, so fall back to reading the harness off the model name.
    criticHarness: raw.criticHarness ?? harnessFor(criticModel),
    criticModel,
    criticEffort: raw.criticEffort ?? models.criticEffort,
  }
}

/** One plain sentence naming who builds and who judges — used in logs and the report. */
export function describeModels(models: LoopModels): string {
  const impl = models.subagentModel
    ? `${models.orchestratorModel} (${models.orchestratorEffort}) orchestrating ${models.subagentModel} (${models.subagentEffort}) subagents`
    : `${models.orchestratorModel} (${models.orchestratorEffort}) solo, no subagents`
  const research = models.researchModel
    ? `${models.researchModel} (${models.researchEffort}) researchers fanned out`
    : 'no fan-out'
  const assets = models.assetModel
    ? `${models.assetModel} (${models.assetEffort}) sculptors, one per cast entry`
    : 'no asset phase'
  return `Implementer: ${impl} · Critic: ${models.criticHarness} ${models.criticModel} (${models.criticEffort}), fresh eyes every round. · Research: ${research}. · Assets: ${assets}.`
}
