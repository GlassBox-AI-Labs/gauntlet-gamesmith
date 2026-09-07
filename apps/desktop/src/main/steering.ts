import os from 'node:os'
import { SteeringAttachments } from './steering-attachments'
import { withPromptLogs } from './prompt-logs'
import { boundedBuildSnapshot } from './ipc-projection'
import { SteeringStore } from './steering-store'
import { LeadContinuity } from './lead-continuity'
import type { Ledger } from './ledger'
import type { ConsultAgent, ConsultResult } from './steering-agent'
import type { PhaseAttempt } from '../shared/build'
import type { HarnessKind } from '../shared/harness'
import { harnessFor } from '../shared/models'
import { buildSteeringPrompt, QUEUED_LEAD_CHAT_PROMPT } from '../shared/prompts'
import { MAX_QUEUED_CHAT_MESSAGES, parseSteeringReply, steeringId, steeringInput, type SteeringState } from '../shared/steering'
import { IPC } from '../shared/ipc'
import { redactLogText } from '../shared/redact-log'
import { estimateCostUsd, PRICE_TABLE_VERSION } from './pricing'

/** Durable FIFO conversation turns, serialized with phase execution through drain(). */
export class SteeringService {
  private store: SteeringStore
  private active = new Map<string, AbortController>()
  private jobs = new Map<string, Promise<boolean>>()
  private closing = false

  constructor(private ledger: Ledger, private agent: ConsultAgent, private send: (channel: string, payload: unknown) => void,
    private attachmentStore = new SteeringAttachments(ledger), private options: { harnessHome?: (kind: HarnessKind) => string } = {}) {
    this.store = new SteeringStore(ledger)
  }

  history(value: unknown): SteeringState { return this.store.steeringState(steeringId(value)) }

  private publish(buildId: string): void {
    this.send(IPC.steering.update, this.store.steeringState(buildId))
    const projection = this.ledger.recentAttemptProjectionForBuild(buildId, 200)
    this.send(IPC.build.update, boundedBuildSnapshot({
      build: this.ledger.getBuild(buildId)!, attempts: projection.attempts, totalAttempts: this.ledger.attemptCount(buildId),
      detailTruncated: projection.truncatedFields, aggregate: this.ledger.attemptAggregate(buildId),
    }))
  }

  private phaseBusy(buildId: string): boolean {
    if (this.ledger.activeAttemptForBuild(buildId)) return true
    // Finalizers and surviving descendants retain ownership after a row becomes terminal.
    const workspace = this.ledger.getBuild(buildId)?.workspaceDir
    return this.ledger.attemptsWithProcessOwnership().some(({ attempt }) => this.ledger.getBuild(attempt.buildId)?.workspaceDir === workspace)
  }

  message(value: unknown): SteeringState {
    if (this.closing) throw new Error('The app is closing. Your existing messages are saved.')
    const input = steeringInput(value), build = this.ledger.getBuild(input.buildId)
    if (!build) throw new Error('Build not found.')
    if (!build.playTrusted && !build.executionTrusted) throw new Error('Trust this existing build through Resume before starting its chat.')
    this.ledger.assertBuildWorkspaceIdentity(build.id)
    const state = this.history(build.id)
    const existing = state.messages.find(message => message.id === input.messageId)
    if (existing) {
      if (existing.content !== redactLogText(input.content) || JSON.stringify([...new Set(existing.attachments?.map(file => file.sourceId) ?? [])].sort()) !== JSON.stringify([...input.attachmentIds].sort())) throw new Error('Message ID already used.')
      return state
    }
    if (state.queued >= MAX_QUEUED_CHAT_MESSAGES) throw new Error('Up to 20 messages can wait for the lead. Let it catch up before sending more.')
    if (this.ledger.unfinishedConsults().length >= 100) throw new Error('Chat queues are full. Let the pending replies finish before sending more.')
    if (state.messages.reduce((n, message) => n + message.content.length, input.content.length) > 200000) throw new Error('This conversation has reached its context limit.')
    const prepared = this.attachmentStore.prepare(build.id, input.attachmentIds, state.messages.flatMap(message => message.attachments ?? []))
    this.ledger.transaction(() => {
      prepared.publish()
      new LeadContinuity(this.ledger).enable(build.id)
      const attempt = this.ledger.createAttempt({ buildId: build.id, round: build.round, role: 'consult', harness: harnessFor(build.models.orchestratorModel), prompt: QUEUED_LEAD_CHAT_PROMPT })
      this.ledger.patchAttempt(attempt.id, { model: build.models.orchestratorModel, effort: build.models.orchestratorEffort })
      this.store.addSteeringMessage(build.id, 'user', input.content, attempt.id, input.messageId, prepared.files)
      this.ledger.appendEvent({ buildId: build.id, attemptId: attempt.id, role: 'consult', round: attempt.round,
        ts: new Date().toISOString(), kind: 'lead-chat-queued', channel: 'system', text: JSON.stringify({ messageId: input.messageId }) })
    })
    this.publish(build.id)
    void this.drain(build.id)
    return this.history(build.id)
  }

  /** Runner awaits this before its next phase. It never interrupts or restarts phase work. */
  drain(buildId: string): Promise<boolean> {
    const running = this.jobs.get(buildId)
    if (running) return running
    if (this.closing) return Promise.resolve(false)
    const job = Promise.resolve().then(async () => {
      const build = this.ledger.getBuild(buildId)
      if (!build || (!build.playTrusted && !build.executionTrusted)) return false
      while (!this.closing && !this.phaseBusy(buildId)) {
        const unfinished = this.ledger.unfinishedConsults().filter(attempt => attempt.buildId === buildId)
        if (unfinished.some(attempt => attempt.status === 'running')) return false
        const attempt = unfinished[0]
        if (!attempt) return true
        await this.answer(attempt)
      }
      return false
    }).catch(error => {
      const line = { buildId, attemptId: null, ts: new Date().toISOString(), kind: 'error', channel: 'error' as const,
        text: redactLogText(error instanceof Error ? error.message : 'Chat persistence failed.') }
      this.ledger.appendCanonicalEvent(line)
      this.send(IPC.build.log, line)
      return false
    }).finally(() => this.jobs.delete(buildId))
    this.jobs.set(buildId, job)
    return job
  }

  private async answer(queued: PhaseAttempt): Promise<void> {
    const build = this.ledger.getBuild(queued.buildId)!, model = queued.model ?? build.models.orchestratorModel
    const harness = queued.harness, effort = queued.effort ?? build.models.orchestratorEffort
    const controller = new AbortController(), lead = new LeadContinuity(this.ledger)
    this.active.set(build.id, controller)
    let result: ConsultResult | undefined, started = Date.now()
    let resumed: string | null = null
    try {
      if (!build.playTrusted && !build.executionTrusted) throw new Error('This build must be trusted before Chat can continue.')
      this.ledger.assertBuildWorkspaceIdentity(build.id)
      const state = this.history(build.id)
      const index = state.messages.findIndex(message => message.role === 'user' && message.attemptId === queued.id)
      if (index < 0) throw new Error('Queued Chat message was not found.')
      const message = state.messages[index]
      // Include earlier answers, but never give a turn later queued messages as authority.
      const messages = state.messages.filter((entry, i) => entry.role !== 'user' || i <= index)
      const files = messages.flatMap(entry => entry.attachments ?? [])
      this.attachmentStore.verify(build.id, files)
      const memory = lead.state(build.id)
      const context = { goal: build.prompt, round: build.round, status: build.status,
        lead: { ...memory, checkpoints: memory.checkpoints.slice(0, 3) },
        latestVerdict: this.ledger.latestAttemptForBuildByRole(build.id, 'critique')?.verdict ?? null,
        directions: state.directives, messages }
      const basePrompt = buildSteeringPrompt(context)
      if (basePrompt.length > 250000) throw new Error('This conversation has reached its context limit.')
      this.ledger.patchAttempt(queued.id, { model, effort, priceTableVersion: PRICE_TABLE_VERSION,
        authMode: 'subscription', accountLabel: `${harness}:app-profile`, machineLabel: os.hostname().slice(0, 255) })
      const attempt = this.ledger.getAttempt(queued.id)!
      const dispatch = lead.prepare(attempt, basePrompt, harness === 'codex' ? this.options.harnessHome?.('codex') : undefined)
      resumed = dispatch.resumeId
      if (lead.state(build.id).dispatch?.mode === 'recovered') this.store.addSteeringMessage(build.id, 'system', dispatch.reason, attempt.id)
      started = Date.now()
      result = await this.agent({
        prompt: dispatch.prompt, model, effort, resumeId: resumed, usageBaseline: lead.usageBaseline(attempt),
        workspaceDir: build.workspaceDir, attemptId: attempt.id, signal: controller.signal,
        imagePaths: this.attachmentStore.verify(build.id, (message.attachments ?? []).filter(file => file.kind === 'image')),
        onSession: sessionId => {
          if (lead.sessionStarted(attempt, sessionId)) this.store.addSteeringMessage(build.id, 'system', 'The lead session was recovered using saved context.', attempt.id)
          this.ledger.patchAttempt(attempt.id, { sessionId })
        },
        onStarted: cliVersion => {
          this.ledger.patchAttempt(attempt.id, { status: 'running', startedAt: new Date().toISOString(), cliVersion })
          for (const line of withPromptLogs([this.ledger.getAttempt(attempt.id)!], []).filter(line => line.kind === 'prompt')) {
            this.ledger.appendEvent(line); this.send(IPC.build.log, line)
          }
          this.publish(build.id)
        },
        onEvent: event => {
          const line = { ...event, buildId: build.id, attemptId: attempt.id, round: attempt.round, role: 'consult' as const, ts: new Date().toISOString(), text: redactLogText(event.text) }
          this.ledger.appendEvent(line); this.send(IPC.build.log, line)
        },
      })
      if (controller.signal.aborted) throw new Error('Response stopped.')
      const reply = parseSteeringReply(result.text, new Set(messages.filter(entry => entry.role === 'user').map(entry => entry.id)), messages)
      if (reply.directives.some(directive => !directive.sourceMessageIds.includes(message.id))) throw new Error('A direction was not grounded in your message. Please clarify it.')
      this.store.completeSteering(attempt.id, reply)
    } catch (error) {
      const details = (error && typeof error === 'object' ? error : {}) as Partial<ConsultResult> & { unresolved?: boolean; sessionUnavailable?: boolean }
      result ??= { text: '', tokens: details.tokens ?? null, sessionId: details.sessionId ?? null, cumulativeTokens: details.cumulativeTokens }
      if (details.sessionUnavailable && resumed) lead.rejectSession(queued, resumed)
      const message = error instanceof Error ? error.message : 'Unable to answer. Please retry.'
      this.ledger.transaction(() => {
        this.ledger.patchAttempt(queued.id, { status: details.unresolved ? 'running' : controller.signal.aborted ? 'cancelled' : 'failed',
          error: message, finishedAt: details.unresolved ? null : new Date().toISOString() })
        this.store.addSteeringMessage(build.id, 'system', message, queued.id)
      })
    } finally {
      const tokens = result?.tokens, cost = tokens ? estimateCostUsd(model, tokens) : null
      this.ledger.transaction(() => {
        const sessionId = result?.sessionId ?? this.ledger.getAttempt(queued.id)?.sessionId ?? null
        if (harness === 'codex' && sessionId && result?.cumulativeTokens) lead.recordUsage(queued, sessionId, result.cumulativeTokens)
        this.ledger.patchAttempt(queued.id, { durationMs: Date.now() - started, sessionId,
          inputTokens: tokens ? tokens.input + tokens.cacheRead + tokens.cacheWrite : null, outputTokens: tokens?.output ?? null,
          costUsd: cost, costSource: cost != null ? 'price-table' : null })
        if (cost) { const latest = this.ledger.getBuild(build.id)!; this.ledger.patchBuild(build.id, { totalCostUsd: latest.totalCostUsd + cost }) }
      })
      this.active.delete(build.id)
      this.publish(build.id)
    }
  }

  preview(value: unknown): Buffer {
    if (!value || typeof value !== 'object') throw new Error('Invalid attachment preview.')
    const raw = value as Record<string, unknown>, buildId = steeringId(raw.buildId), id = steeringId(raw.attachmentId)
    const file = this.history(buildId).messages.flatMap(message => message.attachments ?? []).find(file => file.id === id)
    if (!file || file.kind !== 'image') throw new Error('Image attachment not found in this conversation.')
    return this.attachmentStore.read(buildId, file)
  }

  cancel(value: unknown): void {
    const buildId = steeringId(value), controller = this.active.get(buildId)
    if (controller) { controller.abort(); return }
    const queued = this.ledger.unfinishedConsults().find(attempt => attempt.buildId === buildId && attempt.status === 'queued')
    if (queued) {
      this.ledger.patchAttempt(queued.id, { status: 'cancelled', error: 'Message cancelled before delivery.', finishedAt: new Date().toISOString() })
      this.publish(buildId)
    }
  }

  withdraw(value: unknown): SteeringState {
    if (!value || typeof value !== 'object') throw new Error('Invalid withdrawal.')
    const raw = value as Record<string, unknown>, buildId = steeringId(raw.buildId)
    this.store.withdrawSteering(buildId, steeringId(raw.directiveId)); this.publish(buildId)
    return this.history(buildId)
  }

  async recover(): Promise<void> {
    for (const attempt of this.ledger.unfinishedConsults()) {
      // A crash between spawn and onStarted can leave a queued row with a live process.
      if (attempt.status === 'queued' && !this.agent.hasOwnership?.(attempt.id)
        && this.ledger.leadEvents(attempt.buildId).some(event => event.attemptId === attempt.id && event.kind === 'lead-chat-queued')) continue
      const settled = await (this.agent.recover?.(attempt.id) ?? Promise.resolve(true)).catch(() => false)
      this.ledger.patchAttempt(attempt.id, { status: settled ? 'interrupted' : 'running',
        error: settled ? 'Chat interrupted by app restart.' : 'Chat process ownership remains unresolved.', finishedAt: settled ? new Date().toISOString() : null })
      this.store.addSteeringMessage(attempt.buildId, 'system', settled
        ? 'The previous reply was interrupted. Send another message to continue with the lead.'
        : 'The previous Chat process could not be safely identified. Chat remains paused.', attempt.id)
    }
  }

  resumeQueued(): void { for (const buildId of new Set(this.ledger.unfinishedConsults().map(attempt => attempt.buildId))) void this.drain(buildId) }
  hasUnfinished(): boolean { return this.ledger.unfinishedConsults().some(attempt => attempt.status === 'running') || this.active.size > 0 }

  async shutdown(): Promise<boolean> {
    this.closing = true
    for (const controller of this.active.values()) controller.abort()
    await Promise.allSettled([...this.jobs.values()])
    if (this.hasUnfinished()) await this.recover()
    return !this.hasUnfinished()
  }
}
