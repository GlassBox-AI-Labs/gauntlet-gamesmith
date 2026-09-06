import crypto from 'node:crypto'
import type { Ledger } from './ledger'
import type { RunRecord } from '../shared/loop'
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
function snapshotFrom(value: StoredObject, loopId: string): RequirementSnapshot {
  const implementationRunId = boundedText(value.implementationRunId, 100)
  if (!Array.isArray(value.directives) || value.directives.length > 1000) throw new Error('Invalid requirements snapshot.')
  const directives = value.directives.map(raw => {
    const directive = object(raw)
    return { id: boundedText(directive.id, 100), text: boundedText(directive.text, 6000), ...(directive.attachmentIds ? { attachmentIds: steeringIds(directive.attachmentIds) } : {}), ...(directive.assetChanges ? { assetChanges: steeringAssetChanges(directive.assetChanges) } : {}) }
  })
  return { implementationRunId, directives, ...(value.attachments ? { attachments: steeringAttachments(value.attachments, loopId) } : {}), ...(value.assetWork ? { assetWork: steeringAssetChanges(value.assetWork) } : {}) }
}

/** Steering is an append-only projection of the existing mirrored event ledger. */
export class SteeringStore {
  constructor(private ledger: Ledger) {}

  private records(loopId: string) {
    return this.ledger.steeringEvents(loopId).map(event => ({
      kind: event.kind, value: object(JSON.parse(event.text)), runId: event.runId,
    }))
  }

  steeringState(loopId: string): SteeringState {
    if (!this.ledger.getLoop(loopId)) throw new Error('Run not found.')
    const messages: SteeringMessage[] = [], directives: SteeringState['directives'] = []
    let model: string = DEFAULT_STEERING_MODEL
    for (const { kind, value, runId } of this.records(loopId)) {
      if (kind === 'steering-model') {
        model = steeringModel(value.model)
      } else if (kind === 'steering-message') {
        const { role } = value
        if (role !== 'user' && role !== 'assistant' && role !== 'system') throw new Error('Invalid stored steering role.')
        messages.push({
          id: boundedText(value.id, 100), loopId, role, content: typeof value.content === 'string' && value.content.length <= 16000 ? value.content : boundedText(value.content, 16000), attachments: steeringAttachments(value.attachments, loopId),
          createdAt: boundedText(value.createdAt, 100), attemptId: runId,
        })
      } else if (kind === 'steering-directive') {
        if (!Array.isArray(value.sourceMessageIds) || value.sourceMessageIds.length > 1000) throw new Error('Invalid stored direction sources.')
        directives.push({
          id: boundedText(value.id, 100), messageId: boundedText(value.messageId, 100),
          text: boundedText(value.text, 6000), sourceMessageIds: value.sourceMessageIds.map(id => boundedText(id, 100)),
          attachmentIds: steeringIds(value.attachmentIds), assetChanges: steeringAssetChanges(value.assetChanges),
          loopId, withdrawn: false, firstRunId: null, firstRound: null,
        })
      } else if (kind === 'steering-withdraw') {
        const directive = directives.find(d => d.id === value.id)
        if (directive && !directive.firstRunId) directive.withdrawn = true
      } else if (kind === 'steering-snapshot') {
        const snapshot = snapshotFrom(value, loopId)
        if (typeof value.round !== 'number' || !Number.isSafeInteger(value.round) || value.round < 1) throw new Error('Invalid stored steering round.')
        if (value.role === 'implement') for (const included of snapshot.directives) {
          const directive = directives.find(d => d.id === included.id)
          if (directive && !directive.firstRunId) { directive.firstRunId = runId; directive.firstRound = value.round }
        }
      }
    }
    return { loopId, model, messages, directives, busy: this.ledger.unfinishedConsults().some(r => r.loopId === loopId) }
  }

  setModel(loopId: string, value: unknown): void {
    const model = steeringModel(value)
    if (this.steeringState(loopId).model !== model) this.append(loopId, null, 'steering-model', { model })
  }

  private append(loopId: string, runId: string | null, kind: string, value: unknown): void {
    const text = JSON.stringify(value)
    if (Buffer.byteLength(text) > 60000) throw new Error('Steering context is too large.')
    const run = runId ? this.ledger.getRun(runId) : null
    this.ledger.appendEvent({ loopId, runId, kind, text, ts: new Date().toISOString(), channel: 'system', role: run?.role, round: run?.round })
  }

  addSteeringMessage(loopId: string, role: SteeringMessage['role'], content: string, attemptId: string | null = null, id: string = crypto.randomUUID(), attachments: SteeringAttachment[] = []): string {
    this.append(loopId, attemptId, 'steering-message', { id, role, content, createdAt: new Date().toISOString(), attachments })
    return id
  }

  completeSteering(attemptId: string, reply: SteeringReply): void {
    const run = this.ledger.getRun(attemptId)!
    this.ledger.transaction(() => {
      const existing = this.steeringState(run.loopId).directives.reduce((sum, d) => sum + d.text.length, 0)
      if (existing + reply.directives.reduce((sum, d) => sum + d.text.length, 0) > 24000) throw new Error('This run has reached its steering context limit.')
      const messageId = this.addSteeringMessage(run.loopId, 'assistant', reply.reply, attemptId)
      for (const directive of reply.directives) this.append(run.loopId, attemptId, 'steering-directive', { id: crypto.randomUUID(), messageId, ...directive })
      this.ledger.patchRun(attemptId, { status: 'succeeded', summary: reply.reply, finishedAt: new Date().toISOString() })
    })
  }

  withdrawSteering(loopId: string, id: string): void {
    this.ledger.transaction(() => {
      const directive = this.steeringState(loopId).directives.find(d => d.id === id)
      if (!directive) throw new Error('Direction not found.')
      if (directive.firstRunId) throw new Error('This direction has already been included. Send another message to change it.')
      if (directive.withdrawn) return
      this.append(loopId, null, 'steering-withdraw', { id })
      this.addSteeringMessage(loopId, 'system', `Withdrawn before inclusion: ${directive.text}`)
    })
  }

  recordConsultPrompt(id: string): void {
    const run = this.ledger.getRun(id)!
    this.ledger.patchRun(id, { promptSha256: crypto.createHash('sha256').update(run.prompt).digest('hex') })
  }

  requirementsForRun(id: string): RequirementSnapshot | null {
    const run = this.ledger.getRun(id)
    if (!run) return null
    // Generic log queries truncate display text. Requirements must use the full durable event.
    const row = this.records(run.loopId).find(event => event.runId === id && event.kind === 'steering-snapshot')
    return row ? snapshotFrom(row.value, run.loopId) : null
  }

  /** Explicit Resume is a new operator boundary; automatic recovery keeps its frozen inputs. */
  includePendingOnResume(id: string): void {
    const run = this.ledger.getRun(id)
    if (!run || run.role !== 'implement' || run.status !== 'queued' || this.requirementsForRun(id)) return
    if (!this.steeringState(run.loopId).directives.some(d => !d.withdrawn && !d.firstRunId)) return
    this.freezeRequirements(id, undefined, true)
    this.addSteeringMessage(run.loopId, 'system', `Resume includes pending steering in this round ${run.round} implementation attempt. Earlier attempts retain their original instructions.`, id)
  }

  freezeRunRequirements(id: string, basePrompt?: string): RunRecord {
    return this.freezeRequirements(id, basePrompt, false)
  }

  private freezeRequirements(id: string, basePrompt: string | undefined, includePending: boolean): RunRecord {
    return this.ledger.transaction(() => {
      const run = this.ledger.getRun(id)!
      if ((run.role !== 'implement' && run.role !== 'critique') || run.status !== 'queued') return run
      let snapshot = this.requirementsForRun(id)
      let promptBase = basePrompt ?? run.prompt
      if (!snapshot) {
        const runs = this.ledger.runsForLoop(run.loopId)
        const implementation = run.role === 'critique'
          ? runs.filter(r => r.role === 'implement' && r.round === run.round && r.status === 'succeeded').at(-1)
          : null
        // A critic follows the successful attempt. Recovery follows the most recently frozen attempt.
        const earlier = this.records(run.loopId).filter(r => r.kind === 'steering-snapshot' && r.value.round === run.round && r.value.role === 'implement' && (!implementation || r.runId === implementation.id)).at(-1)
        const previous = earlier ? snapshotFrom(earlier.value, run.loopId) : null
        if (previous && !includePending) snapshot = previous
        else if (run.role === 'critique' || (!includePending && runs.some(r => r.id !== id && r.role === 'implement' && r.round === run.round && r.startedAt))) {
          snapshot = { implementationRunId: 'legacy', directives: [] }
        } else {
          const state = this.steeringState(run.loopId), active = state.directives.filter(d => !d.withdrawn)
          const attachmentIds = new Set(active.flatMap(d => d.attachmentIds ?? []))
          const work = new Map<string, NonNullable<RequirementSnapshot['assetWork']>[number]>()
          const retryTargets = new Set(includePending ? previous?.assetWork?.map(change => change.target) : [])
          for (const directive of active) for (const change of directive.assetChanges ?? []) {
            if (!directive.firstRunId || retryTargets.has(change.target)) work.set(change.target, change)
          }
          snapshot = {
            implementationRunId: id,
            directives: active.map(d => ({ id: d.id, text: d.text, attachmentIds: d.attachmentIds, assetChanges: d.assetChanges })),
            attachments: state.messages.flatMap(message => message.attachments ?? []).filter(file => attachmentIds.has(file.id)),
            assetWork: [...work.values()],
          }
          if (includePending && previous) {
            const oldDirections = withOperatorDirections('', previous, 'implement')
            if (oldDirections) promptBase = promptBase.replace(oldDirections, '')
          }
        }
        this.append(run.loopId, id, 'steering-snapshot', { ...snapshot, role: run.role, round: run.round })
        if (snapshot.directives.length) this.addSteeringMessage(run.loopId, 'system', `Round ${run.round} ${run.role === 'implement' ? 'implementation includes' : 'critique uses the same'} ${snapshot.directives.length} direction(s).`, id)
      }
      const prompt = withOperatorDirections(promptBase, snapshot, run.role)
      this.ledger.patchRun(id, { prompt, promptSha256: crypto.createHash('sha256').update(prompt).digest('hex') })
      return this.ledger.getRun(id)!
    })
  }
}
