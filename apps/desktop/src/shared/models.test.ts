import { describe, expect, it } from 'vitest'
import {
  clampEffort,
  DEFAULT_ASSET,
  DEFAULT_CRITIC,
  DEFAULT_IMPLEMENTER,
  describeCritic,
  effortsForModel,
  harnessFor,
  modelFamily,
  newRunOrchestratorEffort,
  normalizeModels,
  orchestratorEfforts,
  resolveModels,
} from './models'

describe('defaults', () => {
  it('starts on Opus 5 at high over Opus 5 subagents', () => {
    const models = resolveModels(DEFAULT_IMPLEMENTER, { criticModel: 'claude-opus-5', criticEffort: 'high' })
    expect(models.orchestratorModel).toBe('claude-opus-5')
    expect(models.orchestratorEffort).toBe('high')
    expect(harnessFor(models.criticModel)).toBe('claude')
  })

  it('falls back to the defaults when the form sends nothing usable', () => {
    expect(resolveModels(null, { criticModel: 'nope', criticEffort: 'nope' })).toEqual(resolveModels(DEFAULT_IMPLEMENTER, DEFAULT_CRITIC))
  })

  it('carries a solo orchestrator through with no subagent model', () => {
    const models = resolveModels({ ...DEFAULT_IMPLEMENTER, subagentModel: null, orchestratorEffort: 'high' }, DEFAULT_CRITIC)
    expect(models.subagentModel).toBeNull()
    expect(models.orchestratorEffort).toBe('high')
  })
})

describe('resolveModels', () => {
  it('keeps any valid combination of the four fields', () => {
    const models = resolveModels(
      { orchestratorModel: 'claude-fable-5', orchestratorEffort: 'max', subagentModel: 'claude-sonnet-5', subagentEffort: 'low' },
      DEFAULT_CRITIC,
    )
    expect(models.orchestratorModel).toBe('claude-fable-5')
    expect(models.orchestratorEffort).toBe('max')
    expect(models.subagentEffort).toBe('low')
  })

  it('keeps a codex subagent pick, which only the subagent slot offers', () => {
    const models = resolveModels({ ...DEFAULT_IMPLEMENTER, subagentModel: 'gpt-5.6-sol' }, DEFAULT_CRITIC)
    expect(models.subagentModel).toBe('gpt-5.6-sol')
    expect(models.orchestratorModel).toBe('claude-opus-5')
  })

  it('rejects a model no CLI offers', () => {
    expect(resolveModels({ orchestratorModel: 'gpt-4' }, DEFAULT_CRITIC).orchestratorModel).toBe('claude-opus-5')
  })

  it('lets codex orchestrate, and swaps in an effort level codex accepts', () => {
    const models = resolveModels({ orchestratorModel: 'gpt-5.6-sol', orchestratorEffort: 'ultra' }, DEFAULT_CRITIC)
    expect(models.orchestratorModel).toBe('gpt-5.6-sol')
    expect(models.orchestratorEffort).toBe('ultra')
    // `ultracode` is claude's fan-out level; codex would reject it.
    expect(resolveModels({ orchestratorModel: 'gpt-5.6-sol', orchestratorEffort: 'ultracode' }, DEFAULT_CRITIC).orchestratorEffort).toBe('high')
    expect(resolveModels({ orchestratorModel: 'claude-opus-5', orchestratorEffort: 'ultra' }, DEFAULT_CRITIC).orchestratorEffort).toBe('high')
  })

  it('rejects effort levels the CLI would not accept', () => {
    const models = resolveModels({ orchestratorEffort: 'bogus', subagentEffort: 'ultracode' }, DEFAULT_CRITIC)
    expect(models.orchestratorEffort).toBe('high')
    expect(models.subagentEffort).toBe('high')
  })

  it('defaults research fan-out to cheap codex luna at medium effort', () => {
    const models = resolveModels(DEFAULT_IMPLEMENTER, DEFAULT_CRITIC)
    expect(models.researchModel).toBe('gpt-5.6-luna')
    expect(models.researchEffort).toBe('medium')
  })

  it('lets the form turn research fan-out off or repoint it', () => {
    expect(resolveModels(null, null, { researchModel: null }).researchModel).toBeNull()
    expect(resolveModels(null, null, { researchModel: 'none' }).researchModel).toBeNull()
    const models = resolveModels(null, null, { researchModel: 'claude-sonnet-5', researchEffort: 'low' })
    expect(models.researchModel).toBe('claude-sonnet-5')
    expect(models.researchEffort).toBe('low')
    expect(resolveModels(null, null, { researchModel: 'gpt-4', researchEffort: 'bogus' })).toMatchObject({
      researchModel: 'gpt-5.6-luna',
      researchEffort: 'medium',
    })
  })
})

describe('normalizeModels', () => {
  it('turns a stored ultracode flag into the ultracode effort level', () => {
    const models = normalizeModels({
      orchestratorModel: 'claude-fable-5',
      subagentModel: 'claude-opus-5',
      subagentEffort: 'medium',
      ultracode: true,
    })
    expect(models.orchestratorEffort).toBe('ultracode')
    expect(models.subagentModel).toBe('claude-opus-5')
  })

  it('fills in the picker fields a pre-picker ledger row lacks', () => {
    const models = normalizeModels({
      orchestratorModel: 'claude-fable-5',
      orchestratorEffort: 'high',
      subagentModel: 'opus',
      subagentEffort: 'medium',
      criticModel: 'gpt-5.6-sol',
      criticEffort: 'medium',
    })
    expect(models.orchestratorModel).toBe('claude-fable-5')
    expect(harnessFor(models.criticModel)).toBe('codex')
    expect(models.criticModel).toBe('gpt-5.6-sol')
  })

  it('infers a claude critic harness from a claude critic model', () => {
    expect(harnessFor(normalizeModels({ criticModel: 'claude-opus-5', criticEffort: 'high' }).criticModel)).toBe('claude')
  })
})

describe('normalizeModels critic harness', () => {
  it('reads the harness off the model name when no preset matches', () => {
    const models = normalizeModels({ criticModel: 'claude-opus-5', criticEffort: 'max' })
    expect(harnessFor(models.criticModel)).toBe('claude')
    expect(models.criticModel).toBe('claude-opus-5')
  })

  it('gives sculptors the subagent default, not the critic pick or the cheap research tier', () => {
    const models = resolveModels(DEFAULT_IMPLEMENTER, DEFAULT_CRITIC)
    expect(models.assetModel).toBe('claude-opus-5')
    expect(models.assetEffort).toBe('high')
  })

  it('keeps the asset phase off when the operator turned it off', () => {
    expect(resolveModels(DEFAULT_IMPLEMENTER, DEFAULT_CRITIC, null, { assetModel: null }).assetModel).toBeNull()
    expect(resolveModels(DEFAULT_IMPLEMENTER, DEFAULT_CRITIC, null, { assetModel: 'none' }).assetModel).toBeNull()
  })

  it('clamps an asset pick the CLIs would refuse', () => {
    const models = resolveModels(DEFAULT_IMPLEMENTER, DEFAULT_CRITIC, null, { assetModel: 'gpt-4', assetEffort: 'ultracode' })
    expect(models.assetModel).toBe('claude-opus-5')
    // Sculptors are workers, so the orchestrator-only effort levels do not apply.
    expect(models.assetEffort).toBe('high')
  })

  it('runs the phase for a loop written before it existed, rather than reading silence as off', () => {
    expect(normalizeModels({ criticModel: 'claude-opus-5' }).assetModel).toBe('claude-opus-5')
  })

  it('keeps the phase off for a loop that stored it off', () => {
    expect(normalizeModels({ criticModel: 'claude-opus-5', assetModel: null }).assetModel).toBeNull()
  })

  it('ignores a stale stored critic harness and derives it from the model', () => {
    expect(harnessFor(normalizeModels({ criticHarness: 'claude', criticModel: 'gpt-5.6-sol' }).criticModel)).toBe('codex')
  })

  it('does not preserve malformed model ids or effort values from stored JSON', () => {
    const models = normalizeModels({
      orchestratorModel: { startsWith: 'not a function' } as unknown as string,
      orchestratorEffort: '../ultra',
      criticModel: '../../binary',
      criticEffort: { value: 'max' } as unknown as string,
    })
    expect(models).toMatchObject({
      orchestratorModel: DEFAULT_IMPLEMENTER.orchestratorModel,
      orchestratorEffort: DEFAULT_IMPLEMENTER.orchestratorEffort,
      criticModel: DEFAULT_CRITIC.criticModel,
      criticEffort: DEFAULT_CRITIC.criticEffort,
    })
    expect(() => harnessFor(models.orchestratorModel)).not.toThrow()
  })

  it('preserves bounded historical worker and research model ids', () => {
    const models = normalizeModels({
      ...resolveModels({}, {}, {}),
      subagentModel: 'gpt-5.5-retired',
      researchModel: 'claude-research-retired-2025',
    })

    expect(models.subagentModel).toBe('gpt-5.5-retired')
    expect(models.researchModel).toBe('claude-research-retired-2025')
  })

  it('does not project credential-shaped provider model ids from stored JSON', () => {
    const token = `ghp_${'a'.repeat(36)}`
    const models = normalizeModels({
      ...resolveModels({}, {}, {}),
      orchestratorModel: `gpt-${token}`,
      subagentModel: `claude-${token}`,
    })

    expect(models.orchestratorModel).toBe(DEFAULT_IMPLEMENTER.orchestratorModel)
    expect(models.subagentModel).toBe(DEFAULT_IMPLEMENTER.subagentModel)
    expect(JSON.stringify(models)).not.toContain(token)
  })
})

describe('the harness/model split', () => {
  it('stores a harness for every role, taken from the picker rather than the model name', () => {
    const models = resolveModels(
      { orchestratorModel: 'claude-opus-5', subagentModel: 'gpt-5.6-sol' },
      { criticModel: 'grok-4.6' },
      { researchModel: 'gpt-5.6-luna' },
    )
    expect(models.orchestratorHarness).toBe('claude')
    expect(models.subagentHarness).toBe('codex')
    expect(models.criticHarness).toBe('grok')
    expect(models.researchHarness).toBe('codex')
  })

  it('leaves the harness null for a role that is turned off', () => {
    const models = resolveModels({ subagentModel: null }, null, { researchModel: null })
    expect(models.subagentHarness).toBeNull()
    expect(models.researchHarness).toBeNull()
  })

  /**
   * The path that matters: `resumeLoop` reads these fields to decide which
   * binary to spawn, so a row written before the harness was stored must still
   * come back pointing at the right CLI.
   */
  it('recovers the harness of a row written before the split', () => {
    const legacy = normalizeModels({
      orchestratorModel: 'gpt-5.6-sol',
      orchestratorEffort: 'high',
      subagentModel: 'claude-opus-5',
      subagentEffort: 'high',
      criticModel: 'claude-fable-5',
      criticEffort: 'medium',
      researchModel: 'gpt-5.6-luna',
      researchEffort: 'medium',
    })
    expect(legacy.orchestratorHarness).toBe('codex')
    expect(legacy.subagentHarness).toBe('claude')
    expect(legacy.criticHarness).toBe('claude')
    expect(legacy.researchHarness).toBe('codex')
  })

  it('prefers a stored harness over what the model name would suggest', () => {
    const models = normalizeModels({
      orchestratorHarness: 'grok',
      orchestratorModel: 'claude-opus-5',
      criticModel: 'gpt-5.6-sol',
    })
    expect(models.orchestratorHarness).toBe('grok')
  })
})

describe('per-harness efforts', () => {
  it('does not offer grok an effort its CLI refuses, per model', () => {
    expect(effortsForModel('grok-4.6')).not.toContain('max')
    expect(effortsForModel('claude-opus-5')).toContain('max')
    // grok-4.5 stops a level lower than grok-4.6 — the CLI names the set it takes.
    expect(effortsForModel('grok-4.6')).toContain('xhigh')
    expect(effortsForModel('grok-4.5')).not.toContain('xhigh')
    expect(orchestratorEfforts('grok-4.5')).not.toContain('xhigh')
  })

  it('clamps a carried-over effort to what the new model accepts', () => {
    expect(clampEffort(effortsForModel('grok-4.6'), 'max')).toBe('high')
    expect(clampEffort(effortsForModel('claude-opus-5'), 'max')).toBe('max')
  })

  it('offers grok no orchestrator fan-out level, and withholds ultra from luna', () => {
    expect(orchestratorEfforts('grok-4.6')).not.toContain('ultracode')
    expect(orchestratorEfforts('gpt-5.6-sol')).toContain('ultra')
    expect(orchestratorEfforts('gpt-5.6-luna')).not.toContain('ultra')
  })

  it('falls back to the role default when a stored effort is one the harness refuses', () => {
    expect(resolveModels(null, { criticModel: 'grok-4.6', criticEffort: 'max' }, null).criticEffort).toBe('medium')
    expect(resolveModels(null, { criticModel: 'grok-4.6', criticEffort: 'xhigh' }, null).criticEffort).toBe('xhigh')
  })
})

describe('describeCritic', () => {
  it('judges lineage by the model, not the CLI running it', () => {
    expect(describeCritic('grok-4.6', 'claude-opus-5')).toContain('different model family')
    expect(describeCritic('claude-opus-5', 'claude-fable-5')).toContain('Same model family')
    expect(modelFamily('openai/gpt-5.6-sol')).toBe('openai')
  })
})

describe('the asset role', () => {
  it('stores its harness like every other role', () => {
    const models = resolveModels(null, null, null, { assetModel: 'grok-4.6', assetEffort: 'high' })
    expect(models.assetHarness).toBe('grok')
    expect(resolveModels(null, null, null, { assetModel: null }).assetHarness).toBeNull()
  })

  /**
   * The asset phase shipped after the harness split, so its rows carry a model
   * but no harness. `executeAssets` reads the harness to pick a binary, so a
   * missed fallback would spawn the wrong CLI on an old run.
   */
  it('recovers the harness of a row written before the field existed', () => {
    const legacy = normalizeModels({ orchestratorModel: 'claude-opus-5', assetModel: 'gpt-5.6-sol', assetEffort: 'high' })
    expect(legacy.assetHarness).toBe('codex')
  })

  it('leaves the phase off when a row stored it off, and defaults when the key predates it', () => {
    expect(normalizeModels({ orchestratorModel: 'claude-opus-5', assetModel: null }).assetHarness).toBeNull()
    // No assetModel key at all means the row predates the phase: take the default.
    const older = normalizeModels({ orchestratorModel: 'claude-opus-5' })
    expect(older.assetModel).toBe(DEFAULT_ASSET.assetModel)
    expect(older.assetHarness).toBe('claude')
  })
})

describe('Astra', () => {
  it('preserves Astra in every role through resolution and persistence', () => {
    const models = resolveModels(
      { orchestratorModel: 'gpt-6-astra', orchestratorEffort: 'ultra', subagentModel: 'gpt-6-astra', subagentEffort: 'max' },
      { criticModel: 'gpt-6-astra', criticEffort: 'high' },
      { researchModel: 'gpt-6-astra', researchEffort: 'medium' },
      { assetModel: 'gpt-6-astra', assetEffort: 'high' },
    )
    for (const role of ['orchestratorModel', 'subagentModel', 'criticModel', 'researchModel', 'assetModel'] as const) {
      expect(models[role]).toBe('gpt-6-astra')
      expect(normalizeModels(models)[role]).toBe('gpt-6-astra')
    }
    expect(harnessFor(models.orchestratorModel)).toBe('codex')
    expect(models.orchestratorEffort).toBe('ultra')
  })
})


it.each([['ultra', 'gpt-6-astra', 'max'], ['ultracode', 'claude-opus-5', 'xhigh']])('preserves historical %s but removes automatic delegation from copied drafts', (effort, model, copied) => {
  expect(normalizeModels({ orchestratorModel: model, orchestratorEffort: effort }).orchestratorEffort).toBe(effort)
  expect(newRunOrchestratorEffort(effort)).toBe(copied)
})
