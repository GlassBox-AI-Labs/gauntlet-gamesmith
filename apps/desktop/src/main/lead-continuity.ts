import { createHash } from 'node:crypto'
import type { Ledger } from './ledger'
import type { LoopLogLine, RunRecord, TokenTotals } from '../shared/loop'
import { channelForKind, markResumePrompt } from '../shared/loop'
import { extractLeadNotebook, parseLeadNotebook, parseLeadUsage, type LeadCheckpoint, type LeadDispatch, type LeadState } from '../shared/lead'
import { composeLeadPrompt } from '../shared/prompts'
import { normalizeSessionId } from '../shared/session-id'
import { commitRunningAttempt } from './run-transition'
import { usageForThread } from './codex-usage'

function record(text: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text)
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid lead history.')
  return value as Record<string, unknown>
}
function bounded(value: unknown, max: number): string {
  if (typeof value !== 'string' || value.length > max) throw new Error('Invalid lead history text.')
  return value
}

/** Owns session selection, recovery, and portable memory without granting imported session authority. */
export class LeadContinuity {
  constructor(private ledger: Ledger) {}

  private append(loopId: string, runId: string | null, kind: string, value: unknown): void {
    const text = JSON.stringify(value)
    if (Buffer.byteLength(text) > 60000) throw new Error('Lead memory exceeds its checkpoint size limit.')
    const run = runId ? this.ledger.getRun(runId) : null
    this.ledger.appendEvent({ loopId, runId, kind, text, ts: new Date().toISOString(),
      channel: channelForKind(kind),
      ...(run ? { role: run.role, round: run.round } : {}) })
  }

  enable(loopId: string): void {
    if (!this.state(loopId).enabled) this.append(loopId, null, 'lead-enabled', { version: 1 })
  }

  private dispatch(event: LoopLogLine): LeadDispatch {
    this.assertImplementationEvent(event)
    const value = record(event.text)
    if (value.mode !== 'new' && value.mode !== 'continued' && value.mode !== 'recovered') throw new Error('Invalid lead continuation mode.')
    const resumeId = value.resumeId === null ? null : normalizeSessionId(value.resumeId)
    if (value.resumeId !== null && !resumeId) throw new Error('Invalid lead session history.')
    return { runId: event.runId!, round: event.round!, mode: value.mode,
      fromRunId: value.fromRunId === null ? null : bounded(value.fromRunId, 100), resumeId, reason: bounded(value.reason, 1000),
      usageBaseline: value.usageBaseline == null ? null : parseLeadUsage(value.usageBaseline) }
  }

  private assertImplementationEvent(event: LoopLogLine): void {
    const run = event.runId ? this.ledger.getRun(event.runId) : null
    if (!run || run.loopId !== event.loopId || run.role !== 'implement' || run.round !== event.round) throw new Error('Lead history is not bound to an implementation attempt.')
  }

  private readCheckpoint(event: LoopLogLine): LeadCheckpoint {
    this.assertImplementationEvent(event)
    const value = record(event.text)
    return { runId: event.runId!, round: event.round!, createdAt: event.ts,
      notebook: value.notebook === null ? null : parseLeadNotebook(value.notebook),
      report: value.report === null ? null : bounded(value.report, 4000),
      warning: value.warning === null ? null : bounded(value.warning, 1000) }
  }

  state(loopId: string, checkpointOffset = 0): LeadState {
    if (!Number.isSafeInteger(checkpointOffset) || checkpointOffset < 0 || checkpointOffset > 10000) throw new Error('Invalid notebook history offset.')
    if (!this.ledger.getLoop(loopId)) throw new Error('Run not found.')
    const events = this.ledger.leadEvents(loopId)
    const checkpoints = events.filter(event => event.kind === 'lead-checkpoint')
    const dispatchEvent = events.filter(event => event.kind === 'lead-dispatch').at(-1)
    let dispatch = dispatchEvent ? this.dispatch(dispatchEvent) : null
    const reset = dispatch && events.find(event => event.kind === 'lead-session-reset' && event.runId === dispatch!.runId)
    if (reset) dispatch = { ...dispatch!, mode: 'recovered', reason: bounded(record(reset.text).reason, 1000) }
    const latestNotebook = checkpoints.slice().reverse().find(event => record(event.text).notebook !== null)
    return {
      enabled: events.some(event => event.kind === 'lead-enabled' && record(event.text).version === 1),
      dispatch,
      latestNotebook: latestNotebook ? this.readCheckpoint(latestNotebook) : null,
      totalCheckpoints: checkpoints.length,
      checkpointOffset,
      checkpoints: checkpoints.slice().reverse().slice(checkpointOffset, checkpointOffset + 20).map(event => this.readCheckpoint(event)),
    }
  }

  prepare(run: RunRecord, basePrompt: string, codexHome?: string): { prompt: string; resumeId: string | null; reason: string } {
    return this.ledger.transaction(() => {
      const loop = this.ledger.getLoop(run.loopId)!
      const state = this.state(run.loopId)
      if (!state.enabled || run.role !== 'implement') throw new Error('Continuing lead is not enabled for this implementation.')
      const events = this.ledger.leadEvents(run.loopId)
      const saved = events.find(event => event.kind === 'lead-dispatch' && event.runId === run.id)
      if (saved) {
        const dispatch = this.dispatch(saved)
        return { prompt: this.ledger.getRun(run.id)!.prompt, resumeId: loop.playTrusted ? dispatch.resumeId : null, reason: dispatch.reason }
      }
      const prior = this.ledger.priorLeadImplementations(run.id)
      const unavailable = new Set(events.filter(event => event.kind === 'lead-session-unavailable').map(event => record(event.text).sessionId))
      // Model aliases can be expanded by the CLI. The loop owns its model selection;
      // a reported dated model name must not break conversation continuity.
      const candidate = loop.playTrusted ? prior.find(attempt => attempt.harness === run.harness && attempt.sessionId) : null
      let resumeId = candidate?.sessionId && !unavailable.has(candidate.sessionId) ? candidate.sessionId : null
      let usageBaseline: TokenTotals | null = null
      let usageUnavailable = false
      if (resumeId && run.harness === 'codex') {
        // Local transcript totals include interrupted turns. Recorded totals are a fallback for completed turns.
        if (codexHome) usageBaseline = usageForThread(codexHome, resumeId)
        if (!usageBaseline) {
          const usage = events.filter(event => event.kind === 'lead-usage' && record(event.text).sessionId === resumeId).at(-1)
          if (usage) usageBaseline = parseLeadUsage(record(usage.text).tokens)
        }
        if (!usageBaseline) { resumeId = null; usageUnavailable = true }
      }
      const hasHistory = prior.length > 0 || state.checkpoints.length > 0
      const mode = resumeId ? 'continued' : hasHistory ? 'recovered' : 'new'
      const reason = resumeId
        ? `Continuing the lead from round ${candidate!.round}; current requirements override earlier decisions.`
        : !hasHistory ? 'Starting the run lead; its session and notebook carry forward across implementation rounds.'
          : !loop.playTrusted ? 'Fresh lead session for transferred history; restoring portable memory without adopting imported CLI sessions.'
            : usageUnavailable ? 'Prior session usage is unavailable; restoring memory in a fresh session so earlier rounds are not charged again.'
            : 'A prior lead session is unavailable; restoring saved memory in a fresh session.'
      const dispatch: LeadDispatch = { runId: run.id, round: run.round, mode, fromRunId: candidate?.id ?? prior[0]?.id ?? null, resumeId, reason, usageBaseline }
      const notebook = state.latestNotebook
      const recent = state.checkpoints[0] ?? null
      const prompt = composeLeadPrompt(basePrompt, { dispatch, notebook, recentReport: recent?.report ?? prior[0]?.summary ?? null })
      this.ledger.patchRun(run.id, { prompt, promptSha256: createHash('sha256').update(prompt).digest('hex') })
      this.append(run.loopId, run.id, 'lead-dispatch', dispatch)
      return { prompt, resumeId, reason }
    })
  }

  usageBaseline(run: RunRecord): TokenTotals | null {
    const event = this.ledger.leadEvents(run.loopId).find(event => event.kind === 'lead-dispatch' && event.runId === run.id)
    return event ? this.dispatch(event).usageBaseline ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } : null
  }

  recordUsage(run: RunRecord, sessionId: string, tokens: TokenTotals): void {
    this.append(run.loopId, run.id, 'lead-usage', { sessionId, tokens: parseLeadUsage(tokens) })
  }

  /** Detect a CLI silently choosing another session; memory continuity and usage must remain honest. */
  sessionStarted(run: RunRecord, sessionId: string): boolean {
    const events = this.ledger.leadEvents(run.loopId)
    const event = events.find(event => event.kind === 'lead-dispatch' && event.runId === run.id)
    const expected = event ? this.dispatch(event).resumeId : null
    if (!expected || expected === sessionId) return false
    if (!events.some(event => event.kind === 'lead-session-reset' && event.runId === run.id)) {
      this.append(run.loopId, run.id, 'lead-session-reset', { sessionId, reason: 'The CLI started a different session than requested. This lead is using the supplied saved memory; its earlier conversation was not continued.' })
    }
    return true
  }

  checkpoint(run: RunRecord, response: string | null): LeadCheckpoint | null {
    const state = this.state(run.loopId)
    if (!state.enabled) return null
    const existing = state.checkpoints.find(checkpoint => checkpoint.runId === run.id)
    if (existing) return existing
    let notebook: LeadCheckpoint['notebook'] = null
    let warning: string | null = null
    try {
      notebook = extractLeadNotebook(response ?? '', run.id)
      if (!notebook) warning = 'No structured notebook was returned. The attempt report is saved; earlier notebook entries may be stale.'
      if (notebook && Buffer.byteLength(JSON.stringify(notebook)) > 40000) throw new Error('Lead notebook exceeds its byte limit.')
    } catch (error) { notebook = null; warning = error instanceof Error ? error.message : 'Invalid lead notebook.' }
    const checkpoint: LeadCheckpoint = { runId: run.id, round: run.round, createdAt: new Date().toISOString(),
      notebook, report: response?.slice(0, 4000) || null, warning }
    this.append(run.loopId, run.id, 'lead-checkpoint', checkpoint)
    return checkpoint
  }

  /** Called only for a proven lookup rejection before any agent work, after process settlement. */
  recoverUnavailableSession(run: RunRecord, rejected: boolean, onQueued: (runId: string) => void = () => {}): boolean {
    if (!rejected) return false
    const event = this.ledger.leadEvents(run.loopId).filter(event => event.kind === 'lead-dispatch' && event.runId === run.id).at(-1)
    const dispatch = event ? this.dispatch(event) : null
    if (!dispatch?.resumeId) return false
    const loop = this.ledger.getLoop(run.loopId)!
    if (loop.budgetUsd && loop.totalCostUsd + (this.ledger.getRun(run.id)?.costUsd ?? 0) >= loop.budgetUsd) return false
    return commitRunningAttempt(this.ledger, run.loopId, run.id, { status: 'interrupted', error: 'Saved lead session was unavailable; queued recovery from durable memory.' }, () => {
      this.append(run.loopId, run.id, 'lead-session-unavailable', { sessionId: dispatch.resumeId, reason: 'CLI rejected the saved session before any work. Recovering in a fresh session.' })
      const retry = this.ledger.createRun({ loopId: run.loopId, round: run.round, role: 'implement', harness: run.harness, prompt: markResumePrompt(this.ledger.getRun(run.id)!.prompt) })
      onQueued(retry.id)
    })
  }
}
