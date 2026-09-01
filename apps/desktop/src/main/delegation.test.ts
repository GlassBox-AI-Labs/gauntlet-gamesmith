import { describe, expect, it } from 'vitest'
import { resolveModels } from '../shared/models'
import { delegationRules, implementerAgentMd } from './delegation'

const models = (orchestratorModel: string, subagentModel: string | null) =>
  resolveModels({ orchestratorModel, subagentModel, subagentEffort: 'high' }, null)

describe('implementerAgentMd', () => {
  it('names the worker model directly when both sides are claude', () => {
    const md = implementerAgentMd(models('claude-fable-5', 'claude-opus-5'))!
    expect(md).toContain('model: claude-opus-5')
    expect(md).toContain('effort: high')
  })

  it('fronts a codex worker with a cheap dispatcher that must not background the child', () => {
    const md = implementerAgentMd(models('claude-fable-5', 'gpt-5.6-sol'))!
    expect(md).toContain('model: claude-sonnet-5')
    expect(md).toContain('Do NOT use `run_in_background`')
    // The child's stream has to land where the app reads tokens from.
    expect(md).toContain('> .gauntlet-loop/agents/<slug>.codex.jsonl')
    expect(md).toContain(`'-m' 'gpt-5.6-sol'`)
  })

  it('writes no agent file when codex orchestrates — its rules ride in the prompt', () => {
    expect(implementerAgentMd(models('gpt-5.6-sol', 'claude-opus-5'))).toBeNull()
  })
})

describe('delegationRules', () => {
  it('tells a codex orchestrator to override the model per spawn, which needs a bare fork', () => {
    const rules = delegationRules(models('gpt-5.6-sol', 'gpt-5.6-luna'))
    expect(rules).toContain('spawn_agent')
    expect(rules).toContain('model="gpt-5.6-luna"')
    // The override is refused on a full-history fork — verified against the CLI.
    expect(rules).toContain('fork_turns="none"')
  })

  it('tells a codex orchestrator how to run claude workers and capture them', () => {
    const rules = delegationRules(models('gpt-5.6-sol', 'claude-opus-5'))
    expect(rules).toContain('claude ')
    expect(rules).toContain(`'--model' 'claude-opus-5'`)
    expect(rules).toContain('> .gauntlet-loop/agents/<slug>.claude.jsonl')
  })

  it('keeps the orchestrator off game source once slices are out, in every delegated pairing', () => {
    for (const pair of [
      ['claude-fable-5', 'claude-opus-5'],
      ['claude-fable-5', 'gpt-5.6-sol'],
      ['gpt-5.6-sol', 'gpt-5.6-luna'],
      ['gpt-5.6-sol', 'claude-opus-5'],
    ] as const) {
      const rules = delegationRules(models(pair[0], pair[1]))
      expect(rules).toContain('must NOT edit game source yourself')
      expect(rules).toContain('scaffold')
    }
  })

  it('leaves a solo run free to edit — there is nobody to delegate to', () => {
    expect(delegationRules(models('claude-opus-5', null))).not.toContain('must NOT edit game source')
  })

  it('keeps the solo run free of delegation', () => {
    expect(delegationRules(models('claude-opus-5', null))).toContain('do NOT delegate')
  })
})
