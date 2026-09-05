import type { HarnessKind } from './harness'
import type { LoopModels, ReferenceMode } from './loop'
import { redactLogText } from './redact-log'

/** Per-agent effort. Claude and Codex accept these five for any agent. */
export const AGENT_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const

/**
 * Grok's effort set differs per model, and neither model takes `max`. Read off
 * the CLI, which validates the flag and names what it accepts:
 *
 *   $ grok -m grok-4.6 -p hi --reasoning-effort bogus
 *   unknown effort level 'bogus'; use one of: xhigh, high, medium, low
 *   $ grok -m grok-4.5 -p hi --reasoning-effort bogus
 *   unknown effort level 'bogus'; use one of: high, medium, low
 *
 * Offering a level the model refuses fails the run at launch, so this is keyed
 * by model rather than by harness.
 */
export const GROK_EFFORTS = ['low', 'medium', 'high', 'xhigh'] as const
const GROK_MODEL_EFFORTS: Record<string, readonly string[]> = {
  'grok-4.6': ['low', 'medium', 'high', 'xhigh'],
  'grok-4.5': ['low', 'medium', 'high'],
}

/**
 * Legacy persisted session-level efforts (ADR-019); never offer these for new runs.
 * Session-level efforts that also switch on the CLI's own fan-out.
 *
 * `ultracode` is not in claude's `--help` and not in its "valid values"
 * warning, but v2.1.203+ accepts it: it sends xhigh to the model AND turns on
 * automatic workflow orchestration. Codex's equivalent is `ultra`, which its
 * model metadata describes as "Maximum reasoning with automatic task
 * delegation" — offered by sol and terra, not luna. Grok has no equivalent:
 * its fan-out is a tool, not an effort level.
 */
export const CLAUDE_ORCHESTRATOR_EFFORTS = [...AGENT_EFFORTS, 'ultracode'] as const
export const CODEX_ORCHESTRATOR_EFFORTS = [...AGENT_EFFORTS, 'ultra'] as const

export interface ModelChoice {
  id: string
  label: string
  /** Which CLI runs it. Stored on the choice, never guessed from the id. */
  harness: HarnessKind
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
  grok46: 'grok-4.6',
  grok45: 'grok-4.5',
} as const

export const DISPATCHER_MODEL_ID = MODEL_IDS.claudeSonnet

const CLAUDE_MODELS: readonly ModelChoice[] = [
  // Fable 5.1 needs Claude Code 2.1.251+. An older CLI fails the run with
  // `400 ... does not support this model`, so a loop picking it on a stale
  // binary dies on its first call rather than degrading.
  { id: MODEL_IDS.claudeFable51, label: 'Fable 5.1', harness: 'claude' },
  { id: MODEL_IDS.claudeFable, label: 'Fable 5', harness: 'claude' },
  { id: MODEL_IDS.claudeOpus, label: 'Opus 5', harness: 'claude' },
  { id: MODEL_IDS.claudeSonnet, label: 'Sonnet 5', harness: 'claude' },
]

/**
 * Every model any role can be given, each naming the CLI that runs it.
 *
 * The Codex entries are ordered with Astra first, followed by the gpt-5.6
 * models: sol is
 * the frontier coder, terra is balanced for everyday work, luna is fast and
 * cheap. The list comes from `$CODEX_HOME/models_cache.json`; plain `gpt-5.6`
 * and `gpt-5.6-codex` are not in it and are refused with a 400.
 *
 * The grok entries are what `grok models` reports. `grok-build` appears in
 * Grok's own bundled docs but is refused as an "unknown model id".
 */
export const AGENT_MODEL_CHOICES: readonly ModelChoice[] = [
  ...CLAUDE_MODELS,
  { id: MODEL_IDS.codexAstra, label: 'Codex · gpt-6-astra', harness: 'codex' },
  { id: MODEL_IDS.codexSol, label: 'Codex · gpt-5.6-sol', harness: 'codex' },
  { id: MODEL_IDS.codexTerra, label: 'Codex · gpt-5.6-terra', harness: 'codex' },
  { id: MODEL_IDS.codexLuna, label: 'Codex · gpt-5.6-luna', harness: 'codex' },
  { id: MODEL_IDS.grok46, label: 'Grok · grok-4.6', harness: 'grok' },
  { id: MODEL_IDS.grok45, label: 'Grok · grok-4.5', harness: 'grok' },
]

export function modelChoice(id: string | null | undefined): ModelChoice | undefined {
  return AGENT_MODEL_CHOICES.find((m) => m.id === id)
}

/**
 * Harness for a model name, by prefix — the rule the app used before roles
 * stored their harness.
 *
 * Only `normalizeModels` should call this, and only to fill in a run recorded
 * before the harness was stored. It is wrong in general: a harness can host
 * another harness's models, so a name cannot carry the answer.
 */
export function legacyHarnessForModel(model: string | null | undefined): HarnessKind {
  if (model?.startsWith('gpt-')) return 'codex'
  if (model?.startsWith('grok-')) return 'grok'
  return 'claude'
}

/** The harness a picked model runs on: an explicit lookup, not a guess. */
export function harnessFor(model: string | null | undefined): HarnessKind {
  return modelChoice(model)?.harness ?? legacyHarnessForModel(model)
}

/** Match a CLI's dated/suffixed model name back to a current canonical id. */
export function canonicalModelId(model: string | null | undefined): string | null {
  if (!model) return null
  return Object.values(MODEL_IDS).find((id) => model === id || model.startsWith(`${id}-`)) ?? null
}

/** True when a picked model runs on the codex CLI. */
export function isCodexModel(model: string | null | undefined): boolean {
  return harnessFor(model) === 'codex'
}

/** Efforts a non-orchestrator agent can be given, for a picked model. */
export function effortsForModel(model: string | null | undefined): readonly string[] {
  if (harnessFor(model) !== 'grok') return AGENT_EFFORTS
  return GROK_MODEL_EFFORTS[model ?? ''] ?? GROK_EFFORTS
}

/** Keep a chosen effort valid when the model changes under it. */
export function clampEffort(allowed: readonly string[], effort: string): string {
  return allowed.includes(effort) ? effort : (allowed.includes('high') ? 'high' : allowed[allowed.length - 1])
}

/** Translate a historical effort when copying settings into a new-run draft. */
export function newRunOrchestratorEffort(effort: string): string {
  if (effort === 'ultra') return 'max'
  if (effort === 'ultracode') return 'xhigh'
  return (AGENT_EFFORTS as readonly string[]).includes(effort) ? effort : 'high'
}

/**
 * Efforts an orchestrator can be given, for historical normalization and
 * replay only; new-run controls use AGENT_EFFORTS (ADR-019). Codex offers
 * `ultra` only on the models whose metadata lists it — luna's supported set
 * stops at `max`.
 */
export function orchestratorEfforts(model: string): readonly string[] {
  const harness = harnessFor(model)
  if (harness === 'grok') return effortsForModel(model)
  if (harness === 'codex') return model === 'gpt-5.6-luna' ? AGENT_EFFORTS : CODEX_ORCHESTRATOR_EFFORTS
  return CLAUDE_ORCHESTRATOR_EFFORTS
}

/**
 * The model's vendor, for judging whether a critic shares the implementer's
 * lineage. This is a property of the model, not of the CLI running it — the
 * same model can be reached through more than one harness.
 */
export function modelFamily(model: string | null | undefined): string {
  const bare = (model ?? '').split('/').pop() ?? ''
  if (bare.startsWith('gpt-')) return 'openai'
  if (bare.startsWith('grok-')) return 'xai'
  if (bare.startsWith('claude-')) return 'anthropic'
  return bare || 'unknown'
}

/**
 * True when the workers run on a different CLI than the orchestrator. Neither
 * CLI can host the other's model, so these runs delegate by shelling out —
 * see the delegation rules in loop-runner.
 */
export function isCrossHarness(models: Pick<LoopModels, 'orchestratorHarness' | 'subagentHarness'>): boolean {
  return !!models.subagentHarness && models.subagentHarness !== models.orchestratorHarness
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

/** Where the run form starts: a critic outside the implementer's model family. */
export const DEFAULT_CRITIC: CriticFields = { criticModel: MODEL_IDS.codexSol, criticEffort: 'medium' }

/** The Reference Study's deep-research fan-out is picked the same way. */
export interface ResearchFields {
  researchModel: string | null
  researchEffort: string
}

/** Where the run form starts: cheap, parallel researchers — luna is codex's fast/cheap tier. */
export const DEFAULT_RESEARCH: ResearchFields = { researchModel: MODEL_IDS.codexLuna, researchEffort: 'medium' }

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
export const DEFAULT_ASSET: AssetFields = { assetModel: MODEL_IDS.claudeOpus, assetEffort: 'high' }

/** The one-line note under the run form, judged against who is implementing. */
export function describeCritic(criticModel: string, implementerModel: string): string {
  return modelFamily(criticModel) === modelFamily(implementerModel)
    ? 'Same model family as the implementer, so expect a friendlier grader.'
    : 'A different model family from the implementer, so the critic has no attachment to the code.'
}

export function modelLabel(id: string | null | undefined): string {
  return modelChoice(id)?.label ?? id ?? 'none'
}

/** Fan-out is an orchestrator effort level, not a separate switch: `ultracode` on claude, `ultra` on codex. */
export function isUltracode(models: Pick<LoopModels, 'orchestratorEffort'>): boolean {
  return models.orchestratorEffort === 'ultracode' || models.orchestratorEffort === 'ultra'
}

function pick<T extends string>(allowed: readonly T[], value: string | null | undefined, fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback
}

function storedModel(value: unknown, fallback: string): string {
  return typeof value === 'string' && /^(?:claude-|gpt-|grok-)[a-zA-Z0-9._:-]{1,127}$/.test(value) && redactLogText(value) === value ? value : fallback
}

function storedOptionalModel(value: unknown, fallback: string | null): string | null {
  if (value === null) return null
  return typeof value === 'string' && /^(?:claude-|gpt-|grok-)[a-zA-Z0-9._:-]{1,127}$/.test(value) && redactLogText(value) === value ? value : fallback
}

/** Clamp whatever the form sent to values the CLIs actually accept. */
export function resolveModels(
  fields: (Partial<ImplementerFields> & { referenceMode?: ReferenceMode }) | null | undefined,
  critic: Partial<CriticFields> | null | undefined,
  research?: Partial<ResearchFields> | null,
  asset?: Partial<AssetFields> | null,
): LoopModels {
  const base = DEFAULT_IMPLEMENTER
  const subagentModel =
    fields?.subagentModel === null || fields?.subagentModel === SOLO_SUBAGENT
      ? null
      : modelChoice(fields?.subagentModel)
        ? fields!.subagentModel!
        : base.subagentModel
  const criticModel = modelChoice(critic?.criticModel) ? critic!.criticModel! : DEFAULT_CRITIC.criticModel
  const orchestratorModel = modelChoice(fields?.orchestratorModel) ? fields!.orchestratorModel! : base.orchestratorModel
  const orchestratorHarness = harnessFor(orchestratorModel)
  const researchModel =
    research?.researchModel === null || research?.researchModel === SOLO_SUBAGENT
      ? null
      : modelChoice(research?.researchModel)
        ? research!.researchModel!
        : DEFAULT_RESEARCH.researchModel
  // `asset` undefined means the caller predates the field and gets the default;
  // an explicit null is the operator turning the phase off, and must survive.
  const assetModel =
    asset?.assetModel === null || asset?.assetModel === SOLO_SUBAGENT
      ? null
      : modelChoice(asset?.assetModel)
        ? asset!.assetModel!
        : DEFAULT_ASSET.assetModel
  const researchHarnessModel = fields?.referenceMode && fields.referenceMode !== 'web' ? null : researchModel
  const resolvedAssetModel = fields?.referenceMode === 'skip' ? null : assetModel
  return {
    ...(fields?.referenceMode ? { referenceMode: fields.referenceMode } : {}),
    orchestratorHarness,
    orchestratorModel,
    orchestratorEffort: pick(
      orchestratorEfforts(orchestratorModel),
      fields?.orchestratorEffort,
      orchestratorHarness === 'claude' ? base.orchestratorEffort : 'high',
    ),
    subagentHarness: subagentModel ? harnessFor(subagentModel) : null,
    subagentModel,
    subagentEffort: pick(effortsForModel(subagentModel), fields?.subagentEffort, base.subagentEffort as 'high'),
    criticHarness: harnessFor(criticModel),
    criticModel,
    criticEffort: pick(effortsForModel(criticModel), critic?.criticEffort, DEFAULT_CRITIC.criticEffort as 'medium'),
    // Only a web Reference Study fans researchers out; files-only and skip do not.
    researchHarness: researchHarnessModel ? harnessFor(researchHarnessModel) : null,
    researchModel: researchHarnessModel,
    researchEffort: pick(effortsForModel(researchModel), research?.researchEffort, DEFAULT_RESEARCH.researchEffort as 'medium'),
    assetHarness: resolvedAssetModel ? harnessFor(resolvedAssetModel) : null,
    assetModel: resolvedAssetModel,
    assetEffort: pick(effortsForModel(assetModel), asset?.assetEffort, DEFAULT_ASSET.assetEffort as 'high'),
  }
}

/**
 * Older ledger rows predate these fields. Older still are rows written before
 * ultracode moved from a prompt keyword to an effort level — those carry an
 * `ultracode: true` boolean, which becomes the ultracode effort here. Rows from
 * the critic-preset era carry a `criticId`, which is ignored: they store the
 * model and effort that preset stood for anyway.
 *
 * Rows written before roles stored their harness carry only model names, so
 * their harness is recovered with the old prefix rule. Getting this wrong is
 * not cosmetic: `resumeLoop` reads these fields to decide which binary to
 * spawn.
 */
export function normalizeModels(
  raw: (Partial<LoopModels> & { ultracode?: boolean; criticHarness?: unknown }) | null | undefined,
): LoopModels {
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
  // retitling an old run, but only where it is still a bounded CLI model id.
  const orchestratorModel = storedModel(raw.orchestratorModel, models.orchestratorModel)
  const criticModel = storedModel(raw.criticModel, models.criticModel)
  const subagentModel = storedOptionalModel(raw.subagentModel, models.subagentModel)
  const researchModel = storedOptionalModel(raw.researchModel, models.researchModel)
  // Only a web Reference Study fans researchers out (ADR-018).
  const gatedResearchModel = models.referenceMode && models.referenceMode !== 'web' ? null : researchModel
  const assetModel = storedOptionalModel(raw.assetModel, models.assetModel)
  const allowedOrchestratorEfforts = orchestratorEfforts(orchestratorModel)
  const fallbackOrchestratorEffort = allowedOrchestratorEfforts.includes(models.orchestratorEffort)
    ? models.orchestratorEffort
    : legacyHarnessForModel(orchestratorModel) === 'claude' ? DEFAULT_IMPLEMENTER.orchestratorEffort : 'high'
  return {
    ...models,
    // A stored model name the picker no longer matches must still spawn on the
    // right CLI, so fall back to reading the harness off the model name.
    orchestratorHarness: raw.orchestratorHarness ?? legacyHarnessForModel(orchestratorModel),
    orchestratorModel,
    orchestratorEffort: pick(
      allowedOrchestratorEfforts,
      typeof raw.orchestratorEffort === 'string' ? raw.orchestratorEffort : undefined,
      fallbackOrchestratorEffort,
    ),
    subagentHarness: subagentModel ? (raw.subagentHarness ?? legacyHarnessForModel(subagentModel)) : null,
    subagentModel,
    criticHarness: raw.criticHarness ?? legacyHarnessForModel(criticModel),
    criticModel,
    criticEffort: pick(
      effortsForModel(criticModel),
      typeof raw.criticEffort === 'string' ? raw.criticEffort : undefined,
      models.criticEffort,
    ),
    researchHarness: gatedResearchModel ? (raw.researchHarness ?? legacyHarnessForModel(gatedResearchModel)) : null,
    researchModel: gatedResearchModel,
    assetHarness: assetModel ? (raw.assetHarness ?? legacyHarnessForModel(assetModel)) : null,
    assetModel,
  }
}

/** One plain sentence naming who builds and who judges — used in logs and the report. */
export function describeModels(models: LoopModels): string {
  const impl = models.subagentModel
    ? `${models.orchestratorModel} (${models.orchestratorEffort}) orchestrating ${models.subagentModel} (${models.subagentEffort}) subagents`
    : `${models.orchestratorModel} (${models.orchestratorEffort}) solo, no subagents`
  const research = models.referenceMode === 'skip'
    ? 'Reference Study skipped — the brief is the whole spec'
    : models.referenceMode === 'files'
      ? 'Reference Study reads supplied files only'
      : models.researchModel
        ? `${models.researchModel} (${models.researchEffort}) researchers fanned out`
        : 'no fan-out'
  const assets = models.assetModel
    ? `${models.assetModel} (${models.assetEffort}) sculptors, one per cast entry`
    : 'no asset phase'
  return `Implementer: ${impl} · Critic: ${harnessFor(models.criticModel)} ${models.criticModel} (${models.criticEffort}), fresh eyes every round. · Research: ${research}. · Assets: ${assets}.`
}
