import { describe, expect, it } from 'vitest'
import { harnessFor, resolveModels } from './models'
import { DEFAULT_RUN_PACE, RUN_PACES, runPreset, type RunPace } from './run-presets'

const levels: RunPace[] = [0, 1, 2, 3, 4]

describe('five run presets', () => {
  it('defaults to Balanced and applies the agreed mixed-provider configurations', () => {
    expect(RUN_PACES[DEFAULT_RUN_PACE]).toBe('Balanced')
    expect(levels.map((level) => {
      const preset = runPreset(level, { claude: true, codex: true }, true)
      return [preset.orchestratorModel, preset.subagentModel, preset.criticModel, preset.orchestratorEffort, preset.researchModel, preset.assetModel]
    })).toEqual([
      ['claude-sonnet-5', null, 'gpt-5.6-luna', 'medium', null, 'claude-sonnet-5'],
      ['claude-opus-5', 'claude-sonnet-5', 'gpt-5.6-terra', 'medium', 'gpt-5.6-luna', 'claude-sonnet-5'],
      ['claude-opus-5', 'claude-sonnet-5', 'gpt-5.6-sol', 'high', 'gpt-5.6-luna', 'claude-sonnet-5'],
      ['claude-fable-5-1', 'claude-opus-5', 'gpt-6-astra', 'high', 'gpt-5.6-sol', 'claude-opus-5'],
      ['claude-fable-5-1', 'claude-fable-5-1', 'gpt-6-astra', 'max', 'gpt-5.6-sol', 'claude-fable-5-1'],
    ])
  })

  it.each(['claude', 'codex'] as const)('uses only %s when it is the only connected provider', (provider) => {
    for (const level of levels) {
      const preset = runPreset(level, { claude: provider === 'claude', codex: provider === 'codex' }, true)
      for (const role of ['orchestratorModel', 'subagentModel', 'criticModel', 'researchModel', 'assetModel'] as const) {
        if (preset[role]) expect(harnessFor(preset[role])).toBe(provider)
      }
      expect(resolveModels(preset, preset, preset, preset)).toMatchObject(preset)
    }
  })

  it('preserves disabled sculpting and never overrides reference mode, rounds or budget', () => {
    for (const level of levels) {
      const preset = runPreset(level, { claude: true, codex: true }, false)
      expect(preset.assetModel).toBeNull()
      expect(preset).not.toHaveProperty('referenceMode')
      expect(preset).not.toHaveProperty('maxRounds')
      expect(preset).not.toHaveProperty('budgetUsd')
      for (const referenceMode of ['skip', 'files'] as const) {
        const effective = resolveModels({ ...preset, referenceMode }, preset, preset, preset)
        expect(effective.referenceMode).toBe(referenceMode)
        expect(effective.researchModel).toBeNull()
      }
    }
  })
})
