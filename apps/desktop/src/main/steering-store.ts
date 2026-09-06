import crypto from 'node:crypto'
import type { Ledger } from './ledger'
import type { PhaseAttempt } from '../shared/build'
import type { SteeringMessage, SteeringReply, SteeringState, RequirementSnapshot } from '../shared/steering'
import { DEFAULT_STEERING_MODEL, steeringModel, steeringAttachments, steeringAssetChanges, steeringIds, type SteeringAttachment } from '../shared/steering'
import { withOperatorDirections } from '../shared/prompts'

type StoredObject = Record<string, unknown>
function object(value: unknown): StoredObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid stored steering history.')
  return value as StoredObject
}
function boundedText(value: unknown, limit: number): string {
  if (typeof value !== 'string' || !value.length || value.length > limit) throw new Error('Invalid stored steering text.')
  return value
}
function snapshotFrom(value: StoredObject, buildId: string): RequirementSnapshot {
  const implementationAttemptId = boundedText(value.implementationAttemptId ?? value.implementationRunId, 100)
  if (!Array.isArray(value.directives) || value.directives.length > 1000) throw new Error('Invalid requirements snapshot.')
  const directives = value.directives.map(raw => {
    const directive = object(raw)
    return { id: boundedText(directive.id, 100), text: boundedText(directive.text, 6000), ...(directive.attachmentIds ? { attachmentIds: steeringIds(directive.attachmentIds) } : {}), ...(directive.assetChanges ? { assetChanges: steeringAssetChanges(directive.assetChanges) } : {}) }
  })
  return { implementationAttemptId, directives, ...(value.attachments ? { attachments: steeringAttachments(value.attachments, buildId) } : {}), ...(value.assetWork ? { assetWork: steeringAssetChanges(value.assetWork) } : {}) }
}

/** Steering is an append-only projection of the existing mirrored event ledger. */
export class SteeringStore {
  constructor(private ledger: Ledger) {}

  private records(buildId: string) {
    return this.ledger.steeringEvents(buildId).map(event => ({
      kind: event.kind, value: object(JSON.parse(event.text)), attemptId: event.attemptId,
    }))
  }

  steeringState(buildId: string): SteeringState {
    if (!this.ledger.getBuild(buildId)) throw new Error('Build not found.')
    const messages: SteeringMessage[] = [], directives: SteeringState['directives'] = []
    let model: string = DEFAULT_STEERING_MODEL
    for (const { kind, value, attemptId } of this.records(buildId)) {
      if (kind === 'steering-model') {
        model = steeringModel(value.model)
      } else if (kind === 'steering-message') {
        const { role } = value
        if (role !== 'user' && role !== 'assistant' && role !== 'system') throw new Error('Invalid stored steering role.')
        messages.push({
          id: boundedText(value.id, 100), buildId, role, content: typeof value.content === 'string' && value.content.length <= 16000 ? value.content : boundedText(value.content, 16000), attachments: steeringAttachments(value.attachments, buildId),
          createdAt: boundedText(value.createdAt, 100), attemptId,
        })
      } else if (kind === 'steering-directive') {
        if (!Array.isArray(value.sourceMessageIds) || value.sourceMessageIds.length > 1000) throw new Error('Invalid stored direction sources.')
        directives.push({
          id: boundedText(value.id, 100), messageId: boundedText(value.messageId, 100),
          text: boundedText(value.text, 6000), sourceMessageIds: value.sourceMessageIds.map(id => boundedText(id, 100)),
          attachmentIds: steeringIds(value.attachmentIds), assetChanges: steeringAssetChanges(value.assetChanges),
          buildId, withdrawn: false, firstAttemptId: null, firstRound: null,
        })
      } else if (kind === 'steering-withdraw') {
        const directive = directives.find(d => d.id === value.id)
        if (directive && !directive.firstAttemptId) directive.withdrawn = true
      } else if (kind === 'steering-snapshot') {
        const snapshot = snapshotFrom(value, buildId)
        if (typeof value.round !== 'number' || !Number.isSafeInteger(value.round) || value.round < 1) throw new Error('Invalid stored steering round.')
        if (value.role === 'implement') for (const included of snapshot.directives) {
          const directive = directives.find(d => d.id === included.id)
          if (directive && !directive.firstAttemptId) { directive.firstAttemptId = attemptId; directive.firstRound = value.round }
        }
      }
    }
    return { buildId, model, messages, directives, busy: this.ledger.unfinishedConsults().some(r => r.buildId === buildId) }
  }

  setModel(buildId: string, value: unknown): void {
    const model = steeringModel(value)
    if (this.steeringState(buildId).model !== model) this.append(buildId, null, 'steering-model', { model })
  }

  private append(buildId: string, attemptId: string | null, kind: string, value: unknown): void {
    const text = JSON.stringify(value)
    if (Buffer.byteLength(text) > 60000) throw new Error('Steering context is too large.')
    const attempt = attemptId ? this.ledger.getAttempt(attemptId) : null
    this.ledger.appendEvent({ buildId, attemptId, kind, text, ts: new Date().toISOString(), channel: 'system', role: attempt?.role, round: attempt?.round })
  }

  addSteeringMessage(buildId: string, role: SteeringMessage['role'], content: string, attemptId: string | null = null, id: string = crypto.randomUUID(), attachments: SteeringAttachment[] = []): string {
    this.append(buildId, attemptId, 'steering-message', { id, role, content, createdAt: new Date().toISOString(), attachments })
    return id
  }

  completeSteering(attemptId: string, reply: SteeringReply): void {
    const attempt = this.ledger.getAttempt(attemptId)!
    this.ledger.transaction(() => {
      const existing = this.steeringState(attempt.buildId).directives.reduce((sum, d) => sum + d.text.length, 0)
      if (existing + reply.directives.reduce((sum, d) => sum + d.text.length, 0) > 24000) throw new Error('This build has reached its steering context limit.')
      const messageId = this.addSteeringMessage(attempt.buildId, 'assistant', reply.reply, attemptId)
      for (const directive of reply.directives) this.append(attempt.buildId, attemptId, 'steering-directive', { id: crypto.randomUUID(), messageId, ...directive })
      this.ledger.patchAttempt(attemptId, { status: 'succeeded', summary: reply.reply, finishedAt: new Date().toISOString() })
    })
  }

  withdrawSteering(buildId: string, id: string): void {
    this.ledger.transaction(() => {
      const directive = this.steeringState(buildId).directives.find(d => d.id === id)
      if (!directive) throw new Error('Direction not found.')
      if (directive.firstAttemptId) throw new Error('This direction has already been included. Send another message to change it.')
      if (directive.withdrawn) return
      this.append(buildId, null, 'steering-withdraw', { id })
      this.addSteeringMessage(buildId, 'system', `Withdrawn before inclusion: ${directive.text}`)
    })
  }

  recordConsultPrompt(id: string): void {
    const attempt = this.ledger.getAttempt(id)!
    this.ledger.patchAttempt(id, { promptSha256: crypto.createHash('sha256').update(attempt.prompt).digest('hex') })
  }

  requirementsForAttempt(id: string): RequirementSnapshot | null {
    const attempt = this.ledger.getAttempt(id)
    if (!attempt) return null
    // Generic log queries truncate display text. Requirements must use the full durable event.
    const row = this.records(attempt.buildId).find(event => event.attemptId === id && event.kind === 'steering-snapshot')
    return row ? snapshotFrom(row.value, attempt.buildId) : null
  }

  /** Explicit Resume is a new operator boundary; automatic recovery keeps its frozen inputs. */
  includePendingOnResume(id: string): void {
    const attempt = this.ledger.getAttempt(id)
    if (!attempt || attempt.role !== 'implement' || attempt.status !== 'queued' || this.requirementsForAttempt(id)) return
    if (!this.steeringState(attempt.buildId).directives.some(d => !d.withdrawn && !d.firstAttemptId)) return
    this.freezeRequirements(id, undefined, true)
    this.addSteeringMessage(attempt.buildId, 'system', `Resume includes pending steering in this round ${attempt.round} implementation attempt. Earlier attempts retain their original instructions.`, id)
  }

  freezeAttemptRequirements(id: string, basePrompt?: string): PhaseAttempt {
    return this.freezeRequirements(id, basePrompt, false)
  }

  private freezeRequirements(id: string, basePrompt: string | undefined, includePending: boolean): PhaseAttempt {
    return this.ledger.transaction(() => {
      const attempt = this.ledger.getAttempt(id)!
      if ((attempt.role !== 'implement' && attempt.role !== 'critique') || attempt.status !== 'queued') return attempt
      let snapshot = this.requirementsForAttempt(id)
      let promptBase = basePrompt ?? attempt.prompt
      if (!snapshot) {
        const attempts = this.ledger.attemptsForBuild(attempt.buildId)
        const implementation = attempt.role === 'critique'
          ? attempts.filter(r => r.role === 'implement' && r.round === attempt.round && r.status === 'succeeded').at(-1)
          : null
        // A critic follows the successful attempt. Recovery follows the most recently frozen attempt.
        const earlier = this.records(attempt.buildId).filter(r => r.kind === 'steering-snapshot' && r.value.round === attempt.round && r.value.role === 'implement' && (!implementation || r.attemptId === implementation.id)).at(-1)
        const previous = earlier ? snapshotFrom(earlier.value, attempt.buildId) : null
        if (previous && !includePending) snapshot = previous
        else if (attempt.role === 'critique' || (!includePending && attempts.some(r => r.id !== id && r.role === 'implement' && r.round === attempt.round && r.startedAt))) {
          snapshot = { implementationAttemptId: 'legacy', directives: [] }
        } else {
          const state = this.steeringState(attempt.buildId), active = state.directives.filter(d => !d.withdrawn)
          const attachmentIds = new Set(active.flatMap(d => d.attachmentIds ?? []))
          const work = new Map<string, NonNullable<RequirementSnapshot['assetWork']>[number]>()
          const retryTargets = new Set(includePending ? previous?.assetWork?.map(change => change.target) : [])
          for (const directive of active) for (const change of directive.assetChanges ?? []) {
            if (!directive.firstAttemptId || retryTargets.has(change.target)) work.set(change.target, change)
          }
          snapshot = {
            implementationAttemptId: id,
            directives: active.map(d => ({ id: d.id, text: d.text, attachmentIds: d.attachmentIds, assetChanges: d.assetChanges })),
            attachments: state.messages.flatMap(message => message.attachments ?? []).filter(file => attachmentIds.has(file.id)),
            assetWork: [...work.values()],
          }
          if (includePending && previous) {
            const oldDirections = withOperatorDirections('', previous, 'implement')
            if (oldDirections) promptBase = promptBase.replace(oldDirections, '')
          }
        }
        this.append(attempt.buildId, id, 'steering-snapshot', { ...snapshot, role: attempt.role, round: attempt.round })
        if (snapshot.directives.length) this.addSteeringMessage(attempt.buildId, 'system', `Round ${attempt.round} ${attempt.role === 'implement' ? 'implementation includes' : 'critique uses the same'} ${snapshot.directives.length} direction(s).`, id)
      }
      const prompt = withOperatorDirections(promptBase, snapshot, attempt.role)
      this.ledger.patchAttempt(id, { prompt, promptSha256: crypto.createHash('sha256').update(prompt).digest('hex') })
      return this.ledger.getAttempt(id)!
    })
  }
}
