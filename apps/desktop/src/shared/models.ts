import type { HarnessKind } from './harness'
import type { BuildModels, ReferenceMode } from './build'
import { redactLogText } from './redact-log'

/** Per-agent effort. Both CLIs accept these five for any agent. */
export const AGENT_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const

/**
 * Legacy persisted session-level efforts (ADR-019); never offer these for new builds.
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

/** Canonical runtime ids shared by pickers, spawn plans, and pricing. */
export const MODEL_IDS = {
  claudeOpus: 'claude-opus-5',
  claudeFable51: 'claude-fable-5-1',
  claudeFable: 'claude-fable-5',
  claudeSonnet: 'claude-sonnet-5',
  claudeHaiku: 'claude-haiku-4-5',
  codexAstra: 'gpt-6-astra',
  codexSol: 'gpt-5.6-sol',
  codexTerra: 'gpt-5.6-terra',
  codexLuna: 'gpt-5.6-luna',
} as const

export const DISPATCHER_MODEL_ID = MODEL_IDS.claudeSonnet

const CLAUDE_MODELS: readonly ModelChoice[] = [
  // Fable 5.1 needs Claude Code 2.1.251+. An older CLI fails the attempt with
  // `400 ... does not support this model`, so a build picking it on a stale
  // binary dies on its first call rather than degrading.
  { id: MODEL_IDS.claudeFable51, label: 'Fable 5.1' },
  { id: MODEL_IDS.claudeFable, label: 'Fable 5' },
  { id: MODEL_IDS.claudeOpus, label: 'Opus 5' },
  { id: MODEL_IDS.claudeSonnet, label: 'Sonnet 5' },
]

/**
 * Every model any role can be given. The harness follows from the model name,
 * so an attempt never stores it separately.
 *
 * The Codex entries are ordered with Astra first, followed by the gpt-5.6
 * models: sol is
 * the frontier coder, terra is balanced for everyday work, luna is fast and
 * cheap. The list comes from `$CODEX_HOME/models_cache.json`; plain `gpt-5.6`
 * and `gpt-5.6-codex` are not in it and are refused with a 400.
 */
export const AGENT_MODEL_CHOICES: readonly ModelChoice[] = [
  ...CLAUDE_MODELS,
  { id: MODEL_IDS.codexAstra, label: 'Codex · gpt-6-astra' },
  { id: MODEL_IDS.codexSol, label: 'Codex · gpt-5.6-sol' },
  { id: MODEL_IDS.codexTerra, label: 'Codex · gpt-5.6-terra' },
  { id: MODEL_IDS.codexLuna, label: 'Codex · gpt-5.6-luna' },
]

export function isCodexModel(id: string | null | undefined): boolean {
  return !!id && id.startsWith('gpt-')
}

/** Which CLI a model runs on. Every role derives its harness this way. */
export function harnessFor(model: string | null | undefined): HarnessKind {
  return isCodexModel(model) ? 'codex' : 'claude'
}

/** Match a CLI's dated/suffixed model name back to a current canonical id. */
export function canonicalModelId(model: string | null | undefined): string | null {
  if (!model) return null
  return Object.values(MODEL_IDS).find((id) => model === id || model.startsWith(`${id}-`)) ?? null
}

/** Translate a historical effort when copying settings into a new-build draft. */
export function newBuildOrchestratorEffort(effort: string): string {
  if (effort === 'ultra') return 'max'
  if (effort === 'ultracode') return 'xhigh'
  return (AGENT_EFFORTS as readonly string[]).includes(effort) ? effort : 'high'
}

/** Historical normalization and replay only; new-build controls use AGENT_EFFORTS. */
export function orchestratorEfforts(model: string): readonly string[] {
  return isCodexModel(model) ? CODEX_ORCHESTRATOR_EFFORTS : CLAUDE_ORCHESTRATOR_EFFORTS
}

/**
 * True when the workers run on a different CLI than the orchestrator. Neither
 * CLI can host the other's model, so these builds delegate by shelling out —
 * see the delegation rules in build-runner.
 */
export function isCrossHarness(models: Pick<BuildModels, 'orchestratorModel' | 'subagentModel'>): boolean {
  return !!models.subagentModel && harnessFor(models.subagentModel) !== harnessFor(models.orchestratorModel)
}

export const SOLO_SUBAGENT = 'none'

/** The four fields the build form actually sets for the implementation side. */
export interface ImplementerFields {
  orchestratorModel: string
  orchestratorEffort: string
  subagentModel: string | null
  subagentEffort: string
}

/** Where the build form starts: the combination worth reaching for by default. */
export const DEFAULT_IMPLEMENTER: ImplementerFields = {
  orchestratorModel: MODEL_IDS.claudeOpus,
  orchestratorEffort: 'high',
  subagentModel: MODEL_IDS.claudeOpus,
  subagentEffort: 'high',
}

/** The critic is picked as a model and an effort, the same way subagents are. */
export interface CriticFields {
  criticModel: string
  criticEffort: string
}

/** Where the build form starts: a critic outside the implementer's model family. */
export const DEFAULT_CRITIC: CriticFields = { criticModel: MODEL_IDS.codexSol, criticEffort: 'medium' }

/** The Reference Study's deep-research fan-out is picked the same way. */
export interface ResearchFields {
  researchModel: string | null
  researchEffort: string
}

/** Where the build form starts: cheap, parallel researchers — luna is codex's fast/cheap tier. */
export const DEFAULT_RESEARCH: ResearchFields = { researchModel: MODEL_IDS.codexLuna, researchEffort: 'medium' }

/** The Asset Build's sculptors. Null skips the phase entirely. */
export interface AssetFields {
  assetModel: string | null
  assetEffort: string
}

/**
 * Where the build form starts: the subagent default, because sculptors are
 * fan-out workers. Not the critic's cross-family pick — the critic is in a
 * different model family so it has no attachment to the code, and no such
 * adversarial argument applies to production work. And not the cheap tier
 * research uses: this phase judges its own renders against a reference photo
 * pass after pass, so the vision is the job.
 */
export const DEFAULT_ASSET: AssetFields = { assetModel: MODEL_IDS.claudeOpus, assetEffort: 'high' }

/** The one-line note under the build form, judged against who is implementing. */
export function describeCritic(criticModel: string, implementerModel: string): string {
  return isCodexModel(criticModel) === isCodexModel(implementerModel)
    ? 'Same model family as the implementer, so expect a friendlier grader.'
    : 'A different model family from the implementer, so the critic has no attachment to the code.'
}

export function modelLabel(id: string | null | undefined): string {
  return AGENT_MODEL_CHOICES.find((m) => m.id === id)?.label ?? id ?? 'none'
}

/** Fan-out is an orchestrator effort level, not a separate switch: `ultracode` on claude, `ultra` on codex. */
export function isUltracode(models: Pick<BuildModels, 'orchestratorEffort'>): boolean {
  return models.orchestratorEffort === 'ultracode' || models.orchestratorEffort === 'ultra'
}

function pick<T extends string>(allowed: readonly T[], value: string | null | undefined, fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback
}

function storedModel(value: unknown, fallback: string): string {
  return typeof value === 'string' && /^(?:claude-|gpt-)[a-zA-Z0-9._:-]{1,127}$/.test(value) && redactLogText(value) === value ? value : fallback
}

function storedOptionalModel(value: unknown, fallback: string | null): string | null {
  if (value === null) return null
  return typeof value === 'string' && /^(?:claude-|gpt-)[a-zA-Z0-9._:-]{1,127}$/.test(value) && redactLogText(value) === value ? value : fallback
}

/** Clamp whatever the form sent to values the CLIs actually accept. */
export function resolveModels(
  fields: (Partial<ImplementerFields> & { referenceMode?: ReferenceMode }) | null | undefined,
  critic: Partial<CriticFields> | null | undefined,
  research?: Partial<ResearchFields> | null,
  asset?: Partial<AssetFields> | null,
): BuildModels {
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
    ...(fields?.referenceMode ? { referenceMode: fields.referenceMode } : {}),
    criticModel,
    criticEffort: pick(AGENT_EFFORTS, critic?.criticEffort, DEFAULT_CRITIC.criticEffort as 'medium'),
    researchModel: fields?.referenceMode && fields.referenceMode !== 'web' ? null : researchModel,
    researchEffort: pick(AGENT_EFFORTS, research?.researchEffort, DEFAULT_RESEARCH.researchEffort as 'medium'),
    assetModel: fields?.referenceMode === 'skip' ? null : assetModel,
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
export function normalizeModels(
  raw: (Partial<BuildModels> & { ultracode?: boolean; criticHarness?: unknown }) | null | undefined,
): BuildModels {
  if (!raw) return resolveModels(DEFAULT_IMPLEMENTER, DEFAULT_CRITIC)
  const models = resolveModels(
    {
      referenceMode: raw.referenceMode === 'files' || raw.referenceMode === 'skip' ? raw.referenceMode : raw.referenceMode === 'web' ? 'web' : undefined,
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
  // retitling an old build, but only where it is still a bounded CLI model id.
  const orchestratorModel = storedModel(raw.orchestratorModel, models.orchestratorModel)
  const criticModel = storedModel(raw.criticModel, models.criticModel)
  const subagentModel = storedOptionalModel(raw.subagentModel, models.subagentModel)
  const researchModel = storedOptionalModel(raw.researchModel, models.researchModel)
  const allowedOrchestratorEfforts = orchestratorEfforts(orchestratorModel)
  const fallbackOrchestratorEffort = allowedOrchestratorEfforts.includes(models.orchestratorEffort)
    ? models.orchestratorEffort
    : isCodexModel(orchestratorModel) ? 'high' : DEFAULT_IMPLEMENTER.orchestratorEffort
  return {
    ...models,
    orchestratorModel,
    subagentModel,
    researchModel: models.referenceMode && models.referenceMode !== 'web' ? null : researchModel,
    orchestratorEffort: pick(
      allowedOrchestratorEfforts,
      typeof raw.orchestratorEffort === 'string' ? raw.orchestratorEffort : undefined,
      fallbackOrchestratorEffort,
    ),
    criticModel,
    criticEffort: pick(
      AGENT_EFFORTS,
      typeof raw.criticEffort === 'string' ? raw.criticEffort : undefined,
      models.criticEffort as (typeof AGENT_EFFORTS)[number],
    ),
  }
}

/** One plain sentence naming who builds and who judges — used in logs and the report. */
export function describeModels(models: BuildModels): string {
  const impl = models.subagentModel
    ? `${models.orchestratorModel} (${models.orchestratorEffort}) orchestrating ${models.subagentModel} (${models.subagentEffort}) subagents`
    : `${models.orchestratorModel} (${models.orchestratorEffort}) solo, no subagents`
  const research = models.researchModel
    ? `${models.researchModel} (${models.researchEffort}) researchers fanned out`
    : 'no fan-out'
  const assets = models.assetModel
    ? `${models.assetModel} (${models.assetEffort}) sculptors, one per cast entry`
    : 'no asset phase'
  return `Implementer: ${impl} · Critic: ${harnessFor(models.criticModel)} ${models.criticModel} (${models.criticEffort}), fresh eyes every round. · Research: ${research}. · Assets: ${assets}.`
}
