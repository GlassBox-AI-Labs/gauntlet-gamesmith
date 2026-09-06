import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Ledger } from './ledger'
import { LeadContinuity } from './lead-continuity'
import { SteeringStore } from './steering-store'
import { SteeringService } from './steering'
import { createCodexImplementProtocol } from './roles/implement-codex'
import { createClaudeImplementProtocol } from './roles/implement-claude'
import type { ImplementOutcome } from './roles/implement-finalize'
import type { ConsultInput, ConsultResult } from './steering-agent'
import { harnessFor, MODEL_IDS, resolveModels } from '../shared/models'
import { effectivePromptForAttempt } from '../shared/prompts'
import { markResumePrompt, type PhaseAttempt } from '../shared/build'
import { extractLeadNotebook, isMissingLeadSession } from '../shared/lead'
import { implementPlan, critiquePlan, consultPlan } from './harness-plans'
import { copyBuildFolder } from './build-transfer'

const SESSION = '10000000-0000-4000-8000-000000000001'
const notebook = { plan: 'Tune combat', decisions: 'Keep the fixed timestep', experiments: 'Variable timestep caused jitter', verification: 'Build passed; boss playtest remains', nextSteps: 'Playtest the boss' }
let root: string, ledger: Ledger
const otherLedgers: Ledger[] = []
function setup(model: string = MODEL_IDS.claudeFable) {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'gauntlet-lead-'))
  const workspaceDir = path.join(root, 'game'); fs.mkdirSync(workspaceDir)
  ledger = new Ledger(path.join(root, 'registry.db'))
  const models = resolveModels({ orchestratorModel: model, subagentModel: null, referenceMode: 'skip' }, {})
  const build = ledger.createBuild({ workspaceDir, prompt: 'Build a game', maxRounds: 5, budgetUsd: null, models })
  const lead = new LeadContinuity(ledger), steering = new SteeringStore(ledger)
  lead.enable(build.id)
  const implementation = (round: number, prompt = `Implement round ${round}`) => ledger.createAttempt({ buildId: build.id, round, role: 'implement', harness: harnessFor(model), prompt })
  const start = (attempt: PhaseAttempt) => ledger.patchAttempt(attempt.id, { status: 'running', model, startedAt: new Date().toISOString() })
  const finish = (attempt: PhaseAttempt) => {
    lead.checkpoint(attempt, `Implemented combat.\n<lead-notebook>${JSON.stringify({ attemptId: attempt.id, ...notebook })}</lead-notebook>`)
    ledger.patchAttempt(attempt.id, { status: 'succeeded', model, sessionId: SESSION })
    if (attempt.harness === 'codex') lead.recordUsage(attempt, SESSION, { input: 100, output: 40, cacheRead: 300, cacheWrite: 0 })
  }
  const direction = (text: string) => {
    const consult = ledger.createAttempt({ buildId: build.id, round: 1, role: 'consult', harness: 'codex', prompt: 'Chat' })
    const source = steering.addSteeringMessage(build.id, 'user', text, consult.id)
    steering.completeSteering(consult.id, { reply: `Queued: ${text}`, directives: [{ text, sourceMessageIds: [source] }] })
  }
  return { build, lead, steering, implementation, start, finish, direction }
}
afterEach(() => {
  for (const other of otherLedgers.splice(0)) other.close()
  ledger?.close()
  if (root) fs.rmSync(root, { recursive: true, force: true })
})

describe('continuing run lead with steering', () => {
  it('selects prior sessions only from the current implementation harness', () => {
    const { build, lead, implementation, finish } = setup()
    const first = implementation(1)
    lead.prepare(first, first.prompt)
    finish(first)
    const otherHarness = ledger.createAttempt({ buildId: build.id, round: 2,
      role: 'implement', harness: 'codex', prompt: 'Temporary Codex attempt' })
    ledger.patchAttempt(otherHarness.id, { status: 'succeeded', sessionId: 'codex-session', model: MODEL_IDS.codexLuna })
    const next = implementation(3)
    expect(lead.prepare(next, next.prompt).resumeId).toBe(SESSION)
    expect(lead.state(build.id).dispatch?.fromAttemptId).toBe(first.id)
  })

  it('reads lead dispatches written before the Build vocabulary migration', () => {
    const { build, lead, implementation } = setup()
    const attempt = implementation(1)
    ledger.appendEvent({ buildId: build.id, attemptId: attempt.id, role: 'implement', round: 1,
      ts: new Date().toISOString(), kind: 'lead-dispatch', channel: 'system',
      text: JSON.stringify({ runId: attempt.id, round: 1, mode: 'new', fromRunId: null,
        resumeId: null, reason: 'Original dispatch', usageBaseline: null }) })
    const before = ledger.leadEvents(build.id).at(-1)!.text
    expect(lead.state(build.id).dispatch).toMatchObject({ attemptId: attempt.id, fromAttemptId: null })
    expect(lead.prepare(attempt, 'Replacement prompt')).toEqual({ prompt: attempt.prompt, resumeId: null, reason: 'Original dispatch' })
    expect(ledger.leadEvents(build.id).at(-1)!.text).toBe(before)
  })

  it.each([MODEL_IDS.claudeFable, MODEL_IDS.codexLuna])('continues %s across rounds and supplies memory plus newly frozen directions', model => {
    const { build, lead, steering, implementation, finish, direction } = setup(model)
    const first = implementation(1)
    const initial = lead.prepare(first, steering.freezeAttemptRequirements(first.id).prompt)
    expect(initial.resumeId).toBeNull()
    finish(first)
    direction('Reduce enemy movement speed by 20%')
    const next = implementation(2)
    const continued = lead.prepare(next, steering.freezeAttemptRequirements(next.id).prompt)
    expect(continued.resumeId).toBe(SESSION)
    expect(continued.prompt).toContain('Variable timestep caused jitter')
    expect(continued.prompt).toContain('Reduce enemy movement speed by 20%')
    expect(continued.prompt).toContain('supersede conflicting goals')
    expect(continued.prompt).toContain(next.id)
    const context = { models: build.models, prompt: continued.prompt, resumeId: continued.resumeId, claudeHome: '/fixture/claude', codexHome: '/fixture/codex' }
    expect(implementPlan(context).args).toContain(SESSION)
    expect(critiquePlan(context).args).not.toContain(SESSION)
    expect(consultPlan(MODEL_IDS.codexSol, '/fixture/schema.json')).not.toContain(SESSION)
    expect(lead.prepare(next, 'must not replace a frozen dispatch').prompt).toBe(continued.prompt)
  })

  it('keeps late steering out of automatic retries and critique; explicit Resume includes it once', () => {
    const { build, lead, steering, implementation, start, finish, direction } = setup()
    direction('Use touch controls')
    const original = implementation(1)
    lead.prepare(original, steering.freezeAttemptRequirements(original.id).prompt)
    start(original)
    direction('Use mouse controls instead')
    const retry = ledger.requeueInterruptedAttempt(ledger.getAttempt(original.id)!)
    const auto = lead.prepare(retry, steering.freezeAttemptRequirements(retry.id, effectivePromptForAttempt(retry.prompt).prompt).prompt)
    expect(auto.prompt).not.toContain('Use mouse controls instead')
    expect(auto.prompt.match(/<gauntlet-lead-continuity-v1>/g)).toHaveLength(1)
    start(retry)
    ledger.patchAttempt(retry.id, { status: 'failed', sessionId: SESSION })
    const explicit = implementation(1, markResumePrompt(ledger.getAttempt(retry.id)!.prompt))
    steering.includePendingOnResume(explicit.id)
    const prompt = lead.prepare(explicit, steering.freezeAttemptRequirements(explicit.id, effectivePromptForAttempt(ledger.getAttempt(explicit.id)!.prompt).prompt).prompt).prompt
    expect(prompt.match(/Use mouse controls instead/g)).toHaveLength(1)
    expect(prompt.match(/<gauntlet-lead-continuity-v1>/g)).toHaveLength(1)
    finish(explicit)
    direction('Add dash next round')
    const critic = ledger.createAttempt({ buildId: build.id, round: 1, role: 'critique', harness: 'codex', prompt: 'Judge the build' })
    const critique = steering.freezeAttemptRequirements(critic.id)
    expect(critique.prompt).toContain('Use mouse controls instead')
    expect(critique.prompt).not.toContain('Add dash next round')
    expect(critique.prompt).not.toContain('lead-memory-data')
    expect(steering.requirementsForAttempt(original.id)?.directives).toHaveLength(1)
  })

  it('recovers a missing session once, preserving requirements and rejecting a second recovery', () => {
    const { lead, steering, implementation, start, finish, direction } = setup()
    const first = implementation(1); lead.prepare(first, steering.freezeAttemptRequirements(first.id).prompt); finish(first)
    const second = implementation(2); lead.prepare(second, steering.freezeAttemptRequirements(second.id).prompt); start(second)
    direction('Late direction')
    let copied = ''
    expect(lead.recoverUnavailableSession(second, false)).toBe(false)
    expect(lead.recoverUnavailableSession(second, true, id => { copied = id })).toBe(true)
    const retry = ledger.getAttempt(copied)!
    const recovery = lead.prepare(retry, steering.freezeAttemptRequirements(retry.id, effectivePromptForAttempt(retry.prompt).prompt).prompt)
    expect(recovery.resumeId).toBeNull()
    expect(recovery.prompt).toContain('Variable timestep caused jitter')
    expect(recovery.prompt).not.toContain('Late direction')
    expect(lead.state(second.buildId).dispatch?.mode).toBe('recovered')
    start(retry)
    expect(lead.recoverUnavailableSession(retry, true)).toBe(false)
  })

  it('retains notebook history through restart and portable import without adopting session IDs', async () => {
    const { build, lead, steering, implementation, finish } = setup()
    const first = implementation(1); lead.prepare(first, steering.freezeAttemptRequirements(first.id).prompt); finish(first)
    ledger.patchBuild(build.id, { status: 'stopped' })
    ledger.close(); ledger = new Ledger(path.join(root, 'registry.db'))
    expect(new LeadContinuity(ledger).state(build.id).checkpoints[0].notebook).toEqual(notebook)
    const destination = path.join(root, 'portable')
    await copyBuildFolder(build.workspaceDir, destination)
    const imported = new Ledger(path.join(root, 'import.db')); otherLedgers.push(imported)
    imported.importBuildFolder(destination)
    const portableLead = new LeadContinuity(imported)
    expect(portableLead.state(build.id).checkpoints[0].notebook).toEqual(notebook)
    const next = imported.createAttempt({ buildId: build.id, round: 2, role: 'implement', harness: 'claude', prompt: 'Continue' })
    const recovery = portableLead.prepare(next, 'Continue')
    expect(recovery.resumeId).toBeNull()
    expect(recovery.prompt).toContain('Variable timestep caused jitter')
    expect(recovery.reason).toContain('transferred history')
  })

  it('does not reuse another loop’s session or silently enable historical runs', () => {
    const { build, lead, implementation, finish } = setup()
    const first = implementation(1); lead.prepare(first, first.prompt); finish(first)
    const workspaceDir = path.join(root, 'other'); fs.mkdirSync(workspaceDir)
    const other = ledger.createBuild({ workspaceDir, prompt: 'Other game', models: build.models, maxRounds: 3, budgetUsd: null })
    expect(lead.state(other.id).enabled).toBe(false)
    lead.enable(other.id)
    const attempt = ledger.createAttempt({ buildId: other.id, round: 1, role: 'implement', harness: 'claude', prompt: 'Build other' })
    expect(lead.prepare(attempt, attempt.prompt).resumeId).toBeNull()
  })

  it('records missing or invalid notebooks explicitly and rejects oversized/misattributed content', () => {
    const { lead, implementation } = setup()
    const first = implementation(1)
    expect(lead.checkpoint(first, 'Only a report')?.warning).toContain('No structured notebook')
    expect(() => extractLeadNotebook(`<lead-notebook>${JSON.stringify({ ...notebook, attemptId: 'wrong' })}</lead-notebook>`, first.id)).toThrow('different attempt')
    const next = implementation(2)
    const invalid = lead.checkpoint(next, `<lead-notebook>${JSON.stringify({ ...notebook, attemptId: next.id, plan: 'x'.repeat(4001) })}</lead-notebook>`)
    expect(invalid?.notebook).toBeNull()
    expect(invalid?.warning).toContain('Invalid lead notebook field')
  })

  it('retains the latest valid notebook beyond a page of failed attempts', () => {
    const { build, lead, implementation, finish } = setup()
    const first = implementation(1); lead.prepare(first, first.prompt); finish(first)
    for (let i = 0; i < 21; i++) lead.checkpoint(implementation(2), null)
    const state = lead.state(build.id)
    expect(state.checkpoints).toHaveLength(20)
    expect(state.latestNotebook?.attemptId).toBe(first.id)
    expect(lead.state(build.id, 20).checkpoints).toHaveLength(2)
    const retry = implementation(2)
    expect(lead.prepare(retry, retry.prompt).prompt).toContain('Variable timestep caused jitter')
  })

  it('reports a different returned session honestly and preserves the requested session in dispatch provenance', () => {
    const { build, lead, implementation, finish } = setup()
    const first = implementation(1); lead.prepare(first, first.prompt); finish(first)
    const next = implementation(2); lead.prepare(next, next.prompt)
    expect(lead.sessionStarted(next, SESSION)).toBe(false)
    expect(lead.sessionStarted(next, 'different-session')).toBe(true)
    expect(lead.state(build.id).dispatch?.mode).toBe('recovered')
    expect(lead.state(build.id).dispatch?.reason).toContain('not continued')
    expect(lead.state(build.id).dispatch?.resumeId).toBe(SESSION)
    lead.sessionStarted(next, 'different-session')
    expect(ledger.leadEvents(build.id).filter(event => event.kind === 'lead-session-reset')).toHaveLength(1)
  })

  it('gives steering the saved notebook while keeping its consult separate and read-only', async () => {
    const { build, lead, implementation, finish } = setup()
    const attempt = implementation(1); lead.prepare(attempt, attempt.prompt); finish(attempt)
    let captured: ConsultInput | null = null
    let resolve!: (result: ConsultResult) => void
    const service = new SteeringService(ledger, async input => { captured = input; return new Promise(done => { resolve = done }) }, () => {})
    service.message({ buildId: build.id, messageId: '10000000-0000-4000-8000-000000000002', content: 'Why a fixed timestep?', attachmentIds: [] })
    expect((captured as ConsultInput | null)?.prompt).toContain('Variable timestep caused jitter')
    expect((captured as ConsultInput | null)?.prompt).toContain('You are not the implementation lead')
    resolve({ text: JSON.stringify({ reply: 'The lead recorded jitter with variable timesteps.', directives: [] }), tokens: null, sessionId: null })
    await service.shutdown()
    expect(new SteeringStore(ledger).steeringState(build.id).directives).toEqual([])
  })
})

describe('lead protocol accounting and lookup errors', () => {
  it.each([false, true])('subtracts saved cumulative Codex usage and deduplicates completions (live rollout=%s)', async live => {
    const { build, lead, implementation, finish, start } = setup(MODEL_IDS.codexLuna)
    const first = implementation(1); lead.prepare(first, first.prompt); finish(first)
    const next = implementation(2); lead.prepare(next, next.prompt); start(next)
    const stat = fs.statSync(build.workspaceDir)
    let outcome: ImplementOutcome | undefined
    const protocol = createCodexImplementProtocol({ ledger, build, attempt: next, gate: { suppress: false },
      childBoundary: { workspaceDir: build.workspaceDir, workspaceDev: stat.dev, workspaceIno: stat.ino, dir: path.join(root, 'children'), dev: 0, ino: 0 },
      now: Date.now, nowIso: () => new Date().toISOString(), harnessHome: () => path.join(root, 'empty-harness'),
      log: () => {}, broadcast: () => {}, finalize: async (_exit, collect) => { outcome = collect() },
    })
    if (live) {
      const sessions = path.join(root, 'empty-harness', 'sessions', '2026', '09', '06')
      fs.mkdirSync(sessions, { recursive: true })
      fs.writeFileSync(path.join(sessions, `rollout-2026-09-06T12-00-00-${SESSION}.jsonl`), JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 550, cached_input_tokens: 400, output_tokens: 65 } } } }) + '\n')
    }
    protocol.onLine(JSON.stringify({ type: 'thread.started', thread_id: SESSION }))
    const completed = JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 550, cached_input_tokens: 400, output_tokens: 65 } })
    protocol.onLine(completed); protocol.onLine(completed)
    await protocol.finalize({ code: 0, timedOut: false, spawnError: null })
    expect(outcome!.tokens).toEqual({ input: 150, output: 25 })
    expect(outcome!.metrics.agents[0].tokens).toEqual({ input: 50, output: 25, cacheRead: 100, cacheWrite: 0 })
  })

  it.each([false, true])('only treats a Claude lookup rejection as recoverable before work (didWork=%s)', async didWork => {
    const { build, implementation } = setup()
    const attempt = implementation(1), stat = fs.statSync(build.workspaceDir)
    let outcome: ImplementOutcome | undefined
    const protocol = createClaudeImplementProtocol({ ledger, build, attempt, gate: { suppress: false },
      initialWorkflowOffsets: {}, initialWorkflowIdentities: {},
      childBoundary: { workspaceDir: build.workspaceDir, workspaceDev: stat.dev, workspaceIno: stat.ino, dir: path.join(root, 'children'), dev: 0, ino: 0 },
      now: Date.now, nowIso: () => new Date().toISOString(), harnessHome: () => path.join(root, 'empty-harness'),
      log: () => {}, broadcast: () => {}, finalize: async (_exit, collect) => { outcome = collect() },
    })
    if (didWork) protocol.onLine(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'I started editing.' }] } }))
    protocol.onStderr(`No conversation found with session ID: ${SESSION}`)
    await protocol.finalize({ code: 1, timedOut: false, spawnError: null })
    expect(outcome!.sessionUnavailable).toBe(!didWork)
    expect(isMissingLeadSession('Rate limit reached')).toBe(false)
    expect(isMissingLeadSession('Authentication failed')).toBe(false)
  })
})
