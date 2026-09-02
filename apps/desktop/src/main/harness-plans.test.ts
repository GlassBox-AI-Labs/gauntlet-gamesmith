import { describe, expect, it } from 'vitest'
import { resolveModels } from '../shared/models'
import { critiquePlan, implementPlan, referencePlan } from './harness-plans'

const homes = { claudeHome: '/homes/claude', codexHome: '/homes/codex' }
const ctx = (models: ReturnType<typeof resolveModels>) => ({ models, prompt: 'build it', ...homes })

describe('implementPlan', () => {
  it('runs claude for a claude orchestrator, pinning the subagent model', () => {
    const plan = implementPlan(ctx(resolveModels({ orchestratorModel: 'claude-fable-5', subagentModel: 'claude-opus-5' }, null)))
    expect(plan.bin).toBe('claude')
    expect(plan.args).toContain('--dangerously-skip-permissions')
    expect(plan.args.join(' ')).toContain('--model claude-fable-5')
    expect(plan.env.CLAUDE_CODE_SUBAGENT_MODEL).toBe('claude-opus-5')
  })

  it('fronts a codex worker with the dispatcher model, since the CLI would ignore a gpt id', () => {
    const plan = implementPlan(ctx(resolveModels({ orchestratorModel: 'claude-fable-5', subagentModel: 'gpt-5.6-sol' }, null)))
    expect(plan.env.CLAUDE_CODE_SUBAGENT_MODEL).toBe('claude-sonnet-5')
    // The dispatcher holds a foreground call open for hours; the stock ceiling is 10 minutes.
    expect(Number(plan.env.BASH_MAX_TIMEOUT_MS)).toBeGreaterThan(60 * 60_000)
  })

  it('runs codex for a codex orchestrator, with both logins in reach', () => {
    const plan = implementPlan(ctx(resolveModels({ orchestratorModel: 'gpt-5.6-sol', orchestratorEffort: 'ultra' }, null)))
    expect(plan.bin).toBe('codex')
    expect(plan.args).toContain('exec')
    expect(plan.args.join(' ')).toContain('model_reasoning_effort=ultra')
    expect(plan.env.CODEX_HOME).toBe('/homes/codex')
    expect(plan.env.CLAUDE_CONFIG_DIR).toBe('/homes/claude')
  })

  it('resumes each CLI its own way', () => {
    const claude = implementPlan({ ...ctx(resolveModels({ orchestratorModel: 'claude-opus-5' }, null)), resumeId: 'sess-1' })
    expect(claude.args.slice(0, 2)).toEqual(['--resume', 'sess-1'])
    const codex = implementPlan({ ...ctx(resolveModels({ orchestratorModel: 'gpt-5.6-sol' }, null)), resumeId: 'thread-1' })
    // `codex exec resume <id>`: the subcommand precedes the flags.
    expect(codex.args.slice(0, 3)).toEqual(['exec', 'resume', 'thread-1'])
  })
})

describe('critiquePlan', () => {
  it('sends a codex critic its verdict file and a claude critic none', () => {
    const codex = critiquePlan({ ...ctx(resolveModels(null, { criticModel: 'gpt-5.6-sol', criticEffort: 'medium' })), outFile: '/w/verdict.txt' })
    expect(codex.bin).toBe('codex')
    expect(codex.args).toContain('-o')
    expect(codex.args).toContain('/w/verdict.txt')
    const claude = critiquePlan({ ...ctx(resolveModels(null, { criticModel: 'claude-opus-5', criticEffort: 'high' })), outFile: '/w/verdict.txt' })
    expect(claude.bin).toBe('claude')
    expect(claude.args).not.toContain('-o')
  })
})

describe('referencePlan', () => {
  it('uses the orchestrator model without subagent flags', () => {
    const claude = referencePlan(ctx(resolveModels({ orchestratorModel: 'claude-fable-5', subagentModel: 'claude-opus-5' }, null)))
    expect(claude.bin).toBe('claude')
    expect(claude.args.join(' ')).toContain('--model claude-fable-5')
    expect(claude.args).not.toContain('--forward-subagent-text')
    expect(claude.env.CLAUDE_CODE_SUBAGENT_MODEL).toBeUndefined()

    const codex = referencePlan(ctx(resolveModels({ orchestratorModel: 'gpt-5.6-sol', subagentModel: 'claude-opus-5' }, null)))
    expect(codex.bin).toBe('codex')
    expect(codex.args.join(' ')).toContain('-m gpt-5.6-sol')
  })
})
