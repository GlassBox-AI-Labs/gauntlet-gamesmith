import { describe, expect, it } from 'vitest'
import { DEFAULT_CRITIC, DEFAULT_IMPLEMENTER, normalizeModels, resolveModels } from './models'

describe('defaults', () => {
  it('starts on Opus 5 at ultracode over Opus 5 subagents', () => {
    const models = resolveModels(DEFAULT_IMPLEMENTER, { criticModel: 'claude-opus-5', criticEffort: 'high' })
    expect(models.orchestratorModel).toBe('claude-opus-5')
    expect(models.orchestratorEffort).toBe('ultracode')
    expect(models.criticHarness).toBe('claude')
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
    expect(resolveModels({ orchestratorModel: 'claude-opus-5', orchestratorEffort: 'ultra' }, DEFAULT_CRITIC).orchestratorEffort).toBe('ultracode')
  })

  it('rejects effort levels the CLI would not accept', () => {
    const models = resolveModels({ orchestratorEffort: 'bogus', subagentEffort: 'ultracode' }, DEFAULT_CRITIC)
    expect(models.orchestratorEffort).toBe('ultracode')
    expect(models.subagentEffort).toBe('high')
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
    expect(models.criticHarness).toBe('codex')
    expect(models.criticModel).toBe('gpt-5.6-sol')
  })

  it('infers a claude critic harness from a claude critic model', () => {
    expect(normalizeModels({ criticModel: 'claude-opus-5', criticEffort: 'high' }).criticHarness).toBe('claude')
  })
})

describe('normalizeModels critic harness', () => {
  it('reads the harness off the model name when no preset matches', () => {
    const models = normalizeModels({ criticModel: 'claude-opus-5', criticEffort: 'max' })
    expect(models.criticHarness).toBe('claude')
    expect(models.criticModel).toBe('claude-opus-5')
  })
})
