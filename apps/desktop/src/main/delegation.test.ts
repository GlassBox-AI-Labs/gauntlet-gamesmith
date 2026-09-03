import { describe, expect, it } from 'vitest'
import { resolveModels } from '../shared/models'
import { delegationRules, implementerAgentMd, researchRules, sculptorAgentMd, sculptorRules } from './delegation'

const models = (orchestratorModel: string, subagentModel: string | null) =>
  resolveModels({ orchestratorModel, subagentModel, subagentEffort: 'high' }, null)

describe('implementerAgentMd', () => {
  it('names the worker model directly when both sides are claude', () => {
    const md = implementerAgentMd(models('claude-fable-5', 'claude-opus-5'), 'reference/loop-123')!
    expect(md).toContain('model: claude-opus-5')
    expect(md).toContain('effort: high')
    expect(md).toContain('read reference/loop-123/README.md')
    expect(md).toContain('reference/loop-123/research.md')
    expect(md).toContain('progression classification, story beats, and difficulty curve')
  })

  it('fronts a codex worker with a cheap dispatcher that must not background the child', () => {
    const md = implementerAgentMd(models('claude-fable-5', 'gpt-5.6-sol'), 'reference/loop-123')!
    expect(md).toContain('model: claude-sonnet-5')
    expect(md).toContain('Do NOT use `run_in_background`')
    // The child's stream has to land where the app reads tokens from.
    expect(md).toContain('> .gauntlet-gamesmith/agents/<slug>.codex.jsonl')
    expect(md).toContain(`'-m' 'gpt-5.6-sol'`)
  })

  it('writes no agent file when codex orchestrates — its rules ride in the prompt', () => {
    expect(implementerAgentMd(models('gpt-5.6-sol', 'claude-opus-5'), 'reference/loop-123')).toBeNull()
  })
})

describe('delegationRules', () => {
  it('tells a codex orchestrator to override the model per spawn, which needs a bare fork', () => {
    const rules = delegationRules(models('gpt-5.6-sol', 'gpt-5.6-luna'), 'reference/loop-123')
    expect(rules).toContain('spawn_agent')
    expect(rules).toContain('model="gpt-5.6-luna"')
    // The override is refused on a full-history fork — verified against the CLI.
    expect(rules).toContain('fork_turns="none"')
  })

  it('tells a codex orchestrator how to run claude workers and capture them', () => {
    const rules = delegationRules(models('gpt-5.6-sol', 'claude-opus-5'), 'reference/loop-123')
    expect(rules).toContain('claude ')
    expect(rules).toContain(`'--model' 'claude-opus-5'`)
    expect(rules).toContain('> .gauntlet-gamesmith/agents/<slug>.claude.jsonl')
  })

  it('keeps the orchestrator off game source once slices are out, in every delegated pairing', () => {
    for (const pair of [
      ['claude-fable-5', 'claude-opus-5'],
      ['claude-fable-5', 'gpt-5.6-sol'],
      ['gpt-5.6-sol', 'gpt-5.6-luna'],
      ['gpt-5.6-sol', 'claude-opus-5'],
    ] as const) {
      const rules = delegationRules(models(pair[0], pair[1]), 'reference/loop-123')
      expect(rules).toContain('must NOT edit game source yourself')
      expect(rules).toContain('scaffold')
      expect(rules).toContain('reference/loop-123/README.md')
      expect(rules).toContain('reference/loop-123/research.md')
      expect(rules).toContain('story, difficulty, level/progression, and gameplay workers')
    }
  })

  it('leaves a solo run free to edit — there is nobody to delegate to', () => {
    expect(delegationRules(models('claude-opus-5', null), 'reference/loop-123')).not.toContain('must NOT edit game source')
  })

  it('keeps the solo run free of delegation', () => {
    expect(delegationRules(models('claude-opus-5', null), 'reference/loop-123')).toContain('do NOT delegate')
  })
})

describe('researchRules', () => {
  it('fans researchers out as CLI children whose streams the app can price', () => {
    const rules = researchRules(models('claude-opus-5', null), 'reference/loop-123')
    expect(rules).toContain('gpt-5.6-luna at medium effort')
    expect(rules).toContain(`'-m' 'gpt-5.6-luna'`)
    expect(rules).toContain('> .gauntlet-gamesmith/agents/<slug>.codex.jsonl')
    expect(rules).toContain('reference/loop-123/research/<slug>.md')
    expect(rules).toContain('reference/loop-123/research.md')
    expect(rules).toContain('never touch project source')
  })

  it('routes claude researchers through the claude CLI', () => {
    const base = models('gpt-5.6-sol', null)
    const rules = researchRules({ ...base, researchModel: 'claude-sonnet-5', researchEffort: 'low' }, 'reference/loop-123')
    expect(rules).toContain(`'--model' 'claude-sonnet-5'`)
    expect(rules).toContain('> .gauntlet-gamesmith/agents/<slug>.claude.jsonl')
  })

  it('keeps the sweep in-agent when fan-out is off', () => {
    const base = models('claude-opus-5', null)
    const rules = researchRules({ ...base, researchModel: null }, 'reference/loop-123')
    expect(rules).toContain('do NOT spawn researcher subagents')
  })
})

const sculptors = (orchestratorModel: string, assetModel: string | null) =>
  resolveModels({ orchestratorModel }, null, null, { assetModel, assetEffort: 'high' })

describe('sculptorAgentMd', () => {
  it('names the sculptor model directly when both sides are claude', () => {
    const md = sculptorAgentMd(sculptors('claude-fable-5', 'claude-opus-5'), 'reference/loop-1')!
    expect(md).toContain('name: sculptor')
    expect(md).toContain('model: claude-opus-5')
    expect(md).toContain('effort: high')
  })

  it('fronts a codex sculptor with a cheap dispatcher that must not background the child', () => {
    const md = sculptorAgentMd(sculptors('claude-fable-5', 'gpt-5.6-sol'), 'reference/loop-1')!
    expect(md).toContain('model: claude-sonnet-5')
    expect(md).toContain('effort: low')
    expect(md).toContain('run_in_background')
    // The brief has to stand alone: codex starts with no memory of the run.
    expect(md).toContain('tools/crop.py')
  })

  it('writes no agent file when there is no asset phase or codex orchestrates', () => {
    expect(sculptorAgentMd(sculptors('claude-fable-5', null), 'reference/loop-1')).toBeNull()
    expect(sculptorAgentMd(sculptors('gpt-5.6-sol', 'claude-opus-5'), 'reference/loop-1')).toBeNull()
  })
})

describe('sculptorRules', () => {
  it('holds every pairing to one sculptor per entry, launched together', () => {
    for (const [orchestrator, worker] of [
      ['claude-fable-5', 'claude-opus-5'],
      ['claude-fable-5', 'gpt-5.6-sol'],
      ['gpt-5.6-sol', 'claude-opus-5'],
      ['gpt-5.6-sol', 'gpt-5.6-terra'],
    ] as const) {
      const rules = sculptorRules(sculptors(orchestrator, worker), 'reference/loop-1')
      expect(rules).toContain('One sculptor per cast entry')
      // The orchestrator hands out work and checks it; it never sculpts.
      expect(rules).toContain('Do not sculpt anything yourself')
    }
  })

  it('tells a codex orchestrator to override the model per spawn, which needs a bare fork', () => {
    const rules = sculptorRules(sculptors('gpt-5.6-sol', 'gpt-5.6-terra'), 'reference/loop-1')
    expect(rules).toContain('model="gpt-5.6-terra"')
    expect(rules).toContain('fork_turns="none"')
  })

  it('gives a cross-harness pairing a brief that stands alone', () => {
    const rules = sculptorRules(sculptors('gpt-5.6-sol', 'claude-opus-5'), 'reference/loop-1')
    expect(rules).toContain('.gauntlet-gamesmith/claude-<slug>.md')
    expect(rules).toContain('tools/crop.py')
    expect(rules).toContain('reference/loop-1/objects/')
  })

  it('says nothing when the phase is off — the runner never queues it', () => {
    expect(sculptorRules(sculptors('claude-fable-5', null), 'reference/loop-1')).toBe('')
  })
})
