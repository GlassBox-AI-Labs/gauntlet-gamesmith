import { describe, expect, it } from 'vitest'
import { DEFAULT_IMPLEMENTER, normalizeModels, resolveModels } from './models'

describe('defaults', () => {
  it('starts on Opus 5 at ultracode over Opus 5 subagents', () => {
    const models = resolveModels(DEFAULT_IMPLEMENTER, 'claude-opus-high')
    expect(models.orchestratorModel).toBe('claude-opus-5')
    expect(models.orchestratorEffort).toBe('ultracode')
    expect(models.criticHarness).toBe('claude')
  })

  it('falls back to the defaults when the form sends nothing usable', () => {
    expect(resolveModels(null, 'nope')).toEqual(resolveModels(DEFAULT_IMPLEMENTER, 'codex-sol-medium'))
  })

  it('carries a solo orchestrator through with no subagent model', () => {
    const models = resolveModels({ ...DEFAULT_IMPLEMENTER, subagentModel: null, orchestratorEffort: 'high' }, 'codex-sol-medium')
    expect(models.subagentModel).toBeNull()
    expect(models.orchestratorEffort).toBe('high')
  })
})

describe('resolveModels', () => {
  it('keeps any valid combination of the four fields', () => {
    const models = resolveModels(
      { orchestratorModel: 'claude-fable-5', orchestratorEffort: 'max', subagentModel: 'claude-sonnet-5', subagentEffort: 'low' },
      'codex-sol-medium',
    )
    expect(models.orchestratorModel).toBe('claude-fable-5')
    expect(models.orchestratorEffort).toBe('max')
    expect(models.subagentEffort).toBe('low')
  })

  it('rejects a model the CLI list does not offer', () => {
    expect(resolveModels({ orchestratorModel: 'gpt-5.6-sol' }, 'codex-sol-medium').orchestratorModel).toBe('claude-opus-5')
  })

  it('rejects effort levels the CLI would not accept', () => {
    const models = resolveModels({ orchestratorEffort: 'bogus', subagentEffort: 'ultracode' }, 'codex-sol-medium')
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
    expect(models.criticId).toBe('codex-sol-medium')
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
