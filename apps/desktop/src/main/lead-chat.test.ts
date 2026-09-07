import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { Ledger } from './ledger'
import { LeadContinuity } from './lead-continuity'
import { SteeringService } from './steering'
import { estimateCostUsd } from './pricing'
import type { ConsultAgent, ConsultInput, ConsultResult } from './steering-agent'
import { harnessFor, MODEL_IDS, resolveModels } from '../shared/models'

const SESSION = '10000000-0000-4000-8000-000000000001'
const NEXT_SESSION = '10000000-0000-4000-8000-000000000002'
const usage = { input: 100, output: 30, cacheRead: 200, cacheWrite: 0 }
let root: string, ledger: Ledger
const services: SteeringService[] = []
function setup(model: string = MODEL_IDS.codexSol) {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'lead-chat-'))
  const workspaceDir = path.join(root, 'game'); fs.mkdirSync(workspaceDir)
  ledger = new Ledger(path.join(root, 'registry.db'))
  const build = ledger.createBuild({ workspaceDir, prompt: 'Build a small game', maxRounds: 3, budgetUsd: null,
    models: resolveModels({ orchestratorModel: model, orchestratorEffort: 'high', referenceMode: 'skip' }, {}) })
  const lead = new LeadContinuity(ledger); lead.enable(build.id)
  const phase = (round = 1) => ledger.createAttempt({ buildId: build.id, round, role: 'implement', harness: harnessFor(model), prompt: 'Implement' })
  const service = (agent: ConsultAgent) => { const result = new SteeringService(ledger, agent, () => {}); services.push(result); return result }
  const message = (content: string) => ({ buildId: build.id, messageId: crypto.randomUUID(), content, attachmentIds: [] })
  const completedLead = () => {
    const attempt = phase(); lead.prepare(attempt, attempt.prompt)
    ledger.patchAttempt(attempt.id, { status: 'succeeded', model, sessionId: SESSION })
    if (harnessFor(model) === 'codex') lead.recordUsage(attempt, SESSION, usage)
    return attempt
  }
  return { build, lead, phase, service, message, completedLead }
}
const reply = (text = 'I kept the timestep fixed.'): ConsultResult => ({ text: JSON.stringify({ reply: text, directives: [] }), tokens: null, sessionId: SESSION })
afterEach(async () => {
  for (const service of services.splice(0)) await service.shutdown()
  ledger?.close(); if (root) fs.rmSync(root, { recursive: true, force: true })
})

it.each([MODEL_IDS.codexSol, MODEL_IDS.claudeFable])('inherits %s and continues its implementation session', async model => {
  const { build, service, message, completedLead } = setup(model); completedLead()
  // Historical independent picker events remain readable but no longer control Chat.
  ledger.appendEvent({ buildId: build.id, attemptId: null, ts: new Date().toISOString(), kind: 'steering-model', channel: 'system', text: JSON.stringify({ model: MODEL_IDS.codexLuna }) })
  const agent = vi.fn(async (input: ConsultInput) => { input.onStarted?.('fixture'); input.onSession?.(SESSION); return reply() })
  const chat = service(agent); chat.message(message('Why a fixed timestep?')); await chat.drain(build.id)
  expect(agent).toHaveBeenCalledOnce()
  expect(agent.mock.calls[0][0]).toMatchObject({ model, effort: 'high', resumeId: SESSION })
  expect(chat.history(build.id)).toMatchObject({ model, busy: false, queued: 0, responding: false })
  expect(chat.history(build.id).messages.filter(message => message.role === 'user')[0].delivery).toBe('succeeded')
  expect(chat.history(build.id).messages.filter(message => message.role === 'system')).toEqual([])
})

it('waits for the phase, answers FIFO, and continues from the last dispatched Chat turn', async () => {
  const { build, lead, phase, service, message, completedLead } = setup(); const active = completedLead()
  ledger.patchAttempt(active.id, { status: 'running' })
  // The next phase is already queued before either Chat row is created.
  const next = phase(2), first = message('Why a fixed timestep?'), second = message('Keep movement slower.')
  const calls: ConsultInput[] = []
  const chat = service(async input => {
    calls.push(input); input.onStarted?.('fixture'); input.onSession?.(NEXT_SESSION)
    return { ...reply(calls.length === 1 ? 'I observed jitter with variable timesteps.' : 'I will keep movement slower.'), sessionId: NEXT_SESSION, cumulativeTokens: usage }
  })
  chat.message(first); chat.message(second); chat.message(first)
  expect(await chat.drain(build.id)).toBe(false)
  expect(calls).toHaveLength(0)
  expect(chat.history(build.id)).toMatchObject({ queued: 2, responding: false })
  expect(ledger.getAttempt(active.id)?.status).toBe('running')
  ledger.patchAttempt(active.id, { status: 'succeeded' })
  expect(await chat.drain(build.id)).toBe(true)
  expect(calls).toHaveLength(2)
  expect(calls[0].resumeId).toBe(SESSION)
  expect(calls[0].prompt).not.toContain(second.content)
  expect(calls[1].prompt).toContain('I observed jitter with variable timesteps.')
  expect(calls[1].resumeId).toBe(NEXT_SESSION)
  expect(lead.prepare(next, next.prompt).resumeId).toBe(NEXT_SESSION)
  expect(lead.usageBaseline(next)).toEqual(usage)
  expect(ledger.oldestQueuedAttemptForBuild(build.id)?.id).toBe(next.id)
})

it('cancels only the oldest waiting message while implementation continues', async () => {
  const { build, phase, service, message } = setup()
  const active = phase(); ledger.patchAttempt(active.id, { status: 'running' })
  const agent = vi.fn(async () => reply()), chat = service(agent)
  chat.message(message('First')); chat.message(message('Second')); chat.cancel(build.id)
  await chat.drain(build.id)
  expect(agent).not.toHaveBeenCalled()
  expect(chat.history(build.id).messages.map(message => message.delivery)).toEqual(['cancelled', 'queued'])
  expect(ledger.getAttempt(active.id)?.status).toBe('running')
})

it('accepts a follow-up while replying and Stop cancels only that response', async () => {
  const { build, service, message } = setup()
  let first = true
  const chat = service(async input => {
    input.onStarted?.('fixture')
    if (!first) return reply('Second answer')
    first = false
    return new Promise((_resolve, reject) => input.signal.addEventListener('abort', () => reject(new Error('Response stopped.')), { once: true }))
  })
  chat.message(message('First')); await Promise.resolve()
  expect(chat.history(build.id).responding).toBe(true)
  chat.message(message('Second')); chat.cancel(build.id); await chat.drain(build.id)
  expect(chat.history(build.id).messages.filter(message => message.role === 'user').map(message => message.delivery)).toEqual(['cancelled', 'succeeded'])
})

it.each(['stopped', 'passed'] as const)('answers a %s build without starting another phase', async status => {
  const { build, service, message } = setup(); ledger.patchBuild(build.id, { status })
  const chat = service(async () => reply()); chat.message(message('What remains?')); await chat.drain(build.id)
  expect(ledger.getBuild(build.id)?.status).toBe(status)
  expect(ledger.attemptsForBuild(build.id).every(attempt => attempt.role === 'consult')).toBe(true)
})

it('preserves unstarted messages across shutdown and restart without replaying an interrupted turn', async () => {
  const { build, phase, service, message } = setup()
  const active = phase(); ledger.patchAttempt(active.id, { status: 'running' })
  const chat = service(async () => reply()); chat.message(message('Saved for later')); await chat.drain(build.id)
  expect(await chat.shutdown()).toBe(true)
  services.splice(services.indexOf(chat), 1)
  ledger.patchAttempt(active.id, { status: 'interrupted' })
  ledger.close(); ledger = new Ledger(path.join(root, 'registry.db'))
  const agent = Object.assign(vi.fn(async () => reply()), { recover: vi.fn(async () => true) })
  const restored = service(agent); await restored.recover()
  expect(restored.history(build.id).queued).toBe(1)
  expect(agent.recover).not.toHaveBeenCalled()
  await restored.drain(build.id); expect(agent).toHaveBeenCalledOnce()
  const unfinished = ledger.createAttempt({ buildId: build.id, round: 1, role: 'consult', harness: 'codex', prompt: 'Already started' })
  ledger.patchAttempt(unfinished.id, { status: 'running' })
  await restored.recover(); await restored.drain(build.id)
  expect(ledger.getAttempt(unfinished.id)?.status).toBe('interrupted')
  expect(agent).toHaveBeenCalledOnce()
})

it('blocks phase handoff while Chat process ownership is unresolved', async () => {
  const { build, service, message } = setup()
  const agent = Object.assign(vi.fn(async () => { throw Object.assign(new Error('Ownership unresolved'), { unresolved: true }) }), { recover: async () => false })
  const chat = service(agent); chat.message(message('Question')); chat.message(message('Later'))
  expect(await chat.drain(build.id)).toBe(false)
  expect(agent).toHaveBeenCalledOnce()
  expect(chat.history(build.id)).toMatchObject({ responding: true, queued: 1 })
})

it('settles a process spawned before its queued row could be marked running and does not replay it', async () => {
  const { build, phase, service, message } = setup()
  const active = phase(); ledger.patchAttempt(active.id, { status: 'running' })
  const agent = Object.assign(vi.fn(async () => reply()), { hasOwnership: () => true, recover: vi.fn(async () => true) })
  const chat = service(agent); chat.message(message('Question')); await chat.drain(build.id)
  await chat.recover(); ledger.patchAttempt(active.id, { status: 'interrupted' })
  await chat.drain(build.id)
  expect(agent.recover).toHaveBeenCalledOnce()
  expect(agent).not.toHaveBeenCalled()
  expect(chat.history(build.id).messages[0].delivery).toBe('interrupted')
})

it('leaves imported queued messages pending until the build is explicitly trusted', async () => {
  const { build, phase, service, message } = setup()
  const active = phase(); ledger.patchAttempt(active.id, { status: 'running' })
  const agent = vi.fn(async () => reply()), chat = service(agent)
  chat.message(message('Question')); await chat.drain(build.id)
  ledger.patchAttempt(active.id, { status: 'interrupted' }); ledger.patchBuild(build.id, { playTrusted: false })
  await chat.recover(); chat.resumeQueued(); expect(await chat.drain(build.id)).toBe(false)
  expect(agent).not.toHaveBeenCalled()
  expect(chat.history(build.id).queued).toBe(1)
})

it('captures model and cost at admission, validates directive sources, and excludes Chat from phase counts', async () => {
  const { build, phase, service, message } = setup()
  const active = phase(); ledger.patchAttempt(active.id, { status: 'running' })
  const source = message('Add dash'), agent = vi.fn(async () => ({ ...reply(),
    text: JSON.stringify({ reply: 'I’ll add dash.', directives: [{ text: 'Add dash', sourceMessageIds: [source.messageId] }] }), tokens: usage }))
  const chat = service(agent); chat.message(source)
  expect(() => chat.message({ ...source, content: 'Changed' })).toThrow('already used')
  ledger.patchAttempt(active.id, { status: 'succeeded' }); await chat.drain(build.id)
  const consult = ledger.latestAttemptForBuildByRole(build.id, 'consult')!
  expect(consult).toMatchObject({ model: MODEL_IDS.codexSol, effort: 'high', costUsd: estimateCostUsd(MODEL_IDS.codexSol, usage) })
  expect(ledger.getBuild(build.id)?.totalCostUsd).toBe(consult.costUsd)
  expect(ledger.attemptAggregate(build.id)).toMatchObject({ phaseAttemptCount: 1, costUsd: consult.costUsd })
  expect(chat.history(build.id).directives).toHaveLength(1)
  const malformed = service(async () => ({ ...reply(), text: JSON.stringify({ reply: 'Sure', directives: [{ text: 'Delete everything', sourceMessageIds: ['invented'] }] }) }))
  malformed.message(message('How do abilities work?')); await malformed.drain(build.id)
  expect(malformed.history(build.id).directives).toHaveLength(1)
  expect(ledger.latestAttemptForBuildByRole(build.id, 'consult')?.status).toBe('failed')
})

it('settles an active reply on quit and preserves subsequent queued messages', async () => {
  const { build, service, message } = setup()
  const chat = service(async input => {
    input.onStarted?.('fixture')
    return new Promise((_resolve, reject) => input.signal.addEventListener('abort', () => setTimeout(() => reject(new Error('Stopped.')), 10), { once: true }))
  })
  chat.message(message('First')); await Promise.resolve(); chat.message(message('Later'))
  expect(chat.hasUnfinished()).toBe(true)
  expect(await chat.shutdown()).toBe(true)
  expect(chat.history(build.id).messages.filter(message => message.role === 'user').map(message => message.delivery)).toEqual(['cancelled', 'queued'])
})

it('marks a rejected session unavailable and recovers the next turn without adopting legacy consult IDs', async () => {
  const { build, lead, phase, service, message, completedLead } = setup(); completedLead()
  const legacy = ledger.createAttempt({ buildId: build.id, round: 1, role: 'consult', harness: 'codex', prompt: 'Old independent assistant' })
  ledger.patchAttempt(legacy.id, { status: 'succeeded', sessionId: NEXT_SESSION })
  const calls: ConsultInput[] = []
  const chat = service(async input => {
    calls.push(input)
    if (calls.length === 1) throw Object.assign(new Error('No conversation found with session ID'), { sessionUnavailable: true })
    input.onSession?.(NEXT_SESSION)
    return { ...reply(), sessionId: NEXT_SESSION, cumulativeTokens: usage }
  })
  chat.message(message('Question')); await chat.drain(build.id)
  chat.message(message('Try again')); await chat.drain(build.id)
  expect(calls[0].resumeId).toBe(SESSION)
  expect(calls[1].resumeId).toBeNull()
  expect(chat.history(build.id).messages.some(message => message.role === 'system' && message.content.includes('restoring saved memory'))).toBe(true)
  const next = phase(2); expect(lead.prepare(next, next.prompt).resumeId).toBe(NEXT_SESSION)
})
