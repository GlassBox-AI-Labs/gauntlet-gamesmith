import { createHash } from 'node:crypto'
import type { Ledger } from './ledger'
import type { BuildLogLine, PhaseAttempt, TokenTotals } from '../shared/build'
import { channelForKind, markResumePrompt } from '../shared/build'
import { extractLeadNotebook, parseLeadNotebook, parseLeadUsage, type LeadCheckpoint, type LeadDispatch, type LeadState } from '../shared/lead'
import { composeLeadPrompt } from '../shared/prompts'
import { normalizeSessionId } from '../shared/session-id'
import { commitRunningAttempt } from './attempt-transition'
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

  private append(buildId: string, attemptId: string | null, kind: string, value: unknown): void {
    const text = JSON.stringify(value)
    if (Buffer.byteLength(text) > 60000) throw new Error('Lead memory exceeds its checkpoint size limit.')
    const attempt = attemptId ? this.ledger.getAttempt(attemptId) : null
    this.ledger.appendEvent({ buildId, attemptId, kind, text, ts: new Date().toISOString(),
      channel: channelForKind(kind),
      ...(attempt ? { role: attempt.role, round: attempt.round } : {}) })
  }

  enable(buildId: string): void {
    if (!this.state(buildId).enabled) this.append(buildId, null, 'lead-enabled', { version: 1 })
  }

  private dispatch(event: BuildLogLine): LeadDispatch {
    this.assertImplementationEvent(event)
    const value = record(event.text)
    if (value.mode !== 'new' && value.mode !== 'continued' && value.mode !== 'recovered') throw new Error('Invalid lead continuation mode.')
    const fromAttemptId = value.fromAttemptId !== undefined ? value.fromAttemptId : value.fromRunId
    const resumeId = value.resumeId === null ? null : normalizeSessionId(value.resumeId)
    if (value.resumeId !== null && !resumeId) throw new Error('Invalid lead session history.')
    return { attemptId: event.attemptId!, round: event.round!, mode: value.mode,
      fromAttemptId: fromAttemptId === null ? null : bounded(fromAttemptId, 100), resumeId, reason: bounded(value.reason, 1000),
      usageBaseline: value.usageBaseline == null ? null : parseLeadUsage(value.usageBaseline) }
  }

  private assertImplementationEvent(event: BuildLogLine): void {
    const attempt = event.attemptId ? this.ledger.getAttempt(event.attemptId) : null
    if (!attempt || attempt.buildId !== event.buildId || attempt.role !== 'implement' || attempt.round !== event.round) throw new Error('Lead history is not bound to an implementation attempt.')
  }

  private readCheckpoint(event: BuildLogLine): LeadCheckpoint {
    this.assertImplementationEvent(event)
    const value = record(event.text)
    return { attemptId: event.attemptId!, round: event.round!, createdAt: event.ts,
      notebook: value.notebook === null ? null : parseLeadNotebook(value.notebook),
      report: value.report === null ? null : bounded(value.report, 4000),
      warning: value.warning === null ? null : bounded(value.warning, 1000) }
  }

  state(buildId: string, checkpointOffset = 0): LeadState {
    if (!Number.isSafeInteger(checkpointOffset) || checkpointOffset < 0 || checkpointOffset > 10000) throw new Error('Invalid notebook history offset.')
    if (!this.ledger.getBuild(buildId)) throw new Error('Build not found.')
    const events = this.ledger.leadEvents(buildId)
    const checkpoints = events.filter(event => event.kind === 'lead-checkpoint')
    const dispatchEvent = events.filter(event => event.kind === 'lead-dispatch').at(-1)
    let dispatch = dispatchEvent ? this.dispatch(dispatchEvent) : null
    const reset = dispatch && events.find(event => event.kind === 'lead-session-reset' && event.attemptId === dispatch!.attemptId)
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

  prepare(attempt: PhaseAttempt, basePrompt: string, codexHome?: string): { prompt: string; resumeId: string | null; reason: string } {
    return this.ledger.transaction(() => {
      const build = this.ledger.getBuild(attempt.buildId)!
      const state = this.state(attempt.buildId)
      if (!state.enabled || attempt.role !== 'implement') throw new Error('Continuing lead is not enabled for this implementation.')
      const events = this.ledger.leadEvents(attempt.buildId)
      const saved = events.find(event => event.kind === 'lead-dispatch' && event.attemptId === attempt.id)
      if (saved) {
        const dispatch = this.dispatch(saved)
        return { prompt: this.ledger.getAttempt(attempt.id)!.prompt, resumeId: build.playTrusted ? dispatch.resumeId : null, reason: dispatch.reason }
      }
      const prior = this.ledger.priorLeadImplementations(attempt.id)
      const unavailable = new Set(events.filter(event => event.kind === 'lead-session-unavailable').map(event => record(event.text).sessionId))
      // Model aliases can be expanded by the CLI. The build owns its model selection;
      // a reported dated model name must not break conversation continuity.
      const candidate = build.playTrusted ? prior.find(priorAttempt => priorAttempt.harness === attempt.harness && priorAttempt.sessionId) : null
      let resumeId = candidate?.sessionId && !unavailable.has(candidate.sessionId) ? candidate.sessionId : null
      let usageBaseline: TokenTotals | null = null
      let usageUnavailable = false
      if (resumeId && attempt.harness === 'codex') {
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
        : !hasHistory ? 'Starting the build lead; its session and notebook carry forward across implementation rounds.'
          : !build.playTrusted ? 'Fresh lead session for transferred history; restoring portable memory without adopting imported CLI sessions.'
            : usageUnavailable ? 'Prior session usage is unavailable; restoring memory in a fresh session so earlier rounds are not charged again.'
            : 'A prior lead session is unavailable; restoring saved memory in a fresh session.'
      const dispatch: LeadDispatch = { attemptId: attempt.id, round: attempt.round, mode, fromAttemptId: candidate?.id ?? prior[0]?.id ?? null, resumeId, reason, usageBaseline }
      const notebook = state.latestNotebook
      const recent = state.checkpoints[0] ?? null
      const prompt = composeLeadPrompt(basePrompt, { dispatch, notebook, recentReport: recent?.report ?? prior[0]?.summary ?? null })
      this.ledger.patchAttempt(attempt.id, { prompt, promptSha256: createHash('sha256').update(prompt).digest('hex') })
      this.append(attempt.buildId, attempt.id, 'lead-dispatch', dispatch)
      return { prompt, resumeId, reason }
    })
  }

  usageBaseline(attempt: PhaseAttempt): TokenTotals | null {
    const event = this.ledger.leadEvents(attempt.buildId).find(event => event.kind === 'lead-dispatch' && event.attemptId === attempt.id)
    return event ? this.dispatch(event).usageBaseline ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } : null
  }

  recordUsage(attempt: PhaseAttempt, sessionId: string, tokens: TokenTotals): void {
    this.append(attempt.buildId, attempt.id, 'lead-usage', { sessionId, tokens: parseLeadUsage(tokens) })
  }

  /** Detect a CLI silently choosing another session; memory continuity and usage must remain honest. */
  sessionStarted(attempt: PhaseAttempt, sessionId: string): boolean {
    const events = this.ledger.leadEvents(attempt.buildId)
    const event = events.find(event => event.kind === 'lead-dispatch' && event.attemptId === attempt.id)
    const expected = event ? this.dispatch(event).resumeId : null
    if (!expected || expected === sessionId) return false
    if (!events.some(event => event.kind === 'lead-session-reset' && event.attemptId === attempt.id)) {
      this.append(attempt.buildId, attempt.id, 'lead-session-reset', { sessionId, reason: 'The CLI started a different session than requested. This lead is using the supplied saved memory; its earlier conversation was not continued.' })
    }
    return true
  }

  checkpoint(attempt: PhaseAttempt, response: string | null): LeadCheckpoint | null {
    const state = this.state(attempt.buildId)
    if (!state.enabled) return null
    const existing = state.checkpoints.find(checkpoint => checkpoint.attemptId === attempt.id)
    if (existing) return existing
    let notebook: LeadCheckpoint['notebook'] = null
    let warning: string | null = null
    try {
      notebook = extractLeadNotebook(response ?? '', attempt.id)
      if (!notebook) warning = 'No structured notebook was returned. The attempt report is saved; earlier notebook entries may be stale.'
      if (notebook && Buffer.byteLength(JSON.stringify(notebook)) > 40000) throw new Error('Lead notebook exceeds its byte limit.')
    } catch (error) { notebook = null; warning = error instanceof Error ? error.message : 'Invalid lead notebook.' }
    const checkpoint: LeadCheckpoint = { attemptId: attempt.id, round: attempt.round, createdAt: new Date().toISOString(),
      notebook, report: response?.slice(0, 4000) || null, warning }
    this.append(attempt.buildId, attempt.id, 'lead-checkpoint', checkpoint)
    return checkpoint
  }

  /** Called only for a proven lookup rejection before any agent work, after process settlement. */
  recoverUnavailableSession(attempt: PhaseAttempt, rejected: boolean, onQueued: (attemptId: string) => void = () => {}): boolean {
    if (!rejected) return false
    const event = this.ledger.leadEvents(attempt.buildId).filter(event => event.kind === 'lead-dispatch' && event.attemptId === attempt.id).at(-1)
    const dispatch = event ? this.dispatch(event) : null
    if (!dispatch?.resumeId) return false
    const build = this.ledger.getBuild(attempt.buildId)!
    if (build.budgetUsd && build.totalCostUsd + (this.ledger.getAttempt(attempt.id)?.costUsd ?? 0) >= build.budgetUsd) return false
    return commitRunningAttempt(this.ledger, attempt.buildId, attempt.id, { status: 'interrupted', error: 'Saved lead session was unavailable; queued recovery from durable memory.' }, () => {
      this.append(attempt.buildId, attempt.id, 'lead-session-unavailable', { sessionId: dispatch.resumeId, reason: 'CLI rejected the saved session before any work. Recovering in a fresh session.' })
      const retry = this.ledger.createAttempt({ buildId: attempt.buildId, round: attempt.round, role: 'implement', harness: attempt.harness, prompt: markResumePrompt(this.ledger.getAttempt(attempt.id)!.prompt) })
      onQueued(retry.id)
    })
  }
}
