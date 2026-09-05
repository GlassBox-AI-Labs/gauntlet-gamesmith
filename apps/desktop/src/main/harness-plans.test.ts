import { describe, expect, it } from 'vitest'
import { resolveModels } from '../shared/models'
import { critiquePlan, implementPlan, referencePlan } from './harness-plans'

const homes = { claudeHome: '/homes/claude', codexHome: '/homes/codex', grokHome: '/homes/grok', neutralHome: '/tmp/neutral' }
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

  it('runs codex with only its own login when no cross-harness worker is configured', () => {
    const plan = implementPlan(ctx(resolveModels({ orchestratorModel: 'gpt-5.6-sol', orchestratorEffort: 'ultra', subagentModel: null }, null, null, { assetModel: null })))
    expect(plan.bin).toBe('codex')
    expect(plan.args).toContain('exec')
    expect(plan.args.join(' ')).toContain('model_reasoning_effort=ultra')
    expect(plan.args.join(' ')).toContain('-s danger-full-access')
    expect(plan.args.join(' ')).not.toContain('workspace-write')
    expect(plan.env.CODEX_HOME).toBe('/homes/codex')
    expect(plan.env.CLAUDE_CONFIG_DIR).toBeUndefined()
  })

  it('exposes the other isolated home only to an actual cross-harness delegation', () => {
    const sameHarness = implementPlan(ctx(resolveModels({ orchestratorModel: 'claude-fable-5', subagentModel: 'claude-opus-5' }, null)))
    expect(sameHarness.env.CLAUDE_CONFIG_DIR).toBe('/homes/claude')
    expect(sameHarness.env.CODEX_HOME).toBeUndefined()

    const crossHarness = implementPlan(ctx(resolveModels({ orchestratorModel: 'claude-fable-5', subagentModel: 'gpt-5.6-sol' }, null)))
    expect(crossHarness.env.CLAUDE_CONFIG_DIR).toBe('/homes/claude')
    expect(crossHarness.env.CODEX_HOME).toBe('/homes/codex')
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
    const claude = referencePlan(ctx(resolveModels({ orchestratorModel: 'claude-fable-5', subagentModel: 'claude-opus-5' }, null, { researchModel: null })))
    expect(claude.bin).toBe('claude')
    expect(claude.args.join(' ')).toContain('--model claude-fable-5')
    expect(claude.args).not.toContain('--forward-subagent-text')
    expect(claude.env.CLAUDE_CODE_SUBAGENT_MODEL).toBeUndefined()
    expect(claude.env.CODEX_HOME).toBeUndefined()

    const codex = referencePlan(ctx(resolveModels({ orchestratorModel: 'gpt-5.6-sol', subagentModel: 'claude-opus-5' }, null, { researchModel: null })))
    expect(codex.bin).toBe('codex')
    expect(codex.args.join(' ')).toContain('-m gpt-5.6-sol')
    expect(codex.env.CLAUDE_CONFIG_DIR).toBeUndefined()
  })
})

describe('grok plans', () => {
  it('runs grok for a grok critic, with the sandbox off and permissions bypassed', () => {
    const models = resolveModels(null, { criticModel: 'grok-4.6', criticEffort: 'xhigh' })
    const plan = critiquePlan({ ...ctx(models), outFile: '/runs/verdict.txt' })
    expect(plan.bin).toBe('grok')
    expect(plan.args.join(' ')).toContain('--output-format streaming-messages-json')
    expect(plan.args.join(' ')).toContain('--sandbox off')
    expect(plan.args).toContain('--always-approve')
    expect(plan.args.join(' ')).toContain('-m grok-4.6')
    expect(plan.args.join(' ')).toContain('--reasoning-effort xhigh')
    // No `-o` equivalent: the verdict comes back in the result event.
    expect(plan.args).not.toContain('-o')
  })

  /**
   * GROK_HOME alone does not stop grok reading the operator's ~/.claude
   * configuration as its own, which would put their skills, agents and MCP
   * servers into a run the app is supposed to be controlling.
   */
  it('redirects HOME as well as GROK_HOME so the operator config cannot leak in', () => {
    const models = resolveModels(null, { criticModel: 'grok-4.6' })
    const plan = critiquePlan(ctx(models))
    expect(plan.env.GROK_HOME).toBe('/homes/grok')
    expect(plan.env.HOME).toBe('/tmp/neutral')
  })

  it('runs grok as an orchestrator when that is the stored harness', () => {
    const plan = implementPlan(ctx(resolveModels({ orchestratorModel: 'grok-4.6', subagentModel: null }, null)))
    expect(plan.bin).toBe('grok')
    expect(plan.env.HOME).toBe('/tmp/neutral')
  })
})

describe('grok orchestrator delegation', () => {
  it('passes the --agents payload only when grok drives grok workers', () => {
    const grokPair = resolveModels({ orchestratorModel: 'grok-4.6', subagentModel: 'grok-4.5' }, null)
    const withAgents = implementPlan({ ...ctx(grokPair), agentsJson: '{"implementer":{"model":"grok-4.5"}}' })
    expect(withAgents.args).toContain('--agents')
    expect(withAgents.args.join(' ')).toContain('"model":"grok-4.5"')

    const without = implementPlan(ctx(grokPair))
    expect(without.args).not.toContain('--agents')
  })

  it('exports every harness home so a shelled-out child reuses the app logins', () => {
    const plan = implementPlan(ctx(resolveModels({ orchestratorModel: 'grok-4.6', subagentModel: 'gpt-5.6-sol' }, null)))
    expect(plan.env.CODEX_HOME).toBe('/homes/codex')
    expect(plan.env.CLAUDE_CONFIG_DIR).toBe('/homes/claude')
    expect(plan.env.GROK_HOME).toBe('/homes/grok')
  })
})
