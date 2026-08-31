import type { HarnessKind } from './harness'
import type { LoopModels } from './loop'

/**
 * Effort levels the claude CLI accepts. `ultracode` is not in `--help` and not
 * in the CLI's own "valid values" warning, but v2.1.203+ accepts it: it sends
 * xhigh to the model AND turns on automatic workflow orchestration. Verified on
 * v2.1.231 — an unknown value warns, `ultracode` does not.
 */
export const ORCHESTRATOR_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode'] as const
/** Subagent effort is per-agent, so the session-level `ultracode` has no meaning here. */
export const SUBAGENT_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const

export interface ModelChoice {
  id: string
  label: string
}

/** All three support xhigh, so `ultracode` is available whichever one orchestrates. */
export const MODEL_CHOICES: readonly ModelChoice[] = [
  { id: 'claude-opus-5', label: 'Opus 5' },
  { id: 'claude-fable-5', label: 'Fable 5' },
  { id: 'claude-sonnet-5', label: 'Sonnet 5' },
]

export const SOLO_SUBAGENT = 'none'

/** The four fields the run form actually sets for the implementation side. */
export interface ImplementerFields {
  orchestratorModel: string
  orchestratorEffort: string
  subagentModel: string | null
  subagentEffort: string
}

export interface CriticPreset {
  id: string
  label: string
  detail: string
  harness: HarnessKind
  model: string
  effort: string
}

/** Where the run form starts: the combination worth reaching for by default. */
export const DEFAULT_IMPLEMENTER: ImplementerFields = {
  orchestratorModel: 'claude-opus-5',
  orchestratorEffort: 'ultracode',
  subagentModel: 'claude-opus-5',
  subagentEffort: 'high',
}

export const CRITICS: readonly CriticPreset[] = [
  {
    id: 'codex-sol-medium',
    label: 'Codex · gpt-5.6-sol (medium)',
    detail: 'A different model family from the implementer, so the critic has no attachment to the code.',
    harness: 'codex',
    model: 'gpt-5.6-sol',
    effort: 'medium',
  },
  {
    id: 'codex-sol-high',
    label: 'Codex · gpt-5.6-sol (high)',
    detail: 'Same critic, more reasoning per round — slower and dearer, but harder to fool.',
    harness: 'codex',
    model: 'gpt-5.6-sol',
    effort: 'high',
  },
  {
    id: 'claude-opus-high',
    label: 'Claude · Opus 5 (high)',
    detail: 'Strongest Claude critic. Same family as the implementer, so expect a friendlier grader.',
    harness: 'claude',
    model: 'claude-opus-5',
    effort: 'high',
  },
  {
    id: 'claude-fable-high',
    label: 'Claude · Fable 5 (high)',
    detail: 'Claude critic on the Fable model. Same family as the implementer.',
    harness: 'claude',
    model: 'claude-fable-5',
    effort: 'high',
  },
  {
    id: 'claude-sonnet-medium',
    label: 'Claude · Sonnet 5 (medium)',
    detail: 'Cheapest critic. Good for long cheap loops, weaker at spotting subtle visual shortfalls.',
    harness: 'claude',
    model: 'claude-sonnet-5',
    effort: 'medium',
  },
]

export const DEFAULT_CRITIC_ID = CRITICS[0].id

export function findCritic(id: string | null | undefined): CriticPreset {
  return CRITICS.find((p) => p.id === id) ?? CRITICS[0]
}

export function modelLabel(id: string | null | undefined): string {
  return MODEL_CHOICES.find((m) => m.id === id)?.label ?? id ?? 'none'
}

/** Ultracode is an orchestrator effort level, not a separate switch. */
export function isUltracode(models: Pick<LoopModels, 'orchestratorEffort'>): boolean {
  return models.orchestratorEffort === 'ultracode'
}

function pick<T extends string>(allowed: readonly T[], value: string | null | undefined, fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback
}

/** Clamp whatever the form sent to values the CLIs actually accept. */
export function resolveModels(fields: Partial<ImplementerFields> | null | undefined, criticId: string | null | undefined): LoopModels {
  const base = DEFAULT_IMPLEMENTER
  const critic = findCritic(criticId)
  const subagentModel =
    fields?.subagentModel === null || fields?.subagentModel === SOLO_SUBAGENT
      ? null
      : MODEL_CHOICES.some((m) => m.id === fields?.subagentModel)
        ? fields!.subagentModel!
        : base.subagentModel
  const resolved: ImplementerFields = {
    orchestratorModel: MODEL_CHOICES.some((m) => m.id === fields?.orchestratorModel)
      ? fields!.orchestratorModel!
      : base.orchestratorModel,
    orchestratorEffort: pick(ORCHESTRATOR_EFFORTS, fields?.orchestratorEffort, base.orchestratorEffort as 'ultracode'),
    subagentModel,
    subagentEffort: pick(SUBAGENT_EFFORTS, fields?.subagentEffort, base.subagentEffort as 'high'),
  }
  return {
    ...resolved,
    criticId: critic.id,
    criticHarness: critic.harness,
    criticModel: critic.model,
    criticEffort: critic.effort,
  }
}

/**
 * Older ledger rows predate these fields. Older still are rows written before
 * ultracode moved from a prompt keyword to an effort level — those carry an
 * `ultracode: true` boolean, which becomes the ultracode effort here.
 */
export function normalizeModels(raw: (Partial<LoopModels> & { ultracode?: boolean }) | null | undefined): LoopModels {
  if (!raw) return resolveModels(DEFAULT_IMPLEMENTER, DEFAULT_CRITIC_ID)
  const criticId =
    raw.criticId ?? CRITICS.find((c) => c.model === raw.criticModel && c.effort === raw.criticEffort)?.id ?? DEFAULT_CRITIC_ID
  const models = resolveModels(
    {
      orchestratorModel: raw.orchestratorModel,
      orchestratorEffort: raw.ultracode && !raw.orchestratorEffort ? 'ultracode' : raw.orchestratorEffort,
      subagentModel: raw.subagentModel,
      subagentEffort: raw.subagentEffort,
    },
    criticId,
  )
  // Keep a model name a preset no longer offers rather than silently retitling
  // an old run, but only where it is still a name the CLI would accept.
  const criticModel = raw.criticModel ?? models.criticModel
  return {
    ...models,
    orchestratorModel: raw.orchestratorModel ?? models.orchestratorModel,
    // A stored model name the preset list no longer matches must still spawn on
    // the right CLI, so fall back to reading the harness off the model name.
    criticHarness: raw.criticHarness ?? (criticModel.startsWith('claude') ? 'claude' : models.criticHarness),
    criticModel,
    criticEffort: raw.criticEffort ?? models.criticEffort,
  }
}

/** One plain sentence naming who builds and who judges — used in logs and the report. */
export function describeModels(models: LoopModels): string {
  const impl = models.subagentModel
    ? `${models.orchestratorModel} (${models.orchestratorEffort}) orchestrating ${models.subagentModel} (${models.subagentEffort}) subagents`
    : `${models.orchestratorModel} (${models.orchestratorEffort}) solo, no subagents`
  return `Implementer: ${impl} · Critic: ${models.criticHarness} ${models.criticModel} (${models.criticEffort}), fresh eyes every round.`
}
