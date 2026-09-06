import os from 'node:os'
import { SteeringAttachments } from './steering-attachments'
import { withPromptLogs } from './prompt-logs'
import { boundedBuildSnapshot } from './ipc-projection'
import { SteeringStore } from './steering-store'
import { LeadContinuity } from './lead-continuity'
import type { Ledger } from './ledger'
import type { ConsultAgent, ConsultResult } from './steering-agent'
import { buildSteeringPrompt } from '../shared/prompts'
import { parseSteeringReply, steeringId, steeringInput, type SteeringState } from '../shared/steering'
import { IPC } from '../shared/ipc'
import { redactLogText } from '../shared/redact-log'
import { estimateCostUsd, PRICE_TABLE_VERSION } from './pricing'

/** Owns conversation admission, consult lifecycle, and durable publication. */
export class SteeringService {
  private store: SteeringStore
  private active = new Map<string, AbortController>()
  private jobs = new Set<Promise<void>>()

  constructor(private ledger: Ledger, private agent: ConsultAgent, private send: (channel: string, payload: unknown) => void, private attachmentStore = new SteeringAttachments(ledger)) {
    this.store = new SteeringStore(ledger)
  }

  history(value: unknown): SteeringState { return this.store.steeringState(steeringId(value)) }

  setModel(value: unknown): SteeringState {
    if (!value || typeof value !== 'object') throw new Error('Invalid steering model selection.')
    const input = value as Record<string, unknown>, buildId = steeringId(input.buildId)
    this.store.setModel(buildId, input.model)
    this.publish(buildId)
    return this.history(buildId)
  }

  private publish(buildId: string): void {
    this.send(IPC.steering.update, this.store.steeringState(buildId))
    const projection = this.ledger.recentAttemptProjectionForBuild(buildId, 200)
    this.send(IPC.build.update, boundedBuildSnapshot({
      build: this.ledger.getBuild(buildId)!, attempts: projection.attempts, totalAttempts: this.ledger.attemptCount(buildId),
      detailTruncated: projection.truncatedFields, aggregate: this.ledger.attemptAggregate(buildId),
    }))
  }

  message(value: unknown): SteeringState {
    const input = steeringInput(value), build = this.ledger.getBuild(input.buildId)
    if (!build) throw new Error('Build not found.')
    if (!build.playTrusted && !build.executionTrusted) throw new Error('Trust this existing build through Resume before starting its chat.')
    this.ledger.assertBuildWorkspaceIdentity(build.id)
    const state = this.history(build.id)
    // Capture the selected model once: a later preference change belongs to the next reply.
    const model = state.model
    const existing = state.messages.find(message => message.id === input.messageId)
    if (existing) {
      if (existing.content !== redactLogText(input.content) || JSON.stringify([...new Set(existing.attachments?.map(file => file.sourceId) ?? [])].sort()) !== JSON.stringify([...input.attachmentIds].sort())) throw new Error('Message ID already used.')
      return state
    }
    if (state.busy || this.active.has(build.id)) throw new Error('Wait for the current response or stop it first.')
    const priorFiles = state.messages.flatMap(message => message.attachments ?? [])
    this.attachmentStore.verify(build.id, priorFiles)
    const prepared = this.attachmentStore.prepare(build.id, input.attachmentIds, priorFiles)
    const context = {
      goal: build.prompt, round: build.round, status: build.status,
      lead: (() => {
        const state = new LeadContinuity(this.ledger).state(build.id)
        return { ...state, checkpoints: state.checkpoints.slice(0, 3) }
      })(),
      latestVerdict: this.ledger.attemptsForBuild(build.id).filter(attempt => attempt.role === 'critique' && attempt.verdict).at(-1)?.verdict ?? null,
      directions: state.directives,
      messages: [...state.messages, { id: input.messageId, buildId: build.id, role: 'user' as const, content: input.content, createdAt: new Date().toISOString(), attemptId: null, attachments: prepared.files }],
    }
    const prompt = buildSteeringPrompt(context)
    if (prompt.length > 250000) throw new Error('This conversation has reached its context limit. Start a new build to continue.')
    const attempt = this.ledger.transaction(() => {
      prepared.publish()
      const attempt = this.ledger.createAttempt({ buildId: build.id, round: build.round, role: 'consult', harness: 'codex', prompt })
      this.store.addSteeringMessage(build.id, 'user', input.content, attempt.id, input.messageId, prepared.files)
      this.store.recordConsultPrompt(attempt.id)
      this.ledger.patchAttempt(attempt.id, {
        status: 'queued', model, effort: 'low', priceTableVersion: PRICE_TABLE_VERSION,
        authMode: 'subscription', accountLabel: 'codex:app-profile-1', machineLabel: os.hostname().slice(0, 255),
      })
      return attempt
    })
    const controller = new AbortController()
    this.active.set(build.id, controller)
    this.publish(build.id)
    const started = Date.now()
    const job = (async () => {
      let result: ConsultResult | undefined
      try {
        result = await this.agent({
          prompt: attempt.prompt, model, workspaceDir: build.workspaceDir, attemptId: attempt.id, signal: controller.signal,
          imagePaths: this.attachmentStore.verify(build.id, prepared.files.filter(file => file.kind === 'image')),
          onStarted: cliVersion => {
            this.ledger.patchAttempt(attempt.id, { status: 'running', startedAt: new Date().toISOString(), cliVersion })
            for (const line of withPromptLogs([this.ledger.getAttempt(attempt.id)!], []).filter(line => line.kind === 'prompt')) {
              this.ledger.appendEvent(line)
              this.send(IPC.build.log, line)
            }
            this.publish(build.id)
          },
          onEvent: event => {
            const line = { ...event, buildId: build.id, attemptId: attempt.id, round: attempt.round, role: 'consult' as const, ts: new Date().toISOString(), text: redactLogText(event.text) }
            this.ledger.appendEvent(line)
            this.send(IPC.build.log, line)
          },
        })
        if (controller.signal.aborted) throw new Error('Response stopped.')
        const reply = parseSteeringReply(result.text, new Set(context.messages.filter(message => message.role === 'user').map(message => message.id)), context.messages)
        if (reply.directives.some(directive => !directive.sourceMessageIds.includes(input.messageId))) throw new Error('A direction was not grounded in your latest message. Please clarify it.')
        this.store.completeSteering(attempt.id, reply)
      } catch (error) {
        const details = (error && typeof error === 'object' ? error : {}) as Partial<ConsultResult> & { unresolved?: boolean }
        result ??= { text: '', tokens: details.tokens ?? null, sessionId: details.sessionId ?? null }
        const message = error instanceof Error ? error.message : 'Unable to answer. Please retry.'
        this.ledger.transaction(() => {
          this.ledger.patchAttempt(attempt.id, {
            status: details.unresolved ? 'running' : controller.signal.aborted ? 'cancelled' : 'failed',
            error: message, finishedAt: details.unresolved ? null : new Date().toISOString(),
          })
          this.store.addSteeringMessage(build.id, 'system', message, attempt.id)
        })
      } finally {
        const tokens = result?.tokens, cost = tokens ? estimateCostUsd(model, tokens) : null
        this.ledger.transaction(() => {
          this.ledger.patchAttempt(attempt.id, {
            durationMs: Date.now() - started, sessionId: result?.sessionId ?? null,
            inputTokens: tokens ? tokens.input + tokens.cacheRead : null, outputTokens: tokens?.output ?? null,
            costUsd: cost, costSource: cost != null ? 'price-table' : null,
          })
          if (cost) {
            const latest = this.ledger.getBuild(build.id)!
            this.ledger.patchBuild(build.id, { totalCostUsd: latest.totalCostUsd + cost })
          }
        })
        this.active.delete(build.id)
        this.publish(build.id)
      }
    })().catch(error => {
      this.active.delete(build.id)
      const line = { buildId: build.id, attemptId: attempt.id, ts: new Date().toISOString(), kind: 'error', channel: 'error' as const, text: redactLogText(error instanceof Error ? error.message : 'Chat persistence failed.') }
      this.ledger.appendCanonicalEvent(line)
      this.send(IPC.build.log, line)
    })
    this.jobs.add(job)
    void job.finally(() => this.jobs.delete(job)).catch(() => {})
    return this.history(build.id)
  }

  preview(value: unknown): Buffer {
    if (!value || typeof value !== 'object') throw new Error('Invalid attachment preview.')
    const raw = value as Record<string, unknown>, buildId = steeringId(raw.buildId), id = steeringId(raw.attachmentId)
    const file = this.history(buildId).messages.flatMap(message => message.attachments ?? []).find(file => file.id === id)
    if (!file || file.kind !== 'image') throw new Error('Image attachment not found in this conversation.')
    return this.attachmentStore.read(buildId, file)
  }

  cancel(value: unknown): void { this.active.get(steeringId(value))?.abort() }

  withdraw(value: unknown): SteeringState {
    if (!value || typeof value !== 'object') throw new Error('Invalid withdrawal.')
    const raw = value as Record<string, unknown>, buildId = steeringId(raw.buildId)
    this.store.withdrawSteering(buildId, steeringId(raw.directiveId))
    this.publish(buildId)
    return this.history(buildId)
  }

  async recover(): Promise<void> {
    for (const attempt of this.ledger.unfinishedConsults()) {
      const settled = await (this.agent.recover?.(attempt.id) ?? Promise.resolve(true)).catch(() => false)
      this.ledger.patchAttempt(attempt.id, {
        status: settled ? 'interrupted' : 'running',
        error: settled ? 'Chat interrupted by app restart.' : 'Chat process ownership remains unresolved.',
        finishedAt: settled ? new Date().toISOString() : null,
      })
      this.store.addSteeringMessage(attempt.buildId, 'system', settled
        ? 'The previous chat response was interrupted. Send another message to continue.'
        : 'The previous chat process could not be safely identified. Chat remains paused for this build.', attempt.id)
    }
  }

  hasUnfinished(): boolean { return this.ledger.unfinishedConsults().length > 0 }

  async shutdown(): Promise<boolean> {
    for (const controller of this.active.values()) controller.abort()
    await Promise.allSettled([...this.jobs])
    if (this.hasUnfinished()) await this.recover()
    return !this.hasUnfinished()
  }
}
