import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AccountRotation, HarnessKind, ProbeResult } from '../shared/harness'
import type {
  LoopLogLine,
  LoopModels,
  LoopRecord,
  LoopSnapshot,
  RunRecord,
  RunRole,
  StartLoopInput,
  StartLoopResult,
  Verdict,
} from '../shared/loop'
import { channelForKind, markResumePrompt, runPromptLabel } from '../shared/loop'
import { IPC } from '../shared/ipc'
import { describeModels, harnessFor, isUltracode, resolveModels } from '../shared/models'
import { buildCriticPrompt, buildReferencePrompt, composeImplementPrompt, effectivePromptForRun } from '../shared/prompts'
import { redactLogText, redactedErrorMessage } from '../shared/redact-log'
import { referencePackDir, referenceRootForLoop } from '../shared/reference-path'
import {
  assertChildStreamBoundary,
  childrenActive,
  observeChildStreams,
  recoverChildStreams,
  type ChildStreamBoundary,
} from './child-agents'
import { archiveChildStreams } from './child-stream-archive'
import { assetTargets, parseCast, type CastEntry, unbuiltCast, scaffoldAssetTools } from './asset-phase'
import { cliExecutable, validatedExecutableEnv } from './cli-executable'
import { delegationRules, GAUNTLET_IMPLEMENTER_AGENT_PREFIX, implementerAgentDefinition, researchRules, sculptorAgentMd, sculptorRules } from './delegation'
import { engineContract, engineGateRules, scaffoldEngine } from './engine-stack'
import { critiquePlan, implementPlan, referencePlan } from './harness-plans'
import { cliHome, ensureSkill, subscriptionEnv } from './harness-env'
import { parseClaudeStatus, parseCodexStatus } from './harness-status'
import { subscriptionReadiness, type SubscriptionReadiness } from './harness-subscription'
import type { Ledger, RunProcessOwnership } from './ledger'
import { publishOwnedWorkspaceFile, publishOwnedWorkspaceSnapshot, writeWorkspaceFileSafely } from './owned-workspace-write'
import { phaseTreeFingerprint, referencePackFingerprint } from './phase-contracts'
import { PRICE_TABLE_VERSION } from './pricing'
import { isRateLimitError, MAX_RATE_LIMIT_PAUSES, rateLimitPause, retryAtFromError } from './rate-limit'
import { scanReferencePack } from './reference-pack'
import { buildReport, scanCritiqueArtifacts } from './report'
import { createCritiqueProtocol } from './roles/critique'
import { createClaudeImplementProtocol } from './roles/implement-claude'
export { implementCostUsd, implementTokens } from './roles/implement-claude'
import { createCodexImplementProtocol } from './roles/implement-codex'
import { finalizeImplement, type ImplementOutcome } from './roles/implement-finalize'
import { createReferenceProtocol } from './roles/reference'
import type { ExitInfo, LogGate, StreamParser } from './roles/types'
import { planCompletion, planResume } from './round-planner'
import { captureRoundRevision, workspaceMatchesRevision } from './round-revision'
import {
  completeProcessMeta,
  interruptCapturedProcessGroup,
  interruptProcessGroup,
  prepareProcessMeta,
  processMatches,
  processGroupIdentity,
  processGroupStillOwned,
  processMetaPath,
  processStreamPaths,
  safePid,
  type ProcessStreamIdentity,
  type RunProcessMeta,
} from './run-process'
import { commitRunningAttempt } from './run-transition'
import { ChildStreamTailer } from './streams/child-tailer'
import { prepareVerdictArtifact } from './verdict'
import { assertWorkspaceBoundary, captureWorkspaceIdentity } from './workspace-boundary'
import { boundedLoopSnapshot } from './ipc-projection'

/**
 * How long a run may make no progress before we call it stuck. This is idle
 * time, not total runtime: a fan-out that works for four hours is healthy, and
 * killing it at a fixed wall-clock limit threw away 2h15m of finished agent
 * work mid final-verification. A hard ceiling still backstops a wedged process.
 */
const IMPLEMENT_IDLE_MS = 40 * 60_000
const IMPLEMENT_HARD_CAP_MS = 12 * 60 * 60_000
const CRITIQUE_TIMEOUT_MS = 60 * 60_000
const REFERENCE_TIMEOUT_MS = 60 * 60_000
/** No write to a delegated worker's stream for this long counts as finished. */
const CHILD_QUIET_MS = 2 * 60_000
const MAX_CRITIQUE_ATTEMPTS = 2
const MAX_REFERENCE_ATTEMPTS = 2
const MAX_ACCOUNT_ROTATIONS = 3
const MAX_LIMIT_WAIT_MS = 6 * 60 * 60 * 1_000
const MAX_STREAM_READ_BYTES = 1024 * 1024
const MAX_PARTIAL_LINE_CHARS = 256 * 1024
const UNTRUSTED_HISTORY_MESSAGE = 'Untrusted history (imported or created before trust provenance shipped) is read-only; start a new trusted run in this workspace.'
const UNSAFE_WORKSPACE_MESSAGE = 'Workspace safety check failed: the path overlaps private app data or CLI credential homes. Start a new trusted run in a separate project folder.'
const UNKNOWN_LAUNCH_OWNERSHIP = 'Launch identity was not durably recorded before the app exited.'

function requireWorkspaceIdentity(loop: Pick<LoopRecord, 'workspaceIdentity'>): { dev: number; ino: number } {
  if (!loop.workspaceIdentity) throw new Error('Workspace identity is unavailable; app-owned publication is blocked.')
  return loop.workspaceIdentity
}

function trunc(value: string, max: number): string {
  const flat = value.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

function detectCliVersion(binary: string, env: Record<string, string>, cwd: string): string {
  const result = spawnSync(binary, ['--version'], { cwd, env, encoding: 'utf8', timeout: 5_000, maxBuffer: 64 * 1024 })
  const output = (result.stdout || result.stderr || '').trim().replace(/\s+/g, ' ')
  return result.status === 0 && output ? output.slice(0, 200) : 'unavailable'
}

export function accountLabelForProbe(kind: HarnessKind, probe: ProbeResult): string {
  const preferred = kind === 'claude' ? ['Email', 'Organization', 'Login method'] : ['Provider', 'Auth']
  const values = preferred.map((label) => probe.details?.find(([key]) => key === label)?.[1]).filter(Boolean)
  const bounded = values.join(':').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 220)
  const label = kind === 'codex'
    ? `codex:app-profile-1:${bounded || 'profile-unavailable'}`
    : `claude:${bounded || 'profile-unavailable'}`
  return redactLogText(label).slice(0, 255)
}

function detectAccountLabel(kind: HarnessKind, binary: string, env: Record<string, string>, cwd: string): string {
  const args = kind === 'claude' ? ['auth', 'status', '--json'] : ['login', 'status']
  const result = spawnSync(binary, args, { cwd, env, encoding: 'utf8', timeout: 8_000, maxBuffer: 64 * 1024 })
  const probe = kind === 'claude'
    ? parseClaudeStatus(result.stdout, result.stderr, null)
    : parseCodexStatus(result.status === 0, result.stdout, result.stderr, null)
  return accountLabelForProbe(kind, probe)
}

interface DetachedSpawnOptions {
  cwd: string
  env: Record<string, string>
  detached: true
  stdio: ['ignore', number, number]
}

/** Internal orchestration seams; production defaults stay behind one boundary. */
export interface LoopRunnerDeps {
  now(): number
  wait(ms: number): Promise<void>
  defer(work: () => void, ms: number): NodeJS.Timeout
  cancelDeferred(timer: NodeJS.Timeout): void
  repeat(work: () => void, ms: number): NodeJS.Timeout
  cancelRepeat(timer: NodeJS.Timeout): void
  spawnChild(command: string, args: string[], options: DetachedSpawnOptions): ReturnType<typeof spawn>
  completeProcessMeta(
    workspaceDir: string,
    runId: string,
    marker: ReturnType<typeof prepareProcessMeta>,
    pid: number,
    streams: ProcessStreamIdentity,
    groupIdentities: readonly string[],
  ): RunProcessMeta
  signalProcess(pid: number, signal: 0 | NodeJS.Signals): void
  processGroupIdentity(groupId: number): readonly string[]
  processGroupStillOwned(groupId: number, identity: readonly string[]): boolean
  cliVersion(binary: string, env: Record<string, string>, cwd: string): string
  accountLabel(kind: HarnessKind, binary: string, env: Record<string, string>, cwd: string): string
  hostname(): string
  harnessHome(kind: 'claude' | 'codex'): string
  protectedRoots(): string[]
  subscriptionReady(kind: HarnessKind, cwd: string, harnessHome: string): SubscriptionReadiness
  cliExecutable(kind: HarnessKind, unsafeRoots: readonly string[]): string
  validatedExecutableEnv(executables: ReadonlyMap<HarnessKind, string>, unsafeRoots: readonly string[]): Record<string, string>
  rotateAccount?(kind: HarnessKind, error: string): Promise<AccountRotation>
}

const DEFAULT_DEPS: LoopRunnerDeps = {
  now: () => Date.now(),
  wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  defer: (work, ms) => setTimeout(work, ms),
  cancelDeferred: (timer) => clearTimeout(timer),
  repeat: (work, ms) => setInterval(work, ms),
  cancelRepeat: (timer) => clearInterval(timer),
  spawnChild: (command, args, options) => spawn(command, args, options),
  completeProcessMeta: (workspaceDir, runId, marker, pid, streams, groupIdentities) => completeProcessMeta(
    workspaceDir,
    runId,
    marker,
    pid,
    undefined,
    streams,
    groupIdentities,
  ),
  signalProcess: (pid, signal) => process.kill(pid, signal),
  processGroupIdentity,
  processGroupStillOwned,
  cliVersion: detectCliVersion,
  accountLabel: detectAccountLabel,
  hostname: os.hostname,
  harnessHome: cliHome,
  protectedRoots: () => [cliHome('claude'), cliHome('codex')],
  subscriptionReady: (kind, cwd, home) => subscriptionReadiness(kind, cwd, home),
  cliExecutable,
  validatedExecutableEnv,
}

function buildImplementPrompt(
  models: LoopModels,
  userPrompt: string,
  round: number,
  verdict: Verdict | null,
  referenceDir: string,
  wanted: CastEntry[] = [],
): string {
  const rules = [delegationRules(models, referenceDir), wanted.length > 0 ? sculptorRules(models, referenceDir) : '']
    .filter(Boolean)
    .join(' ')
  return composeImplementPrompt(userPrompt, round, verdict, rules, referenceDir, engineContract(), wanted)
}

interface ExitHolder {
  exited: boolean
  code: number | null
  spawnError: string | null
}

interface Attachment {
  loopId: string
  runId: string
  meta: RunProcessMeta
  timedOut: boolean
}

export class LoopRunner {
  private current: Attachment | null = null
  private stopRequested = new Set<string>()
  private retryTimers = new Map<string, NodeJS.Timeout>()
  /** Account changes spent per loop, bounded independently of retry pauses. */
  private rotations = new Map<string, number>()
  /** Newly spawned groups whose durable identity write failed remain owned until exit/escalation. */
  private terminatingLoops = new Set<string>()
  /** A run has at most one bounded signal escalation chain. */
  private interruptingRuns = new Set<string>()
  /** Child streams of the run being driven; also pumped while awaiting stragglers. */
  private childTail: { loopId: string; runId: string; boundary: ChildStreamBoundary; tailer: ChildStreamTailer } | null = null
  /** IPC notifications queued until their enclosing ledger transaction commits. */
  private logNotificationBuffer: LoopLogLine[] | null = null
  /** Renderer/report refreshes requested during a transaction run only after commit. */
  private broadcastBuffer: Set<string> | null = null
  private deps: LoopRunnerDeps

  constructor(
    private ledger: Ledger,
    private send: (channel: string, payload: unknown) => void,
    deps: Partial<LoopRunnerDeps> | ((kind: HarnessKind, error: string) => Promise<AccountRotation>) = {},
  ) {
    this.deps = typeof deps === 'function'
      ? { ...DEFAULT_DEPS, rotateAccount: deps }
      : { ...DEFAULT_DEPS, ...deps }
  }

  private nowIso(): string {
    return new Date(this.deps.now()).toISOString()
  }

  snapshot(): LoopSnapshot | null {
    const loop = this.ledger.runningLoop() ?? this.ledger.latestLoop()
    if (!loop) return null
    const totalRuns = this.ledger.runCount(loop.id)
    const projection = this.ledger.recentRunProjectionForLoop(loop.id, 200)
    return boundedLoopSnapshot({
      loop,
      runs: projection.runs,
      totalRuns,
      hasMoreRuns: totalRuns > projection.runs.length,
      detailTruncated: projection.truncatedFields,
      aggregate: this.ledger.runAggregate(loop.id),
    })
  }

  /** New loops own a scoped pack; pre-v1 loops keep using their legacy root. */
  private referenceDir(loopId: string): string {
    return referenceRootForLoop(
      loopId,
      this.ledger.hasRunRole(loopId, 'reference'),
    )
  }

  private referenceFingerprint(loopId: string): string | null {
    const referenceId = this.ledger.firstSucceededRunIdForRole(loopId, 'reference')
    if (!referenceId) return null
    const prefix = 'Reference Pack frozen at sha256:'
    const text = this.ledger.eventTextForRunWithPrefix(referenceId, prefix)
    return text?.slice(prefix.length).trim() ?? null
  }

  /** Fail closed when a later phase sees a changed frozen Reference Pack. */
  private verifyReferenceBoundary(loop: LoopRecord, run: RunRecord, terminalLog?: { kind: string; text: string }): boolean {
    const pack = scanReferencePack(loop.workspaceDir, this.referenceDir(loop.id), loop)
    if (!pack.ready) {
      const message = pack.issues.join('; ')
      this.failAttemptAndLoop(
        loop,
        run,
        `Reference Pack is not ready: ${message}`,
        `Frozen Reference Pack failed its phase-boundary scan before ${run.role}: ${message}`,
        terminalLog,
      )
      return false
    }
    let actual: string
    try {
      actual = referencePackFingerprint(loop.workspaceDir, this.referenceDir(loop.id))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.failAttemptAndLoop(
        loop,
        run,
        `Reference Pack verification failed: ${message}`,
        `Frozen Reference Pack could not be verified before ${run.role}: ${message}`,
        terminalLog,
      )
      return false
    }
    const expected = this.referenceFingerprint(loop.id)
    if (!expected) {
      // Compatibility for runs created before pack fingerprints: bind once at
      // the first safe phase seam, then enforce it for every later attempt.
      const referenceId = this.ledger.firstSucceededRunIdForRole(loop.id, 'reference')
      this.log(loop.id, referenceId, 'artifact', `Reference Pack frozen at sha256:${actual}`)
      return true
    }
    if (actual === expected) return true
    this.log(loop.id, run.id, 'error', `Phase boundary rejected: Reference Pack changed (expected ${expected}, found ${actual}).`)
    this.failAttemptAndLoop(
      loop,
      run,
      'Frozen Reference Pack changed before phase execution.',
      `Frozen Reference Pack changed before round ${run.round} ${run.role}.`,
      terminalLog,
    )
    return false
  }

  /** Bind the research phase to the source tree that existed before it ran. */
  private ensureReferenceSourceBaseline(loop: LoopRecord, run: RunRecord, terminalLog?: { kind: string; text: string }): boolean {
    try {
      if (run.revision) {
        if (workspaceMatchesRevision(loop.workspaceDir, loop.id, run.revision)) return true
        throw new Error(`workspace no longer matches source baseline ${run.revision.slice(0, 12)}`)
      }
      const revision = captureRoundRevision({ workspaceDir: loop.workspaceDir, loopId: loop.id, round: 0 })
      this.ledger.patchRun(run.id, { revision })
      run.revision = revision
      this.log(loop.id, run.id, 'artifact', `Reference source baseline frozen at revision ${revision}.`)
      return true
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.log(loop.id, run.id, 'error', `Reference source boundary rejected: ${message}`)
      this.failAttemptAndLoop(
        loop,
        run,
        `Reference source boundary rejected: ${message}`,
        `Reference Study could not prove that project source stayed unchanged: ${message}`,
        terminalLog,
      )
      return false
    }
  }

  private critiqueTreeBaseline(runId: string): string | null {
    const prefix = 'Critique evidence baseline frozen at sha256:'
    return this.ledger.eventsForRun(runId, 'artifact', 100).find((event) => event.text.startsWith(prefix))?.text.slice(prefix.length).trim() ?? null
  }

  private copyCritiqueTreeBaseline(sourceRunId: string, targetRunId: string): void {
    const baseline = this.critiqueTreeBaseline(sourceRunId)
    if (baseline) this.log(this.ledger.getRun(targetRunId)!.loopId, targetRunId, 'artifact', `Critique evidence baseline frozen at sha256:${baseline}`)
  }

  /** Implementers may read prior critique but cannot forge or replace it. */
  private verifyCritiqueTreeBoundary(loop: LoopRecord, run: RunRecord, bind: boolean, terminalLog?: { kind: string; text: string }): boolean {
    try {
      const actual = phaseTreeFingerprint(loop.workspaceDir, 'critique')
      const expected = this.critiqueTreeBaseline(run.id)
      if (!expected && bind) {
        this.log(loop.id, run.id, 'artifact', `Critique evidence baseline frozen at sha256:${actual}`)
        return true
      }
      if (expected === actual) return true
      throw new Error(expected ? `expected ${expected}, found ${actual}` : 'no pre-launch baseline was recorded')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.log(loop.id, run.id, 'error', `Critique evidence boundary rejected: ${message}`)
      this.failAttemptAndLoop(
        loop,
        run,
        `Critique evidence boundary rejected: ${message}`,
        `Round ${run.round} implement could not prove critique evidence stayed unchanged: ${message}`,
        terminalLog,
      )
      return false
    }
  }

  private scheduleRetry(loopId: string, retryAtMs: number): void {
    if (this.retryTimers.has(loopId)) return
    const delay = Math.max(0, retryAtMs - this.deps.now())
    const timer = this.deps.defer(() => {
      this.retryTimers.delete(loopId)
      void this.executeNext(loopId)
    }, delay)
    timer.unref()
    this.retryTimers.set(loopId, timer)
  }

  private queuedRetryAt(loopId: string): number | null {
    const latest = this.ledger.latestInterruptedRunForLoop(loopId)
    return retryAtFromError(latest?.error ?? null)
  }

  /** Try another configured subscription profile before falling back to a pause. */
  private async rotateForUsageLimit(
    loop: LoopRecord,
    run: RunRecord,
    error: string,
  ): Promise<{ rotated: boolean; waitMs?: number; message?: string | null }> {
    if (!isRateLimitError(error) || !this.deps.rotateAccount) return { rotated: false, message: null }
    const used = this.rotations.get(loop.id) ?? 0
    if (used >= MAX_ACCOUNT_ROTATIONS) {
      return {
        rotated: false,
        message: `Stopped after changing accounts ${MAX_ACCOUNT_ROTATIONS} time(s); reconnect an account on the Agents tab, then Resume.`,
      }
    }
    const outcome = await this.deps.rotateAccount(run.harness, error)
    if (outcome.ok) {
      this.rotations.set(loop.id, used + 1)
      this.log(loop.id, run.id, 'system', `Usage window exhausted on ${outcome.from}; continuing with ${outcome.to ?? 'the next account'}.`)
      return { rotated: true }
    }
    const waitMs = outcome.resetAt == null ? null : outcome.resetAt - this.deps.now()
    if (waitMs != null && waitMs > 0 && waitMs <= MAX_LIMIT_WAIT_MS) {
      this.log(loop.id, run.id, 'system', `Every usable account is cooling down; retrying when the first window reopens in ${Math.ceil(waitMs / 60_000)}m.`)
      return { rotated: true, waitMs }
    }
    return {
      rotated: false,
      message: `${outcome.from} is rate limited and ${outcome.reason ?? 'no other account can take over'}. Connect or refresh an account on the Agents tab, then Resume.`,
    }
  }

  /** Persist a failed phase and loop, charging a running attempt once. */
  private failAttemptAndLoop(loop: LoopRecord, run: RunRecord, error: string, reason: string, terminalLog?: { kind: string; text: string }): boolean {
    let applied = commitRunningAttempt(this.ledger, loop.id, run.id, {
      status: 'failed',
      error,
      finishedAt: this.nowIso(),
    }, () => {
      if (terminalLog) this.persistLog(loop.id, run.id, terminalLog.kind, terminalLog.text)
      this.persistLoopTerminal(loop.id, 'failed', reason)
    })
    if (!applied && this.ledger.getRun(run.id)?.status === 'queued') {
      this.ledger.transaction(() => {
        if (this.ledger.getRun(run.id)?.status !== 'queued') return
        this.ledger.patchRun(run.id, { status: 'failed', error, finishedAt: this.nowIso() })
        if (terminalLog) this.persistLog(loop.id, run.id, terminalLog.kind, terminalLog.text)
        this.persistLoopTerminal(loop.id, 'failed', reason)
        applied = true
      })
    }
    if (applied) {
      if (terminalLog) this.notifyPersistedLog(loop.id, run.id, terminalLog.kind, terminalLog.text)
      this.finishLoop(loop.id, 'failed', reason)
    }
    return applied
  }

  private async retryRateLimit(loop: LoopRecord, run: RunRecord, error: string, terminalLog?: { kind: string; text: string }): Promise<boolean> {
    const priorPauses = this.ledger.rateLimitPauseCount(loop.id, run.role, run.round)
    if (!isRateLimitError(error)) return false
    const rotation = await this.rotateForUsageLimit(loop, run, error)
    if (priorPauses >= MAX_RATE_LIMIT_PAUSES) {
      const reason = `${run.role} remains rate limited after ${MAX_RATE_LIMIT_PAUSES} automatic pauses; Resume later to retry without losing phase progress.`
      const applied = commitRunningAttempt(this.ledger, loop.id, run.id, {
        status: 'interrupted',
        error: `Automatic rate-limit pause budget reached after ${MAX_RATE_LIMIT_PAUSES} pauses. ${error}`,
      }, () => {
        if (terminalLog) this.persistLog(loop.id, run.id, terminalLog.kind, terminalLog.text)
        this.persistLoopTerminal(loop.id, 'stopped', reason)
      })
      if (applied) {
        if (terminalLog) this.notifyPersistedLog(loop.id, run.id, terminalLog.kind, terminalLog.text)
        this.finishLoop(loop.id, 'stopped', reason)
      }
      return true
    }
    const pause = rotation.rotated
      ? {
          delayMs: rotation.waitMs ?? 0,
          retryAtMs: this.deps.now() + (rotation.waitMs ?? 0),
        }
      : rateLimitPause(error, priorPauses, this.deps.now())
    if (!pause) return false
    if (this.budgetReached(loop.id, this.ledger.getRun(run.id)?.costUsd ?? 0)) {
      const latest = this.ledger.getLoop(loop.id)
      const reason = latest?.budgetUsd
        ? `Budget ceiling hit: $${latest.totalCostUsd.toFixed(2)} of $${latest.budgetUsd.toFixed(2)} (equivalent API cost).`
        : 'Equivalent API cost budget reached.'
      const applied = commitRunningAttempt(this.ledger, loop.id, run.id, {
        status: 'interrupted',
        error: `Rate limited; retry skipped because the equivalent API cost budget was reached. ${error}`,
      }, () => {
        if (terminalLog) this.persistLog(loop.id, run.id, terminalLog.kind, terminalLog.text)
        this.persistLoopTerminal(loop.id, 'stopped', reason)
      })
      if (applied) {
        if (terminalLog) this.notifyPersistedLog(loop.id, run.id, terminalLog.kind, terminalLog.text)
        this.finishLoop(loop.id, 'stopped', reason)
      }
      return true
    }
    const retryAt = new Date(pause.retryAtMs).toISOString()
    let queuedId: string | null = null
    const applied = commitRunningAttempt(this.ledger, loop.id, run.id, {
      status: 'interrupted',
      error: `Rate limited; retry scheduled for ${retryAt}. ${error}`,
    }, () => {
      if (terminalLog) this.persistLog(loop.id, run.id, terminalLog.kind, terminalLog.text)
      const queued = this.ledger.createRun({
        loopId: loop.id,
        round: run.round,
        role: run.role,
        harness: harnessFor(run.role === 'critique' ? loop.models.criticModel : loop.models.orchestratorModel),
        prompt:
          run.role === 'implement' ? markResumePrompt(run.prompt) : run.prompt,
      })
      queuedId = queued.id
      if (run.revision) this.ledger.patchRun(queued.id, { revision: run.revision })
    })
    if (!applied) return true
    if (terminalLog) this.notifyPersistedLog(loop.id, run.id, terminalLog.kind, terminalLog.text)
    if (run.role === 'implement' && queuedId) this.copyCritiqueTreeBaseline(run.id, queuedId)
    this.log(loop.id, run.id, 'system', `Rate limit is a retryable pause — next ${run.role} attempt at ${retryAt} (backoff ${Math.ceil(pause.delayMs / 1_000)}s).`)
    this.broadcast(loop.id)
    this.scheduleRetry(loop.id, pause.retryAtMs)
    return true
  }

  /** One same-phase retry protocol for artifact phases; rate pauses do not consume attempts. */
  private async failOrRetryPhase(loop: LoopRecord, run: RunRecord, error: string, label: string, maxAttempts: number, prompt: string, terminalLog?: { kind: string; text: string }): Promise<void> {
    if (await this.retryRateLimit(loop, run, error, terminalLog)) return
    const attempts = this.ledger.failedRunCount(loop.id, run.role, run.round) + 1
    if (this.budgetReached(loop.id, this.ledger.getRun(run.id)?.costUsd ?? 0)) {
      const latest = this.ledger.getLoop(loop.id)
      const reason = latest?.budgetUsd
        ? `Budget ceiling hit: $${latest.totalCostUsd.toFixed(2)} of $${latest.budgetUsd.toFixed(2)} (equivalent API cost).`
        : 'Equivalent API cost budget reached.'
      const applied = commitRunningAttempt(this.ledger, loop.id, run.id, { status: 'failed', error }, () => {
        if (terminalLog) this.persistLog(loop.id, run.id, terminalLog.kind, terminalLog.text)
        this.persistLoopTerminal(loop.id, 'stopped', reason)
      })
      if (applied) {
        if (terminalLog) this.notifyPersistedLog(loop.id, run.id, terminalLog.kind, terminalLog.text)
        this.finishLoop(loop.id, 'stopped', reason)
      }
      return
    }
    if (attempts >= maxAttempts) {
      this.failAttemptAndLoop(loop, run, error, `${label} failed after ${maxAttempts} attempts: ${error}`, terminalLog)
      return
    }
    this.log(loop.id, run.id, 'system', `${label} failed (${error}) — retrying without discarding valid phase artifacts.`)
    let retryId: string | null = null
    const applied = commitRunningAttempt(this.ledger, loop.id, run.id, { status: 'failed', error }, () => {
      if (terminalLog) this.persistLog(loop.id, run.id, terminalLog.kind, terminalLog.text)
      const retry = this.ledger.createRun({
        loopId: loop.id,
        round: run.round,
        role: run.role,
        harness: harnessFor(run.role === 'critique' ? loop.models.criticModel : loop.models.orchestratorModel),
        prompt,
      })
      retryId = retry.id
      if (run.revision) this.ledger.patchRun(retry.id, { revision: run.revision })
    })
    if (!applied) return
    if (terminalLog) this.notifyPersistedLog(loop.id, run.id, terminalLog.kind, terminalLog.text)
    if (run.role === 'implement' && retryId) this.copyCritiqueTreeBaseline(run.id, retryId)
    this.broadcast(loop.id)
    void this.executeNext(loop.id)
  }

  /** Apply the identical user-stop/timeout terminal transition for every phase. */
  private finishCancelledAttempt(loop: LoopRecord, run: RunRecord, exit: ExitInfo, timeoutReason: string, terminalLog?: { kind: string; text: string }): boolean {
    const userStopped = this.stopRequested.has(loop.id)
    if (!userStopped && !exit.timedOut) return false
    const runError = userStopped ? 'Stopped by user.' : 'Timed out.'
    const reason = userStopped ? 'Stopped by user.' : timeoutReason
    const applied = commitRunningAttempt(this.ledger, loop.id, run.id, { status: 'cancelled', error: runError }, () => {
      if (terminalLog) this.persistLog(loop.id, run.id, terminalLog.kind, terminalLog.text)
      this.persistLoopTerminal(loop.id, 'stopped', reason)
    })
    if (applied) {
      if (terminalLog) this.notifyPersistedLog(loop.id, run.id, terminalLog.kind, terminalLog.text)
      this.finishLoop(loop.id, 'stopped', reason)
    }
    return true
  }

  /** Stop without retrying whenever the selected profile is not subscription-backed. */
  private stopForSubscription(loop: LoopRecord, run: RunRecord, harness: HarnessKind, readiness: SubscriptionReadiness): void {
    const reason = this.subscriptionBlockMessage(harness, readiness)
    let applied = false
    if (this.ledger.getRun(run.id)?.status === 'running') {
      applied = commitRunningAttempt(this.ledger, loop.id, run.id, {
        status: 'interrupted',
        error: reason,
        finishedAt: this.nowIso(),
      }, () => {
        this.persistLog(loop.id, run.id, 'error', reason)
        this.persistLoopTerminal(loop.id, 'stopped', reason)
      })
    } else {
      this.atomicLogs(() => {
        if (this.ledger.getRun(run.id)?.status !== 'queued') return
        this.ledger.patchRun(run.id, { status: 'interrupted', error: reason, finishedAt: this.nowIso() })
        this.persistLog(loop.id, run.id, 'error', reason)
        this.persistLoopTerminal(loop.id, 'stopped', reason)
        applied = true
      })
    }
    if (!applied) return
    if (this.ledger.getRun(run.id)?.status === 'interrupted') this.notifyPersistedLog(loop.id, run.id, 'error', reason)
    this.notifyPersistedLog(loop.id, null, 'done', this.terminalMessage('stopped', reason))
    this.broadcast(loop.id)
  }

  private quarantineRunningAttempt(loop: LoopRecord, run: RunRecord, reason: string): void {
    const applied = commitRunningAttempt(this.ledger, loop.id, run.id, {
      status: 'interrupted',
      error: reason,
      finishedAt: this.nowIso(),
    }, () => {
      this.persistLog(loop.id, run.id, 'error', reason)
      this.persistLoopTerminal(loop.id, 'stopped', reason)
    })
    if (!applied) return
    this.notifyPersistedLog(loop.id, run.id, 'error', reason)
    this.notifyPersistedLog(loop.id, null, 'done', this.terminalMessage('stopped', reason))
    this.broadcast(loop.id)
  }

  private requiredHarnesses(loop: LoopRecord, role: RunRole, primary: HarnessKind): HarnessKind[] {
    const workerModels = role === 'implement'
      ? [loop.models.subagentModel, loop.models.assetModel]
      : role === 'reference'
        ? [loop.models.researchModel]
        : []
    return [...new Set<HarnessKind>([
      primary,
      ...workerModels.filter((model): model is string => model != null).map(harnessFor),
    ])]
  }

  private subscriptionBlock(
    loop: LoopRecord,
    role: RunRole,
    primary: HarnessKind,
  ): { harness: HarnessKind; readiness: SubscriptionReadiness } | null {
    for (const harness of this.requiredHarnesses(loop, role, primary)) {
      const readiness = this.deps.subscriptionReady(harness, loop.workspaceDir, this.deps.harnessHome(harness))
      if (!readiness.ok) return { harness, readiness }
    }
    return null
  }

  private subscriptionBlockForRun(loop: LoopRecord, run: RunRecord): { harness: HarnessKind; readiness: SubscriptionReadiness } | null {
    return this.subscriptionBlock(loop, run.role, run.harness)
  }

  private executableRoots(loop: LoopRecord): string[] {
    return [loop.workspaceDir, ...this.deps.protectedRoots()]
  }

  /** Resolve and pin every CLI this phase may execute, including workers. */
  private executableEnvironment(loop: LoopRecord, run: RunRecord, planEnv: Record<string, string>): { command: string; env: Record<string, string> } {
    const roots = this.executableRoots(loop)
    const executables = new Map(
      this.requiredHarnesses(loop, run.role, run.harness).map((harness) => [harness, this.deps.cliExecutable(harness, roots)]),
    )
    const env = {
      ...subscriptionEnv(planEnv, process.env, run.harness, roots),
      ...this.deps.validatedExecutableEnv(executables, roots),
    }
    return {
      command: executables.get(run.harness)!,
      env,
    }
  }

  private processMetaFromOwnership(loop: LoopRecord, run: RunRecord, ownership: RunProcessOwnership): RunProcessMeta {
    const projection = run.metrics?.projection
    return {
      version: 1,
      pid: ownership.pid,
      processIdentity: ownership.processIdentity,
      groupIdentities: [...ownership.groupIdentities],
      startedAtMs: ownership.startedAtMs,
      outDev: ownership.outDev,
      outIno: ownership.outIno,
      errDev: ownership.errDev,
      errIno: ownership.errIno,
      ...processStreamPaths(loop.workspaceDir, run.id),
      loggedOutLines: projection?.loggedOutLines ?? 0,
      loggedErrLines: projection?.loggedErrLines ?? 0,
      childOffsets: projection?.childOffsets ?? {},
      childIdentities: projection?.childIdentities ?? {},
      workflowOffsets: projection?.workflowOffsets ?? {},
      workflowIdentities: projection?.workflowIdentities ?? {},
    }
  }

  /** A canonical owner blocks all new launches until its whole group is gone. */
  private retainedProcessOwnership(): { loop: LoopRecord; run: RunRecord; meta: RunProcessMeta } | null {
    const retained = this.ledger.runsWithProcessOwnership()[0]
    if (!retained) return null
    const loop = this.ledger.getLoop(retained.run.loopId)
    if (!loop) throw new Error('Retained process ownership references a missing loop.')
    // This is a control-only view: path derivation is side-effect free, so a
    // removed/replaced workspace can still be quarantined and its canonical
    // process group interrupted without touching that filesystem surface.
    const meta = this.processMetaFromOwnership(loop, retained.run, retained.ownership)
    let groupPresent = processMatches(meta)
    try {
      groupPresent ||= this.deps.processGroupStillOwned(meta.pid, retained.ownership.groupIdentities)
    } catch {
      groupPresent = true
    }
    // A running attempt still needs its canonical ownership row to drain and
    // finalize streams after a leader exited while the app was down. Recovery,
    // not this launch guard, decides that transition.
    if (groupPresent || retained.run.status === 'running') return { loop, run: retained.run, meta }
    this.ledger.clearRunProcessOwnership(retained.run.id)
    return null
  }

  private retainedOwnershipMessage(owner: { loop: LoopRecord; run: RunRecord; meta: RunProcessMeta }): string {
    return `A previously launched ${owner.run.role} process group (${owner.meta.pid}) is still owned for workspace ${owner.loop.workspaceDir}; wait for it to exit before starting or resuming work.`
  }

  private quarantinedUnknownLaunch(workspaceDir: string): boolean {
    return this.ledger.hasRunErrorPrefixForWorkspace(workspaceDir, UNKNOWN_LAUNCH_OWNERSHIP)
  }

  private subscriptionBlockMessage(harness: HarnessKind, readiness: SubscriptionReadiness): string {
    return `Subscription readiness blocked ${harness}: ${redactedErrorMessage(readiness.error, 'The selected CLI profile is not ready for subscription execution.')}`
  }

  /** Revalidate the canonical project root at every privileged phase seam. */
  private verifyWorkspaceBoundary(loop: LoopRecord): boolean {
    try {
      this.ledger.assertLoopWorkspaceIdentity(loop.id)
      return true
    } catch {
      // This Ledger operation updates canonical state atomically and
      // intentionally does not mirror into the now-untrusted workspace.
      if (this.ledger.quarantineUnsafeWorkspace(loop.id, UNSAFE_WORKSPACE_MESSAGE)) {
        this.notifyWorkspaceQuarantine(loop.id)
      }
      return false
    }
  }

  /** Project the canonical quarantine without regenerating a workspace report. */
  private notifyWorkspaceQuarantine(loopId: string): void {
    const event = [...this.ledger.eventsForLoop(loopId, 20)].reverse().find((line) => line.kind === 'workspace-boundary')
    if (event) this.notifyLog(event)
    const loop = this.ledger.getLoop(loopId)
    if (!loop) return
    const projection = this.ledger.recentRunProjectionForLoop(loopId, 200)
    try {
      this.send(IPC.loop.update, boundedLoopSnapshot({
        loop,
        runs: projection.runs,
        totalRuns: this.ledger.runCount(loopId),
        detailTruncated: projection.truncatedFields,
        aggregate: this.ledger.runAggregate(loopId),
      }))
    } catch {
      /* canonical quarantine remains visible after renderer reconnect */
    }
  }

  start(input: StartLoopInput): StartLoopResult {
    if (this.current) return { ok: false, error: 'A loop is already running. Stop it first.' }
    try {
      const owner = this.retainedProcessOwnership()
      if (owner) return { ok: false, error: this.retainedOwnershipMessage(owner) }
    } catch (error) {
      return { ok: false, error: redactedErrorMessage(error, 'Retained process ownership could not be verified.') }
    }
    if (this.terminatingLoops.size > 0 || this.ledger.runningLoop()) return { ok: false, error: 'A loop is already running. Stop it first.' }
    const prompt = input.prompt
    if (!prompt.trim()) return { ok: false, error: 'Prompt is empty.' }
    if (prompt.length > 100_000) return { ok: false, error: 'Prompt must be at most 100000 characters.' }
    if (redactLogText(prompt) !== prompt) {
      return { ok: false, error: 'Prompt contains credential-shaped material. Remove credentials or secrets before starting the loop.' }
    }
    const requestedWorkspace = input.workspaceDir.trim()
    if (!requestedWorkspace || !path.isAbsolute(requestedWorkspace)) return { ok: false, error: 'Workspace must be an absolute path.' }
    const maxRounds = Math.max(1, Math.min(100, Math.floor(input.maxRounds) || 10))
    const budgetUsd = input.budgetUsd && input.budgetUsd > 0 ? input.budgetUsd : null
    let workspaceDir: string
    let scaffold: ReturnType<typeof scaffoldEngine>
    try {
      workspaceDir = assertWorkspaceBoundary(requestedWorkspace, this.deps.protectedRoots())
      fs.mkdirSync(workspaceDir, { recursive: true })
      const captured = captureWorkspaceIdentity(workspaceDir, this.deps.protectedRoots())
      workspaceDir = captured.workspaceDir
      scaffold = scaffoldEngine(workspaceDir, captured.workspaceIdentity)
    } catch (error) {
      return { ok: false, error: `Cannot use workspace: ${redactedErrorMessage(error, 'The selected path is unsafe.')}` }
    }
    if (this.quarantinedUnknownLaunch(workspaceDir)) {
      return { ok: false, error: `${UNKNOWN_LAUNCH_OWNERSHIP} This workspace is quarantined against another editor launch because process exit was never observed.` }
    }

    const models = resolveModels(input, input, input, input)
    let loop: LoopRecord
    try {
      loop = this.atomicLogs(() => {
        const created = this.ledger.createLoop({ prompt, workspaceDir, maxRounds, budgetUsd, models })
        this.log(created.id, null, 'system', `Loop started — workspace ${workspaceDir}, max ${maxRounds} rounds${budgetUsd ? `, budget $${budgetUsd}` : ''}.`)
        this.log(created.id, null, 'system', scaffold.created.length
          ? `Engine scaffolded — ${scaffold.created.join(', ')}.`
          : 'Engine contract refreshed; workspace already scaffolded.')
        this.log(created.id, null, 'system', describeModels(models))
        const referenceDir = referencePackDir(created.id)
        this.ledger.createRun({
          loopId: created.id,
          round: 0,
          role: 'reference',
          harness: harnessFor(models.orchestratorModel),
          prompt: buildReferencePrompt(prompt, referenceDir, researchRules(models, referenceDir)),
        })
        return created
      })
    } catch (error) {
      return { ok: false, error: `Could not start loop: ${redactedErrorMessage(error, 'History could not be created.')}` }
    }
    this.broadcast(loop.id)
    void this.executeNext(loop.id)
    return { ok: true, loopId: loop.id }
  }

  /**
   * Boot-time recovery. Detached agents survive app restarts: if the run's
   * process is still alive we re-attach to its output file (no interruption);
   * if it finished while the app was down we drain and finalize it; only when
   * no process metadata exists do we requeue a fresh attempt.
   */
  recoverAll(): void {
    try {
      const owner = this.retainedProcessOwnership()
      if (owner && owner.run.status !== 'running') {
        const workspaceSafe = this.verifyWorkspaceBoundary(owner.loop)
        // Quit may have ended the direct leader while a captured descendant
        // remained. Resume the identity-bound SIGINT→SIGKILL supervision on
        // boot; never leave a billed stopped owner with no settlement path.
        this.interrupt(owner.meta, owner.loop.id, owner.run.id)
        if (workspaceSafe) {
          this.log(owner.loop.id, owner.run.id, 'error', this.retainedOwnershipMessage(owner))
          this.broadcast(owner.loop.id)
        }
        if (this.ledger.runProcessOwnership(owner.run.id)) return
      }
    } catch (error) {
      // A corrupt or ambiguous canonical owner must fail closed before any
      // queued recovery can create a second detached editor.
      console.error('Cannot audit retained process ownership:', error)
      return
    }
    for (const loop of this.ledger.runningLoops()) {
      try {
      try {
        this.ledger.assertLoopWorkspaceIdentity(loop.id)
      } catch {
        const active = this.ledger.activeRunForLoop(loop.id)
        const ownership = active ? this.ledger.runProcessOwnership(active.id) : null
        if (active && ownership) {
          const meta = this.processMetaFromOwnership(loop, active, ownership)
          this.interrupt(meta, loop.id, active.id)
        }
        if (this.ledger.quarantineUnsafeWorkspace(loop.id, UNSAFE_WORKSPACE_MESSAGE)) this.notifyWorkspaceQuarantine(loop.id)
        continue
      }
      if (!loop.playTrusted) {
        this.finishLoop(loop.id, 'stopped', UNTRUSTED_HISTORY_MESSAGE)
        continue
      }
        const active = this.ledger.activeRunForLoop(loop.id)
      if (active) {
        const ownership = this.ledger.runProcessOwnership(active.id)
        if (!ownership) {
          const reason = `${UNKNOWN_LAUNCH_OWNERSHIP} Canonical process ownership is missing, so recovery will not trust portable workspace metadata or launch a duplicate editor. Confirm any CLI process is stopped, then start a new trusted run.`
          this.quarantineRunningAttempt(loop, active, reason)
          continue
        }
        if (active.role === 'assets') {
          const meta = this.processMetaFromOwnership(loop, active, ownership)
          this.interrupt(meta, loop.id, active.id)
          this.quarantineRunningAttempt(
            loop,
            active,
            'Legacy standalone Asset Build was stopped during recovery; Resume hands its remaining cast to the implement phase.',
          )
          continue
        }
        const subscriptionBlock = this.subscriptionBlockForRun(loop, active)
        if (subscriptionBlock) {
          if (!this.verifyWorkspaceBoundary(loop)) continue
          const meta = this.processMetaFromOwnership(loop, active, ownership)
          this.interrupt(meta, loop.id, active.id)
          this.stopForSubscription(loop, active, subscriptionBlock.harness, subscriptionBlock.readiness)
          continue
        }
        // Subscription probes execute external binaries and may take seconds.
        // Rebind the exact registered root before reading any recovery surface.
        if (!this.verifyWorkspaceBoundary(loop)) continue
        const meta = this.processMetaFromOwnership(loop, active, ownership)
        {
          const canonicalProjection = active.metrics?.projection
          if (canonicalProjection) {
            meta.loggedOutLines = canonicalProjection.loggedOutLines
            meta.loggedErrLines = canonicalProjection.loggedErrLines
            meta.childOffsets = canonicalProjection.childOffsets
            meta.childIdentities = canonicalProjection.childIdentities ?? {}
            meta.workflowOffsets = canonicalProjection.workflowOffsets
            meta.workflowIdentities = canonicalProjection.workflowIdentities ?? {}
          }
          const expectedStart = Date.parse(active.startedAt ?? '')
          const startMatches = Number.isFinite(expectedStart) && Math.abs(expectedStart - meta.startedAtMs) <= 5_000
          const pidExists = this.pidExists(meta.pid)
          const alive = startMatches && processMatches(meta)
          if (!startMatches || (pidExists && !alive)) {
            const reason = `App restart rejected unsafe ${active.role} canonical ownership — ${!startMatches ? 'recorded start does not match this attempt' : 'PID identity no longer belongs to this run'}. The retained owner must be verified absent before new work can start.`
            this.interruptCaptured(meta, ownership.groupIdentities, loop.id, active.id)
            this.quarantineRunningAttempt(loop, active, reason)
            continue
          }
          this.log(
            loop.id,
            active.id,
            'system',
            alive
              ? `App restarted — re-attached to live ${active.role} (pid ${meta.pid}); agents were never interrupted.`
              : `App restarted — ${active.role} ended while the app was down; draining its output.`,
          )
          this.broadcast(loop.id)
          const gate: LogGate = { suppress: false }
          const childBoundary = recoverChildStreams(loop.workspaceDir, loop)
          const parser =
            active.role === 'reference'
              ? this.makeReferenceParser(loop, active, gate, childBoundary)
              : active.role === 'implement'
                ? this.makeImplementParser(loop, active, gate, childBoundary, meta.workflowOffsets, meta.workflowIdentities)
                : this.makeCritiqueParser(loop, active, gate)
          const idle = active.role === 'implement' ? IMPLEMENT_IDLE_MS : active.role === 'reference' ? REFERENCE_TIMEOUT_MS : CRITIQUE_TIMEOUT_MS
          const cap = active.role === 'implement' ? IMPLEMENT_HARD_CAP_MS : active.role === 'reference' ? REFERENCE_TIMEOUT_MS : CRITIQUE_TIMEOUT_MS
          const recoveredGroup = ownership.groupIdentities
          void this.driveRun(loop, active, meta, idle, cap, parser, gate, null, recoveredGroup, childBoundary)
          continue
        }
      } else {
        const queued = this.ledger.oldestQueuedRunForLoop(loop.id)
        if (!queued) {
          this.finishLoop(loop.id, 'stopped', 'No pending work found after app restart.')
          continue
        }
        const subscriptionBlock = this.subscriptionBlockForRun(loop, queued)
        if (subscriptionBlock) {
          this.stopForSubscription(loop, queued, subscriptionBlock.harness, subscriptionBlock.readiness)
          continue
        }
      }
      this.broadcast(loop.id)
      void this.executeNext(loop.id)
      } catch (error) {
        try {
          this.quarantineRecoveryFailure(loop, error)
        } catch (quarantineError) {
          // Preserve iteration: a canonical ownership row still blocks any
          // replacement launch even if its visibility transition also fails.
          console.error('Could not quarantine failed loop recovery:', quarantineError)
        }
      }
    }
  }

  /** Isolate one broken recovery surface without abandoning later loops. */
  private quarantineRecoveryFailure(loop: LoopRecord, error: unknown): void {
    const reason = `Recovery setup failed safely: ${redactedErrorMessage(error, 'Recovery state could not be validated.')}`
    const run = this.ledger.latestRunForLoop(loop.id)
    if (run?.status === 'running') {
      const ownership = this.ledger.runProcessOwnership(run.id)
      if (ownership) {
        const meta = this.processMetaFromOwnership(loop, run, ownership)
        this.interruptCaptured(meta, ownership.groupIdentities, loop.id, run.id)
      }
      this.quarantineRunningAttempt(loop, run, reason)
      return
    }
    if (run?.status === 'queued') {
      this.atomicLogs(() => {
        this.ledger.patchRun(run.id, { status: 'interrupted', error: reason, finishedAt: this.nowIso() })
        this.persistLog(loop.id, run.id, 'error', reason)
        this.persistLoopTerminal(loop.id, 'stopped', reason)
      })
      this.notifyPersistedLog(loop.id, run.id, 'error', reason)
      this.notifyPersistedLog(loop.id, null, 'done', this.terminalMessage('stopped', reason))
      this.broadcast(loop.id)
      return
    }
    this.finishLoop(loop.id, 'stopped', reason)
  }

  /** The run currently being supervised, if any. */
  activeRun(): { loopId: string; runId: string; pid: number; role: string } | null {
    if (this.current) {
      const run = this.ledger.getRun(this.current.runId)
      return { loopId: this.current.loopId, runId: this.current.runId, pid: this.current.meta.pid, role: run?.role ?? 'run' }
    }
    const retained = this.retainedProcessOwnership()
    return retained
      ? { loopId: retained.loop.id, runId: retained.run.id, pid: retained.meta.pid, role: retained.run.role }
      : null
  }

  /** True while quitting would discard ownership-settlement supervision. */
  hasUnsettledOwnership(): boolean {
    return this.terminatingLoops.size > 0 || this.ledger.runsWithProcessOwnership().length > 0
  }

  /**
   * Whether quit must wait regardless of the dialog's Keep-agents choice.
   * A normal current run may intentionally survive quit; a group already in
   * stop/recovery escalation may not lose its only settlement timers.
   */
  quitSettlementPending(): boolean {
    return this.terminatingLoops.size > 0 || (!this.current && this.ledger.runsWithProcessOwnership().length > 0)
  }

  /**
   * Begin graceful shutdown: SIGINT the agent and mark the loop stopped.
   * Callers that intend to exit the app must use stopForQuitAndWait below so
   * bounded escalation and verified group-absence checks remain alive.
   */
  stopForQuit(): void {
    if (!this.current) {
      const owner = this.retainedProcessOwnership()
      if (owner) {
        this.stopRequested.add(owner.loop.id)
        const workspaceSafe = this.verifyWorkspaceBoundary(owner.loop)
        this.interrupt(owner.meta, owner.loop.id, owner.run.id)
        if (workspaceSafe && owner.run.status === 'running') {
          const reason = 'Stopped by user at quit.'
          try {
            const finishedAt = this.nowIso()
            this.ledger.cancelRunAndStopLoopCanonical(
              owner.loop.id,
              owner.run.id,
              reason,
              finishedAt,
              Math.max(0, Math.floor(this.deps.now() - owner.meta.startedAtMs)),
            )
            this.notifyPersistedLog(owner.loop.id, owner.run.id, 'process-control', reason)
          } catch (error) {
            if (this.ledger.quarantineUnsafeWorkspace(owner.loop.id, UNSAFE_WORKSPACE_MESSAGE)) this.notifyWorkspaceQuarantine(owner.loop.id)
            this.controlLog(owner.loop.id, owner.run.id, 'error', `Quit state could not be committed after process interruption began: ${redactedErrorMessage(error, 'canonical process ownership remains active.')}`)
          }
        }
        return
      }
      const paused = this.ledger.runningLoop()
      if (paused) this.finishLoop(paused.id, 'stopped', 'Stopped by user at quit.')
      return
    }
    const { loopId, runId, meta } = this.current
    this.stopRequested.add(loopId)
    const loop = this.ledger.getLoop(loopId)
    const workspaceSafe = loop ? this.verifyWorkspaceBoundary(loop) : false
    this.interrupt(meta, loopId, runId)
    if (!workspaceSafe) return
    const run = this.ledger.getRun(runId)
    const reason = 'Stopped by user at quit.'
    try {
      const finishedAt = this.nowIso()
      this.ledger.cancelRunAndStopLoopCanonical(
        loopId,
        runId,
        reason,
        finishedAt,
        Math.max(0, Math.floor(this.deps.now() - Date.parse(run?.startedAt ?? run?.createdAt ?? finishedAt))),
      )
      this.notifyPersistedLog(loopId, runId, 'process-control', reason)
    } catch (error) {
      if (this.ledger.quarantineUnsafeWorkspace(loopId, UNSAFE_WORKSPACE_MESSAGE)) this.notifyWorkspaceQuarantine(loopId)
      this.controlLog(loopId, runId, 'error', `Quit state could not be committed after process interruption began: ${redactedErrorMessage(error, 'canonical process ownership remains active.')}`)
    }
  }

  /**
   * Stop a loop and keep the caller alive through bounded group settlement.
   * Electron's before-quit handler must await this result: `false` means the
   * identity-bound group is still present or could not be proven absent, so
   * quitting would discard the escalation timers and must be cancelled.
   */
  async stopForQuitAndWait(maxWaitMs = 20_000): Promise<boolean> {
    this.stopForQuit()
    const attempts = Math.max(1, Math.ceil(Math.min(Math.max(maxWaitMs, 0), 60_000) / 100))
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (this.ledger.runsWithProcessOwnership().length === 0) return true
      await this.deps.wait(100)
    }
    return this.ledger.runsWithProcessOwnership().length === 0
  }

  /** Earliest unfinished phase in one historical round (legacy Asset Build included). */
  private resumeTarget(loopId: string, round: number): RunRecord | null {
    if (round < 1) return null
    const runs = this.ledger.runsForLoop(loopId).filter((run) => run.round === round)
    for (const role of ['assets', 'implement', 'critique'] as const) {
      const attempts = runs.filter((run) => run.role === role)
      if (attempts.length === 0) continue
      if (!attempts.some((run) => run.status === 'succeeded')) return attempts.at(-1) ?? null
    }
    return null
  }

  /** Revive a stopped loop: requeue where it left off and keep going. */
  resumeLoop(loopId: string): StartLoopResult {
    const loop = this.ledger.getLoop(loopId)
    if (!loop) return { ok: false, error: 'Loop not found.' }
    try {
      this.ledger.assertLoopWorkspaceIdentity(loop.id)
    } catch {
      if (this.ledger.quarantineUnsafeWorkspace(loop.id, UNSAFE_WORKSPACE_MESSAGE)) this.notifyWorkspaceQuarantine(loop.id)
      return { ok: false, error: UNSAFE_WORKSPACE_MESSAGE }
    }
    if (this.ledger.hasRunErrorPrefixForWorkspace(loop.workspaceDir, UNKNOWN_LAUNCH_OWNERSHIP)) {
      return { ok: false, error: `${UNKNOWN_LAUNCH_OWNERSHIP} Resume is disabled to avoid duplicating an untracked editor; start a new trusted run after confirming the old CLI is stopped.` }
    }
    if (!loop.playTrusted) return { ok: false, error: UNTRUSTED_HISTORY_MESSAGE }
    if (loop.status === 'running') return { ok: false, error: 'Loop is already running.' }
    if (loop.status === 'passed') return { ok: false, error: 'Loop already passed — start a new run to keep improving.' }
    if (this.current || this.terminatingLoops.size > 0 || this.ledger.runningLoop()) return { ok: false, error: 'Another loop is running. Stop it first.' }
    try {
      const owner = this.retainedProcessOwnership()
      if (owner) return { ok: false, error: this.retainedOwnershipMessage(owner) }
    } catch (error) {
      return { ok: false, error: redactedErrorMessage(error, 'Retained process ownership could not be verified.') }
    }
    const last = this.ledger.latestRunForLoop(loopId)
    const resume = planResume(last, loop.maxRounds)
    const resumeTarget: { role: RunRole; harness: HarnessKind } | null =
      resume.kind === 'continue-queued' || resume.kind === 'retry'
        ? { role: resume.run.role, harness: resume.run.harness }
        : resume.kind === 'queue-critique'
          ? { role: 'critique', harness: harnessFor(loop.models.criticModel) }
          : resume.kind === 'finish-exhausted'
            ? null
            : { role: resume.kind === 'queue-reference' ? 'reference' : 'implement', harness: harnessFor(loop.models.orchestratorModel) }
    if (resumeTarget) {
      const subscriptionBlock = this.subscriptionBlock(loop, resumeTarget.role, resumeTarget.harness)
      if (subscriptionBlock) return { ok: false, error: this.subscriptionBlockMessage(subscriptionBlock.harness, subscriptionBlock.readiness) }
    }
    this.stopRequested.delete(loopId)
    let earlyResult: StartLoopResult | null = null
    this.atomicLogs(() => {
      this.ledger.patchLoop(loopId, { status: 'running', stopReason: null })
      if (resume.kind === 'continue-queued') {
        this.log(loopId, null, 'system', `Loop resumed by user — continuing the already queued round ${resume.run.round} ${resume.run.role}.`)
      } else if (resume.kind === 'retry') {
        const prior = resume.run
        const retry = this.ledger.createRun({
          loopId,
          round: prior.round,
          role: prior.role,
          harness: harnessFor(prior.role === 'critique' ? loop.models.criticModel : loop.models.orchestratorModel),
          prompt: prior.role === 'implement' ? markResumePrompt(prior.prompt) : prior.prompt,
        })
        if (prior.revision) this.ledger.patchRun(retry.id, { revision: prior.revision })
        if (prior.role === 'implement') this.copyCritiqueTreeBaseline(prior.id, retry.id)
        this.log(loopId, null, 'system', `Loop resumed by user — retrying round ${prior.round} ${prior.role}.`)
      } else if (resume.kind === 'queue-implement') {
        this.ledger.patchLoop(loopId, { round: resume.round })
        this.ledger.createRun({
          loopId,
          round: resume.round,
          role: 'implement',
          harness: harnessFor(loop.models.orchestratorModel),
          prompt: this.nextImplementPrompt(loop, resume.round, resume.prior?.verdict ?? null),
        })
        this.log(loopId, null, 'system', resume.prior?.role === 'critique' ? `Loop resumed by user — starting round ${resume.round}.` : 'Loop resumed by user — Reference Pack ready; starting round 1.')
      } else if (resume.kind === 'queue-critique') {
        const prior = resume.prior
        const critique = this.ledger.createRun({
          loopId,
          round: resume.round,
          role: 'critique',
          harness: harnessFor(loop.models.criticModel),
          prompt: buildCriticPrompt(loop.prompt, resume.round, this.referenceDir(loopId), prior.revision ?? '<missing-revision>'),
        })
        this.ledger.patchRun(critique.id, { revision: prior.revision })
        this.log(loopId, null, 'system', `Loop resumed by user — judging round ${resume.round}.`)
      } else if (resume.kind === 'finish-exhausted') {
        const afterImplement = resume.prior.role === 'implement'
        const reason = afterImplement
          ? `Max rounds (${loop.maxRounds}) reached after round ${resume.prior.round} — no critique, since no round is left for it to gate.`
          : `Max rounds (${loop.maxRounds}) reached.`
        this.persistLoopTerminal(loopId, 'exhausted', reason)
        earlyResult = afterImplement ? { ok: true } : { ok: false, error: 'Max rounds already reached.' }
      } else {
        const referenceDir = referencePackDir(loopId)
        this.ledger.createRun({
          loopId,
          round: 0,
          role: 'reference',
          harness: harnessFor(loop.models.orchestratorModel),
          prompt: buildReferencePrompt(loop.prompt, referenceDir, researchRules(loop.models, referenceDir)),
        })
        this.log(loopId, null, 'system', 'Loop resumed by user — starting Reference Study.')
      }
    })
    if (earlyResult) {
      if (resume.kind === 'finish-exhausted') {
        const reason = resume.prior.role === 'implement'
          ? `Max rounds (${loop.maxRounds}) reached after round ${resume.prior.round} — no critique, since no round is left for it to gate.`
          : `Max rounds (${loop.maxRounds}) reached.`
        this.notifyPersistedLog(loopId, null, 'done', this.terminalMessage('exhausted', reason))
      }
      this.broadcast(loopId)
      return earlyResult
    }
    this.broadcast(loopId)
    void this.executeNext(loopId)
    return { ok: true, loopId }
  }

  stop(loopId: string): void {
    const loop = this.ledger.getLoop(loopId)
    if (!loop) return
    this.stopRequested.add(loopId)
    if (this.current?.loopId === loopId) {
      const workspaceSafe = this.verifyWorkspaceBoundary(loop)
      this.interrupt(this.current.meta, loopId, this.current.runId)
      this.controlLog(
        loopId,
        this.current.runId,
        'system',
        workspaceSafe
          ? 'Stop requested — interrupting current run (SIGINT).'
          : 'Stop requested after the workspace root changed — interrupting the canonical process group (SIGINT).',
      )
      return
    }
    const retained = this.retainedProcessOwnership()
    if (retained?.loop.id === loopId) {
      const workspaceSafe = this.verifyWorkspaceBoundary(loop)
      this.interrupt(retained.meta, loopId, retained.run.id)
      this.controlLog(
        loopId,
        retained.run.id,
        'system',
        workspaceSafe
          ? 'Stop requested — resuming interruption of the retained process group (SIGINT).'
          : 'Stop requested after the workspace root changed — resuming canonical process-group interruption (SIGINT).',
      )
      return
    }
    this.finishLoop(loopId, 'stopped', 'Stopped by user.')
  }

  private pidExists(pid: number): boolean {
    if (!safePid(pid)) return false
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }

  /** Persist every currently verified member before a stop can outlive us. */
  private refreshCanonicalGroup(meta: RunProcessMeta, loopId: string, runId: string): void {
    const ownership = this.ledger.runProcessOwnership(runId)
    if (!ownership || !processMatches(meta)) return
    const fresh = this.deps.processGroupIdentity(meta.pid)
    if (!fresh.includes(`${meta.pid}:${meta.processIdentity}`)) return
    const union = [...new Set([...ownership.groupIdentities, ...fresh])]
    if (union.length === ownership.groupIdentities.length) return
    this.ledger.updateRunProcessGroupIdentities(runId, union)
    meta.groupIdentities = union
    if (!this.ledger.getLoop(loopId)) throw new Error('Cannot advance process-group ownership for a missing loop.')
  }

  private interrupt(meta: RunProcessMeta, loopId: string, runId: string): void {
    if (this.interruptingRuns.has(runId)) return
    if (!processMatches(meta)) {
      const captured = this.ledger.runProcessOwnership(runId)?.groupIdentities ?? meta.groupIdentities
      this.interruptCaptured(meta, captured, loopId, runId)
      return
    }
    const report = (message: string): void => {
      try {
        this.controlLog(loopId, runId, message.includes('could not') || message.includes('skipped') ? 'error' : 'system', message)
      } catch (error) {
        console.error('Could not persist process-control event:', error)
      }
    }
    try {
      this.refreshCanonicalGroup(meta, loopId, runId)
    } catch (error) {
      report(`Could not advance canonical process-group ownership before interruption: ${error instanceof Error ? error.message : String(error)}`)
    }
    this.interruptingRuns.add(runId)
    this.terminatingLoops.add(loopId)
    interruptProcessGroup(
      meta,
      report,
      {
        identityMatches: processMatches,
        kill: this.deps.signalProcess,
        defer: this.deps.defer,
        groupIdentity: this.deps.processGroupIdentity,
        groupStillOwned: this.deps.processGroupStillOwned,
      },
      (outcome) => {
        this.interruptingRuns.delete(runId)
        this.terminatingLoops.delete(loopId)
        if (outcome === 'gone') {
          if (this.ledger.runProcessOwnership(runId)) this.ledger.clearRunProcessOwnership(runId)
          if (this.ledger.getLoop(loopId)?.status === 'running') void this.executeNext(loopId)
        } else {
          report('Process-group ownership could not be proven settled; the canonical ownership claim remains and new work is blocked pending manual intervention.')
        }
      },
    )
  }

  private interruptCaptured(
    meta: RunProcessMeta,
    groupIdentity: readonly string[],
    loopId: string,
    runId: string,
  ): void {
    if (this.interruptingRuns.has(runId)) return
    const report = (message: string): void => {
      try {
        this.controlLog(loopId, runId, message.includes('could not') || message.includes('skipped') ? 'error' : 'system', message)
      } catch (error) {
        console.error('Could not persist process-control event:', error)
      }
    }
    this.interruptingRuns.add(runId)
    this.terminatingLoops.add(loopId)
    interruptCapturedProcessGroup(
      meta.pid,
      groupIdentity,
      report,
      (outcome) => {
        this.interruptingRuns.delete(runId)
        this.terminatingLoops.delete(loopId)
        if (outcome === 'gone') {
          if (this.ledger.runProcessOwnership(runId)) this.ledger.clearRunProcessOwnership(runId)
          if (this.ledger.getLoop(loopId)?.status === 'running') void this.executeNext(loopId)
        } else {
          report('Process-group ownership could not be proven settled; the canonical ownership claim remains and new work is blocked pending manual intervention.')
        }
      },
      {
        kill: this.deps.signalProcess,
        defer: this.deps.defer,
        groupIdentity: this.deps.processGroupIdentity,
        groupStillOwned: this.deps.processGroupStillOwned,
      },
    )
  }

  /** Persist one event without crossing the IPC boundary (safe inside a DB transaction). */
  private persistLog(loopId: string, runId: string | null, kind: string, text: string, agentId?: string): LoopLogLine {
    const line: LoopLogLine = { loopId, runId, ts: this.nowIso(), kind, channel: channelForKind(kind), text: redactLogText(text.slice(0, 4000)) }
    if (agentId) line.agentId = redactLogText(agentId).slice(0, 256)
    if (runId) {
      const run = this.ledger.getRun(runId)
      if (run) {
        line.round = run.round
        line.role = run.role
      }
    }
    this.ledger.appendEvent(line)
    return line
  }

  /** Process control must remain durable even when the workspace mirror is unsafe. */
  private controlLog(loopId: string, runId: string, kind: string, text: string): void {
    try {
      const run = this.ledger.getRun(runId)
      const line: LoopLogLine = {
        loopId,
        runId,
        ts: this.nowIso(),
        kind,
        channel: channelForKind(kind),
        text: redactLogText(text.slice(0, 4000)),
        ...(run ? { round: run.round, role: run.role } : {}),
      }
      this.ledger.appendCanonicalEvent(line)
      this.notifyLog(line)
    } catch (error) {
      console.error('Could not persist canonical process-control event:', error)
    }
  }

  private notifyLog(line: LoopLogLine): void {
    try {
      this.send(IPC.loop.log, line)
    } catch {
      /* durable log delivery survives a transient renderer boundary failure */
    }
  }

  private log(loopId: string, runId: string | null, kind: string, text: string, agentId?: string): void {
    const line = this.persistLog(loopId, runId, kind, text, agentId)
    if (this.logNotificationBuffer) this.logNotificationBuffer.push(line)
    else this.notifyLog(line)
  }

  /** Commit projected events/state before exposing any of those events over IPC. */
  private atomicLogs<T>(work: () => T): T {
    if (this.logNotificationBuffer) return this.ledger.transaction(work)
    const notifications: LoopLogLine[] = []
    const broadcasts = new Set<string>()
    this.logNotificationBuffer = notifications
    this.broadcastBuffer = broadcasts
    try {
      const result = this.ledger.transaction(work)
      this.logNotificationBuffer = null
      this.broadcastBuffer = null
      for (const line of notifications) this.notifyLog(line)
      for (const loopId of broadcasts) this.broadcast(loopId)
      return result
    } catch (error) {
      this.logNotificationBuffer = null
      this.broadcastBuffer = null
      throw error
    }
  }

  private notifyPersistedLog(loopId: string, runId: string | null, kind: string, text: string): void {
    const safeText = redactLogText(text.slice(0, 4000))
    const events = runId ? this.ledger.eventsForRun(runId, kind, 100) : this.ledger.eventsForLoop(loopId, 100)
    const line = [...events].reverse().find((event) => event.kind === kind && event.text === safeText)
    if (line) this.notifyLog(line)
  }

  /** Surface every delegated child's stream in the run log, attributed to its slug. */
  private pumpChildStreams(): number {
    if (!this.childTail) return 0
    const { loopId, runId, boundary, tailer } = this.childTail
    assertChildStreamBoundary(boundary)
    const events = tailer.poll()
    for (const event of events) this.log(loopId, runId, event.kind, event.text, event.agentId)
    return events.length
  }

  /** Preserve a complete execution prompt in the event log without hitting the per-line cap. */
  private logPrompt(loopId: string, runId: string, label: string, prompt: string): void {
    const chunkSize = 3_600
    // Redact before slicing so a credential-shaped value cannot straddle two
    // separately sanitized log records.
    const safePrompt = redactLogText(prompt)
    const chunks = Array.from({ length: Math.ceil(safePrompt.length / chunkSize) }, (_, index) => safePrompt.slice(index * chunkSize, (index + 1) * chunkSize))
    for (const [index, chunk] of chunks.entries()) {
      const suffix = chunks.length > 1 ? ` (${index + 1}/${chunks.length})` : ''
      this.log(loopId, runId, 'prompt', `${label}${suffix}:\n${chunk}`)
    }
  }

  private broadcast(loopId: string): void {
    if (this.broadcastBuffer) {
      this.broadcastBuffer.add(loopId)
      return
    }
    const loop = this.ledger.getLoop(loopId)
    if (!loop) return
    const totalRuns = this.ledger.runCount(loopId)
    const projection = this.ledger.recentRunProjectionForLoop(loopId, 200)
    try {
      this.send(IPC.loop.update, boundedLoopSnapshot({ loop, runs: projection.runs, totalRuns, detailTruncated: projection.truncatedFields, aggregate: this.ledger.runAggregate(loopId) }))
    } catch {
      /* the ledger remains authoritative across a transient renderer failure */
    }
    if (loop.status !== 'running') try {
      const runs = this.ledger.recentRunProjectionForLoop(loopId, 500).runs
      const snapshot = publishOwnedWorkspaceSnapshot(
        loop.workspaceDir,
        requireWorkspaceIdentity(loop),
        ['.gauntlet-gamesmith', 'reports', loop.id],
        'report-v2',
        '.md',
        buildReport(
          loop,
          runs,
          scanCritiqueArtifacts(loop.workspaceDir, loop),
          scanReferencePack(loop.workspaceDir, this.referenceDir(loop.id), loop),
          { totalRuns, aggregate: this.ledger.runAggregate(loopId) },
        ),
        'html',
        { managedPrefix: 'report-v2-', maxFiles: 8, maxBytes: 8 * 1024 * 1024 },
      )
      const relativeSnapshot = path.relative(loop.workspaceDir, snapshot)
      const message = `Immutable report snapshot: ${relativeSnapshot}`
      if (!this.ledger.eventsForLoop(loop.id, 100).some((event) => event.kind === 'artifact' && event.text === message)) {
        const line = this.persistLog(loop.id, null, 'artifact', message)
        this.notifyLog(line)
      }
    } catch (error) {
      this.log(loop.id, null, 'error', `Report write failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private terminalMessage(status: 'passed' | 'exhausted' | 'stopped' | 'failed', reason: string): string {
    const icon = status === 'passed' ? '🏆' : status === 'failed' ? '✗' : '■'
    return `${icon} Loop ${status}: ${reason}`
  }

  /** State and canonical terminal event are written together; safe to call repeatedly. */
  private persistLoopTerminal(loopId: string, status: 'passed' | 'exhausted' | 'stopped' | 'failed', reason: string): void {
    this.ledger.patchLoop(loopId, { status, stopReason: reason })
    const message = this.terminalMessage(status, reason)
    if (!this.ledger.eventsForLoop(loopId, 100).some((event) => event.kind === 'done' && event.text === message)) {
      this.persistLog(loopId, null, 'done', message)
    }
  }

  private finishLoop(loopId: string, status: 'passed' | 'exhausted' | 'stopped' | 'failed', reason: string): void {
    const retryTimer = this.retryTimers.get(loopId)
    if (retryTimer) this.deps.cancelDeferred(retryTimer)
    this.retryTimers.delete(loopId)
    this.rotations.delete(loopId)
    this.ledger.transaction(() => this.persistLoopTerminal(loopId, status, reason))
    this.stopRequested.delete(loopId)
    this.notifyPersistedLog(loopId, null, 'done', this.terminalMessage(status, reason))
    this.broadcast(loopId)
  }

  private async executeNext(loopId: string): Promise<void> {
    if (this.current || this.terminatingLoops.has(loopId)) return
    const loop = this.ledger.getLoop(loopId)
    if (!loop || loop.status !== 'running') return
    if (!this.verifyWorkspaceBoundary(loop)) return
    const owner = this.retainedProcessOwnership()
    if (owner) {
      this.log(loop.id, null, 'error', this.retainedOwnershipMessage(owner))
      return
    }
    if (this.stopRequested.has(loopId)) {
      this.finishLoop(loopId, 'stopped', 'Stopped by user.')
      return
    }
    const retryAt = this.queuedRetryAt(loopId)
    if (retryAt && retryAt > this.deps.now()) {
      this.scheduleRetry(loopId, retryAt)
      return
    }
    const run = this.ledger.nextQueuedRun(loopId)
    if (!run) return
    try {
      if (run.role === 'assets') {
        this.atomicLogs(() => {
          this.ledger.patchRun(run.id, {
            status: 'interrupted',
            error: 'Legacy Asset Build handed over to the folded implement phase.',
            finishedAt: this.nowIso(),
          })
          this.ledger.createRun({
            loopId: loop.id,
            round: run.round,
            role: 'implement',
            harness: harnessFor(loop.models.orchestratorModel),
            prompt: this.nextImplementPrompt(loop, run.round, this.verdictForRound(loop.id, run.round - 1)),
          })
          this.log(loop.id, run.id, 'system', 'Legacy Asset Build migrated into the implement round; no standalone asset process was launched.')
        })
        this.broadcast(loop.id)
        void this.executeNext(loop.id)
        return
      }
      const subscriptionBlock = this.subscriptionBlockForRun(loop, run)
      if (subscriptionBlock) {
        this.stopForSubscription(loop, run, subscriptionBlock.harness, subscriptionBlock.readiness)
        return
      }
      // Authentication/status probes are external calls. Re-check immediately
      // before handing the project path to a role in case it changed meanwhile.
      if (!this.verifyWorkspaceBoundary(loop)) return
      if (run.role === 'reference') await this.executeReference(loop, run)
      else if (run.role === 'implement') await this.executeImplement(loop, run)
      else await this.executeCritique(loop, run)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const persisted = this.ledger.getRun(run.id)
      this.ledger.patchRun(run.id, {
        durationMs: persisted?.startedAt ? this.deps.now() - Date.parse(persisted.startedAt) : 0,
        finishedAt: this.nowIso(),
      })
      this.failAttemptAndLoop(loop, run, message, `Run crashed: ${message}`)
    }
  }

  private prepareChildStreams(loop: LoopRecord, run: RunRecord): ChildStreamBoundary {
    const priorRunId = this.ledger.latestRunIdExcept(loop.id, run.id)
    if (priorRunId) {
      const archived = archiveChildStreams(loop.workspaceDir, priorRunId, loop)
      if (archived) this.log(loop.id, run.id, 'system', `Archived ${archived} delegated raw stream${archived === 1 ? '' : 's'} under .gauntlet-gamesmith/agents/${priorRunId}/.`)
    }
    return observeChildStreams(loop.workspaceDir, loop)
  }

  private failLaunch(loop: LoopRecord, run: RunRecord, message: string, startedAtMs: number): void {
    this.ledger.patchRun(run.id, {
      durationMs: Math.max(0, this.deps.now() - startedAtMs),
      finishedAt: this.nowIso(),
    })
    // Workspace process metadata is immutable portable evidence. Canonical
    // ownership in SQLite controls recovery; never unlink an agent-replaceable
    // pathname after a separable identity check.
    this.log(loop.id, run.id, 'error', message)
    this.failAttemptAndLoop(loop, run, message, message)
  }

  /** Fail closed after spawn without consulting the workspace mirror. */
  private stopSpawnedRunCanonical(loop: LoopRecord, run: RunRecord, reason: string, startedAtMs: number): void {
    this.stopRequested.add(loop.id)
    if (this.ledger.getRun(run.id)?.status !== 'running') return
    try {
      const finishedAt = this.nowIso()
      this.ledger.interruptRunAndStopLoopCanonical(
        loop.id,
        run.id,
        reason,
        finishedAt,
        Math.max(0, Math.floor(this.deps.now() - startedAtMs)),
      )
      this.notifyPersistedLog(loop.id, run.id, 'process-control', reason)
    } catch (error) {
      try {
        this.controlLog(loop.id, run.id, 'error', `Post-spawn quarantine could not be committed; launch supervision remains active: ${redactedErrorMessage(error, 'canonical state unavailable.')}`)
      } catch {
        /* process supervision and stopRequested remain authoritative in memory */
      }
    }
  }

  /**
   * A returned ChildProcess is still owned even when the OS has not supplied a
   * safe recoverable PID. Keep its error/exit handle live through
   * SIGINT→SIGKILL, and quarantine instead of pretending an unobserved child is
   * gone.
   */
  private superviseUnidentifiedChild(
    loop: LoopRecord,
    run: RunRecord,
    child: ReturnType<typeof spawn>,
    own: ExitHolder,
    message: string,
    startedAtMs: number,
  ): void {
    this.terminatingLoops.add(loop.id)
    this.stopRequested.add(loop.id)
    const report = (kind: string, text: string): void => {
      try {
        this.controlLog(loop.id, run.id, kind, text)
      } catch (error) {
        console.error('Could not persist direct-child process-control event:', error)
      }
    }
    let finished = false
    const reason = `${UNKNOWN_LAUNCH_OWNERSHIP} ${message} Canonical process-group ownership was not established after the stock CLI started; an early direct-child exit cannot prove that no detached descendant survived. This workspace remains quarantined against another launch.`
    const finishKnownGone = (): void => {
      if (finished || !own.exited) return
      finished = true
      this.terminatingLoops.delete(loop.id)
      // Even an observed direct-leader exit cannot prove that no detached
      // descendant survived before canonical group ownership was captured.
      // Preserve the durable quarantine marker and keep Resume denied.
    }
    child.once('error', finishKnownGone)
    child.once('exit', finishKnownGone)
    let interruptError: unknown = null
    try {
      child.kill('SIGINT')
    } catch (error) {
      interruptError = error
    }
    report(
      interruptError ? 'error' : 'system',
      interruptError
        ? `Direct child SIGINT could not be sent: ${interruptError instanceof Error ? interruptError.message : String(interruptError)}`
        : 'SIGINT sent through the newly returned child handle while launch identity is incomplete.',
    )
    if (!own.exited) this.deps.defer(() => {
      if (own.exited) {
        finishKnownGone()
        return
      }
      let killError: unknown = null
      try {
        child.kill('SIGKILL')
      } catch (error) {
        killError = error
      }
      report(
        killError ? 'error' : 'system',
        killError
          ? `Direct child SIGKILL could not be sent: ${killError instanceof Error ? killError.message : String(killError)}`
          : 'SIGKILL sent through the newly returned child handle after launch supervision timed out.',
      )
      this.deps.defer(() => {
        if (own.exited) {
          finishKnownGone()
          return
        }
        this.terminatingLoops.delete(loop.id)
        report('error', 'The unidentified direct child never reported exit after SIGKILL; permanent workspace quarantine remains in force.')
      }, 1_000).unref?.()
    }, 15_000).unref?.()
    // Scheduling direct-handle escalation precedes durable state work so a DB
    // or visibility failure cannot strand the child without a kill timer.
    this.stopSpawnedRunCanonical(loop, run, reason, startedAtMs)
    if (own.exited) finishKnownGone()
  }

  /** Spawn a detached CLI process whose stdout/stderr stream to files. */
  private spawnDetached(
    loop: LoopRecord,
    run: RunRecord,
    command: string,
    args: string[],
    env: Record<string, string>,
    effectivePrompt = run.prompt,
  ): { meta: RunProcessMeta; own: ExitHolder; groupIdentity: readonly string[] } | null {
    const subscriptionBlock = this.subscriptionBlockForRun(loop, run)
    if (subscriptionBlock) {
      this.stopForSubscription(loop, run, subscriptionBlock.harness, subscriptionBlock.readiness)
      return null
    }
    // CLI version/account probes can take seconds. They are provenance setup,
    // not part of the detached attempt: capture the launch time only after
    // those probes finish so boot recovery does not reject a healthy process
    // whose durable process start legitimately trails the run timestamp.
    let startedAtMs = 0
    let marker: ReturnType<typeof prepareProcessMeta>
    const own: ExitHolder = { exited: false, code: null, spawnError: null }
    let outFd: number | null = null
    let errFd: number | null = null
    const closeStreams = (): void => {
      if (outFd !== null) {
        try { fs.closeSync(outFd) } catch { /* already closed */ }
        outFd = null
      }
      if (errFd !== null) {
        try { fs.closeSync(errFd) } catch { /* already closed */ }
        errFd = null
      }
    }
    let streamIdentity: ProcessStreamIdentity
    let spawnedOutFd = -1
    let spawnedErrFd = -1
    try {
      const model = run.role === 'critique' ? loop.models.criticModel : loop.models.orchestratorModel
      const effort = run.role === 'critique' ? loop.models.criticEffort : loop.models.orchestratorEffort
      const version = redactLogText(this.deps.cliVersion(command, env, loop.workspaceDir))
        .replace(/[\u0000-\u001f\u007f]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 200) || 'unavailable'
      const promptSha256 = createHash('sha256').update(effectivePrompt).digest('hex')
      let machineLabel = 'unknown-host'
      try {
        machineLabel = this.deps.hostname().trim().slice(0, 255) || machineLabel
      } catch {
        /* a missing host label does not justify reading any broader machine state */
      }
      let accountLabel = `${run.harness}:profile-unavailable`
      try {
        accountLabel = redactLogText(this.deps.accountLabel(run.harness, command, env, loop.workspaceDir))
          .replace(/[\u0000-\u001f\u007f]/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 255) || accountLabel
      } catch {
        /* the status command failed without widening into credential-file reads */
      }
      // Version/account probes are external processes. Rebind the root before
      // launch state is committed or the detached editor is spawned.
      if (!this.verifyWorkspaceBoundary(loop)) {
        closeStreams()
        return null
      }
      startedAtMs = this.deps.now()
      marker = prepareProcessMeta(loop.workspaceDir, run.id, startedAtMs, requireWorkspaceIdentity(loop))
      const flags = fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_APPEND | fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW ?? 0)
      outFd = fs.openSync(marker.outPath, flags, 0o600)
      errFd = fs.openSync(marker.errPath, flags, 0o600)
      spawnedOutFd = outFd
      spawnedErrFd = errFd
      const outStat = fs.fstatSync(spawnedOutFd)
      const errStat = fs.fstatSync(spawnedErrFd)
      streamIdentity = {
        outDev: outStat.dev,
        outIno: outStat.ino,
        errDev: errStat.dev,
        errIno: errStat.ino,
      }
      this.ledger.patchRun(run.id, {
        prompt: effectivePrompt,
        status: 'running',
        startedAt: new Date(startedAtMs).toISOString(),
        model,
        effort,
        cliVersion: version,
        priceTableVersion: PRICE_TABLE_VERSION,
        costSource: null,
        promptSha256,
        accountLabel,
        machineLabel,
        authMode: 'subscription',
      })
      this.logPrompt(loop.id, run.id, runPromptLabel(run), effectivePrompt)
      this.log(
        loop.id,
        run.id,
        'system',
        `Run provenance: ${command} ${version} · model ${model} · effort ${effort} · prompt sha256:${promptSha256} · ${accountLabel} on ${machineLabel} · subscription auth · price table ${PRICE_TABLE_VERSION} · cost labeled equivalent API cost.`,
      )
      this.broadcast(loop.id)
    } catch (error) {
      closeStreams()
      const message = startedAtMs === 0
        ? `Could not establish run provenance: ${error instanceof Error ? error.message : String(error)}`
        : `Cannot persist process launch record: ${error instanceof Error ? error.message : String(error)}`
      this.failLaunch(loop, run, message, startedAtMs || this.deps.now())
      return null
    }
    if (!this.verifyWorkspaceBoundary(loop)) {
      closeStreams()
      return null
    }
    let child: ReturnType<typeof spawn>
    try {
      child = this.deps.spawnChild(command, args, { cwd: loop.workspaceDir, env, detached: true, stdio: ['ignore', spawnedOutFd, spawnedErrFd] })
    } catch (error) {
      closeStreams()
      const message = `Could not spawn ${command}: ${error instanceof Error ? error.message : String(error)}`
      this.failLaunch(loop, run, message, startedAtMs)
      return null
    }
    closeStreams()
    child.on('error', (error) => {
      own.spawnError = error.message
      own.exited = true
      own.code = -1
    })
    child.on('exit', (code) => {
      own.exited = true
      own.code = code
    })
    try {
      child.unref()
    } catch (error) {
      this.controlLog(loop.id, run.id, 'error', `Spawned child could not be detached from the app handle: ${error instanceof Error ? error.message : String(error)}. Continuing direct supervision.`)
    }
    if (!safePid(child.pid)) {
      const message = `${command} spawned without a safe PID.`
      this.superviseUnidentifiedChild(loop, run, child, own, message, startedAtMs)
      return null
    }
    let meta: RunProcessMeta | null = null
    let groupIdentity: readonly string[] = []
    try {
      groupIdentity = this.deps.processGroupIdentity(child.pid)
      meta = this.deps.completeProcessMeta(loop.workspaceDir, run.id, marker, child.pid, streamIdentity, groupIdentity)
      if (!groupIdentity.includes(`${meta.pid}:${meta.processIdentity}`)) {
        throw new Error('Spawned process group did not retain the captured leader identity.')
      }
      this.ledger.setRunProcessOwnership(run.id, {
        pid: meta.pid,
        processIdentity: meta.processIdentity,
        groupIdentities: [...groupIdentity],
        startedAtMs: meta.startedAtMs,
        outDev: meta.outDev,
        outIno: meta.outIno,
        errDev: meta.errDev,
        errIno: meta.errIno,
      })
    } catch (error) {
      const message = `Could not persist spawned process identity: ${error instanceof Error ? error.message : String(error)}`
      if (!meta) {
        this.superviseUnidentifiedChild(loop, run, child, own, message, startedAtMs)
        return null
      }
      this.stopRequested.add(loop.id)
      this.terminatingLoops.add(loop.id)
      let settled = false
      const settle = (outcome: 'gone' | 'unresolved'): void => {
        if (settled) return
        settled = true
        this.terminatingLoops.delete(loop.id)
        if (outcome === 'gone') {
          const canonical = this.ledger.runProcessOwnership(run.id)
          if (canonical && canonical.pid === meta!.pid && canonical.processIdentity === meta!.processIdentity) {
            this.ledger.clearRunProcessOwnership(run.id)
          }
          return
        }
        try {
          this.controlLog(loop.id, run.id, 'error', `${UNKNOWN_LAUNCH_OWNERSHIP} The owned process group remained live after bounded escalation; manual intervention is required.`)
        } catch (reportError) {
          console.error('Could not persist unresolved process-control event:', reportError)
        }
      }
      const report = (line: string): void => {
        try {
          this.controlLog(loop.id, run.id, line.includes('could not') || line.includes('skipped') ? 'error' : 'system', line)
        } catch (reportError) {
          console.error('Could not persist process-control event:', reportError)
        }
      }
      const processDeps = {
        kill: this.deps.signalProcess,
        defer: this.deps.defer,
        groupIdentity: this.deps.processGroupIdentity,
        groupStillOwned: this.deps.processGroupStillOwned,
      }
      if (processMatches(meta)) {
        interruptProcessGroup(meta, report, { ...processDeps, identityMatches: processMatches }, settle)
      } else {
        // The leader may have exited after forking. Continue only from the
        // exact launch snapshot; never adopt a fresh numeric PGID.
        interruptCapturedProcessGroup(meta.pid, groupIdentity, report, settle, processDeps)
      }
      this.stopSpawnedRunCanonical(
        loop,
        run,
        `${UNKNOWN_LAUNCH_OWNERSHIP} ${message} Process-group ownership could not be committed after the stock CLI started; this workspace remains quarantined against another launch.`,
        startedAtMs,
      )
      return null
    }
    return { meta, own, groupIdentity }
  }

  /**
   * Tail the run's output files, feeding lines to the parser (replaying from
   * byte 0 on re-attach with already-logged lines suppressed), until the
   * process exits — then finalize.
   */
  private async driveRun(
    loop: LoopRecord,
    run: RunRecord,
    meta: RunProcessMeta,
    idleMs: number,
    hardCapMs: number,
    parser: StreamParser,
    gate: LogGate,
    own: ExitHolder | null,
    initialGroupIdentity: readonly string[],
    childBoundary: ChildStreamBoundary,
  ): Promise<void> {
    try {
      await this.driveOwnedRun(loop, run, meta, idleMs, hardCapMs, parser, gate, own, initialGroupIdentity, childBoundary)
    } catch (error) {
      const message = `Run supervision could not start safely: ${error instanceof Error ? error.message : String(error)}`
      this.stopRequested.add(loop.id)
      this.interrupt(meta, loop.id, run.id)
      this.controlLog(loop.id, run.id, 'error', message)
      this.stopSpawnedRunCanonical(loop, run, message, meta.startedAtMs)
      if (this.current?.runId === run.id) this.current = null
      if (this.childTail?.runId === run.id) this.childTail = null
    }
  }

  private async driveOwnedRun(
    loop: LoopRecord,
    run: RunRecord,
    meta: RunProcessMeta,
    idleMs: number,
    hardCapMs: number,
    parser: StreamParser,
    gate: LogGate,
    own: ExitHolder | null,
    initialGroupIdentity: readonly string[],
    childBoundary: ChildStreamBoundary,
  ): Promise<void> {
    // Extend ownership only across an exact member overlap. The leader proves
    // the first snapshot; a captured child can then prove a later grandchild
    // after the leader exits. A reused PGID with no overlap is never adopted.
    const capturedGroupIdentity = new Set(initialGroupIdentity)
    const groupSnapshot = (): readonly string[] => [...capturedGroupIdentity]
    const canonicalProjection = this.ledger.getRun(run.id)?.metrics?.projection
    if (canonicalProjection) {
      meta.loggedOutLines = canonicalProjection.loggedOutLines
      meta.loggedErrLines = canonicalProjection.loggedErrLines
      meta.childOffsets = canonicalProjection.childOffsets
      meta.childIdentities = canonicalProjection.childIdentities ?? {}
      meta.workflowOffsets = canonicalProjection.workflowOffsets
      meta.workflowIdentities = canonicalProjection.workflowIdentities ?? {}
    }
    const att: Attachment = { loopId: loop.id, runId: run.id, meta, timedOut: false }
    this.current = att
    const childDirectory = assertChildStreamBoundary(childBoundary)
    const childTailer = new ChildStreamTailer(
      childDirectory,
      meta.startedAtMs,
      meta.childOffsets,
      meta.childIdentities,
    )
    this.childTail = { loopId: loop.id, runId: run.id, boundary: childBoundary, tailer: childTailer }

    let outOffset = 0
    let outRemainder = ''
    let outLine = 0
    let errOffset = 0
    let errRemainder = ''
    let warnedLongOut = false
    let warnedLongErr = false
    let errLine = 0
    let lastMetaWrite = 0
    let lastChildProgressAt = meta.startedAtMs
    const initialOutLogged = meta.loggedOutLines
    const initialErrLogged = meta.loggedErrLines

    const readNew = (filePath: string, offset: number): { text: string; nextOffset: number } | null => {
      let fd: number | null = null
      try {
        const expected = filePath === meta.outPath
          ? { dev: meta.outDev, ino: meta.outIno }
          : { dev: meta.errDev, ino: meta.errIno }
        const entry = fs.lstatSync(filePath)
        if (
          !entry.isFile()
          || entry.isSymbolicLink()
          || entry.nlink !== 1
          || entry.dev !== expected.dev
          || entry.ino !== expected.ino
        ) throw new Error('run stream changed identity after launch')
        fd = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0))
        const stat = fs.fstatSync(fd)
        if (
          !stat.isFile()
          || stat.nlink !== 1
          || stat.dev !== entry.dev
          || stat.ino !== entry.ino
          || stat.dev !== expected.dev
          || stat.ino !== expected.ino
        ) throw new Error('run stream changed identity while it was opened')
        const size = stat.size
        if (size <= offset) return null
        const buf = Buffer.alloc(Math.min(MAX_STREAM_READ_BYTES, size - offset))
        const bytesRead = fs.readSync(fd, buf, 0, buf.length, offset)
        return { text: buf.subarray(0, bytesRead).toString('utf8'), nextOffset: offset + bytesRead }
      } finally {
        if (fd !== null) fs.closeSync(fd)
      }
    }

    const parseStdout = (line: string): void => {
      try {
        parser.onLine(line)
      } catch (error) {
        this.log(
          loop.id,
          run.id,
          'error',
          `Parser rejected a ${run.harness} stdout line: ${error instanceof Error ? error.message : String(error)} · raw ${trunc(line, 300)}`,
        )
      }
    }

    const parseStderr = (line: string): void => {
      try {
        parser.onStderr(line)
      } catch (error) {
        this.log(loop.id, run.id, 'error', `Parser rejected stderr: ${error instanceof Error ? error.message : String(error)} · raw ${trunc(line, 300)}`)
      }
    }

    const boundPartialLine = (text: string, stream: 'stdout' | 'stderr'): string => {
      if (text.length <= MAX_PARTIAL_LINE_CHARS) return text
      const warned = stream === 'stdout' ? warnedLongOut : warnedLongErr
      if (!warned) {
        this.log(
          loop.id,
          run.id,
          'error',
          `${run.harness} ${stream} emitted a line longer than ${MAX_PARTIAL_LINE_CHARS} characters; retaining its tail and continuing supervision.`,
        )
        if (stream === 'stdout') warnedLongOut = true
        else warnedLongErr = true
      }
      return text.slice(-MAX_PARTIAL_LINE_CHARS)
    }

    const pump = (): void => {
      this.atomicLogs(() => {
      const out = readNew(meta.outPath, outOffset)
      if (out) {
        outOffset = out.nextOffset
        const lines = (outRemainder + out.text).split('\n')
        outRemainder = boundPartialLine(lines.pop() ?? '', 'stdout')
        for (const line of lines) {
          warnedLongOut = false
          outLine += 1
          gate.suppress = outLine <= initialOutLogged
          parseStdout(line.length > MAX_PARTIAL_LINE_CHARS ? boundPartialLine(line, 'stdout') : line)
        }
        gate.suppress = false
        meta.loggedOutLines = Math.max(meta.loggedOutLines, outLine)
      }
      const err = readNew(meta.errPath, errOffset)
      if (err) {
        errOffset = err.nextOffset
        const lines = (errRemainder + err.text).split('\n')
        errRemainder = boundPartialLine(lines.pop() ?? '', 'stderr')
        for (const line of lines) {
          warnedLongErr = false
          errLine += 1
          gate.suppress = errLine <= initialErrLogged
          if (line.trim()) parseStderr(line.length > MAX_PARTIAL_LINE_CHARS ? boundPartialLine(line, 'stderr') : line)
        }
        gate.suppress = false
        meta.loggedErrLines = Math.max(meta.loggedErrLines, errLine)
      }
      if (this.pumpChildStreams() > 0) lastChildProgressAt = this.deps.now()
      parser.tick?.()
      meta.childOffsets = childTailer.snapshot()
      meta.childIdentities = childTailer.identitySnapshot()
      meta.workflowOffsets = parser.workflowOffsets?.() ?? meta.workflowOffsets ?? {}
      meta.workflowIdentities = parser.workflowIdentities?.() ?? meta.workflowIdentities ?? {}
      const currentMetrics = this.ledger.getRun(run.id)?.metrics ?? { agents: [], perModel: {} }
      this.ledger.patchRun(run.id, {
        metrics: {
          ...currentMetrics,
          projection: {
            loggedOutLines: meta.loggedOutLines,
            loggedErrLines: meta.loggedErrLines,
            childOffsets: meta.childOffsets ?? {},
            childIdentities: meta.childIdentities ?? {},
            workflowOffsets: meta.workflowOffsets,
            workflowIdentities: meta.workflowIdentities,
          },
        },
      })
      if (this.deps.now() - lastMetaWrite > 1_000) lastMetaWrite = this.deps.now()
      })
    }
    let driveFailed = false
    let workspaceSafe = true
    try {
      await new Promise<void>((resolve, reject) => {
        const interval = this.deps.repeat(() => {
          try {
            pump()
            const now = this.deps.now()
            const progressAt = Math.max(parser.progressAt?.() ?? meta.startedAtMs, lastChildProgressAt)
            const idleFor = now - progressAt
            const stalled = idleFor > idleMs
            const overCap = now - meta.startedAtMs > hardCapMs
            if (!att.timedOut && (stalled || overCap)) {
              att.timedOut = true
              if (processMatches(meta)) this.interrupt(meta, loop.id, run.id)
              else this.interruptCaptured(meta, groupSnapshot(), loop.id, run.id)
              this.controlLog(
                loop.id,
                run.id,
                'error',
                stalled
                  ? `No progress for ${Math.round(idleFor / 60_000)} min — interrupting.`
                  : `Run exceeded the ${Math.round(hardCapMs / 3_600_000)}h ceiling — interrupting.`,
              )
            }
            const leaderDead = own ? own.exited : !processMatches(meta)
            const refreshed = this.deps.processGroupIdentity(meta.pid)
            if (refreshed.some((identity) => capturedGroupIdentity.has(identity))) {
              let advanced = false
              for (const identity of refreshed) {
                if (!capturedGroupIdentity.has(identity)) advanced = true
                capturedGroupIdentity.add(identity)
              }
              if (advanced) {
                const union = [...groupSnapshot()]
                this.ledger.updateRunProcessGroupIdentities(run.id, union)
                meta.groupIdentities = union
              }
            }
            const captured = groupSnapshot()
            const descendantsRemain = captured.length > 0 && this.deps.processGroupStillOwned(meta.pid, captured)
            if (leaderDead && !descendantsRemain) {
              this.deps.cancelRepeat(interval)
              resolve()
            }
          } catch (error) {
            this.deps.cancelRepeat(interval)
            reject(error)
          }
        }, 400)
      })
      await this.deps.wait(300)
      workspaceSafe = this.verifyWorkspaceBoundary(loop)
      if (!workspaceSafe) return
      pump()
      if (outRemainder.trim()) parseStdout(outRemainder)

      // `current` intentionally remains owned through finalize. Finalizers can
      // wait on children or queue successors without opening a duplicate seam.
      await parser.finalize({ code: own ? own.code : null, timedOut: att.timedOut, spawnError: own?.spawnError ?? null })
      this.pumpChildStreams()
    } catch (error) {
      driveFailed = true
      const message = error instanceof Error ? error.message : String(error)
      // Process control and its event are canonical-only: a broken portable
      // mirror must never prevent SIGINT or bounded escalation.
      this.interrupt(meta, loop.id, run.id)
      this.controlLog(loop.id, run.id, 'error', `Run supervision failed: ${message}`)
      workspaceSafe = this.verifyWorkspaceBoundary(loop)
      if (!workspaceSafe) {
        // Keep process control, but do not refresh portable metadata or touch
        // any path beneath a workspace root that now resolves into app data.
        return
      }
      const currentRun = this.ledger.getRun(run.id)
      if (currentRun && (currentRun.status === 'running' || currentRun.status === 'queued')) {
        this.ledger.patchRun(run.id, {
          durationMs: this.deps.now() - meta.startedAtMs,
          finishedAt: this.nowIso(),
        })
      }
      if (this.ledger.getLoop(loop.id)?.status === 'running') {
        this.failAttemptAndLoop(loop, run, `Run supervision failed: ${message}`, `Run supervision failed: ${message}`)
      }
    } finally {
      if (workspaceSafe && this.childTail?.runId === run.id) {
        try {
          this.pumpChildStreams()
        } catch (error) {
          this.controlLog(loop.id, run.id, 'error', `Final child-stream drain failed: ${error instanceof Error ? error.message : String(error)}`)
        }
        this.childTail = null
      } else if (this.childTail?.runId === run.id) {
        this.childTail = null
      }
      if (this.current?.runId === run.id) this.current = null
      const captured = groupSnapshot()
      let descendantsRemain = captured.length > 0
      try {
        descendantsRemain &&= this.deps.processGroupStillOwned(meta.pid, captured)
      } catch (error) {
        descendantsRemain = true
        this.controlLog(loop.id, run.id, 'error', `Final process-group absence could not be verified; canonical ownership is retained: ${error instanceof Error ? error.message : String(error)}`)
      }
      if (!descendantsRemain && this.ledger.runProcessOwnership(run.id)) this.ledger.clearRunProcessOwnership(run.id)
      // Retain the workspace process snapshot as portable replay evidence.
      // Canonical ownership is cleared only in SQLite after verified absence.
    }
    if (!driveFailed) void this.executeNext(loop.id)
  }

  /** Session id of an earlier attempt for this exact round, if reported. */
  private lastImplementSessionId(loopId: string, round: number, exceptRunId: string): string | null {
    return this.ledger.latestImplementSessionId(loopId, round, exceptRunId)
  }

  private castFor(loop: LoopRecord): CastEntry[] {
    return parseCast(scanReferencePack(loop.workspaceDir, this.referenceDir(loop.id), loop).manifest)
  }

  private wantedCast(loop: LoopRecord, verdict: Verdict | null): CastEntry[] {
    if (!loop.models.assetModel) return []
    const cast = this.castFor(loop)
    if (cast.length === 0) return []
    const faulted = assetTargets(verdict?.findings ?? [])
    return faulted.length > 0
      ? cast.filter((entry) => faulted.includes(entry.name))
      : unbuiltCast(loop.workspaceDir, cast)
  }

  private verdictForRound(loopId: string, round: number): Verdict | null {
    return this.ledger.runsForLoop(loopId)
      .find((candidate) => candidate.role === 'critique' && candidate.round === round && candidate.verdict)
      ?.verdict ?? null
  }

  private nextImplementPrompt(loop: LoopRecord, round: number, verdict: Verdict | null): string {
    return buildImplementPrompt(
      loop.models,
      loop.prompt,
      round,
      verdict,
      this.referenceDir(loop.id),
      this.wantedCast(loop, verdict),
    )
  }

  // --------------------------------------------------------------- reference

  private async executeReference(loop: LoopRecord, run: RunRecord): Promise<void> {
    const models = loop.models
    if (!this.ensureReferenceSourceBaseline(loop, run)) return
    const childBoundary = this.prepareChildStreams(loop, run)
    this.log(
      loop.id,
      run.id,
      'system',
      `● Reference Study (${run.harness} ${models.orchestratorModel}, effort ${models.orchestratorEffort})`,
    )
    const plan = referencePlan({
      models,
      prompt: run.prompt,
      claudeHome: this.deps.harnessHome('claude'),
      codexHome: this.deps.harnessHome('codex'),
    })
    const executable = this.executableEnvironment(loop, run, plan.env)
    const gate: LogGate = { suppress: false }
    const parser = this.makeReferenceParser(loop, run, gate, childBoundary)
    const spawned = this.spawnDetached(loop, run, executable.command, plan.args, executable.env)
    if (!spawned) return
    await this.driveRun(loop, run, spawned.meta, REFERENCE_TIMEOUT_MS, REFERENCE_TIMEOUT_MS, parser, gate, spawned.own, spawned.groupIdentity, childBoundary)
  }

  private makeReferenceParser(loop: LoopRecord, run: RunRecord, gate: LogGate, childBoundary: ChildStreamBoundary): StreamParser {
    return createReferenceProtocol({
      ledger: this.ledger,
      loop,
      run,
      gate,
      childBoundary,
      referenceDir: this.referenceDir(loop.id),
      maxAttempts: MAX_REFERENCE_ATTEMPTS,
      now: this.deps.now,
      nowIso: () => this.nowIso(),
      harnessHome: this.deps.harnessHome,
      log: (kind, text, agentId) => this.log(loop.id, run.id, kind, text, agentId),
      persistLog: (kind, text) => { this.persistLog(loop.id, run.id, kind, text) },
      notifyPersistedLog: (kind, text) => this.notifyPersistedLog(loop.id, run.id, kind, text),
      broadcast: () => this.broadcast(loop.id),
      awaitChildren: () => this.awaitChildren(loop, run, childBoundary),
      isStopRequested: () => this.stopRequested.has(loop.id),
      finishCancelled: (exit, reason, terminalLog) => this.finishCancelledAttempt(loop, run, exit, reason, terminalLog),
      ensureSourceBaseline: (terminalLog) => this.ensureReferenceSourceBaseline(loop, run, terminalLog),
      failOrRetry: (error, label, maxAttempts, prompt, terminalLog) => this.failOrRetryPhase(loop, run, error, label, maxAttempts, prompt, terminalLog),
      overBudget: () => this.overBudget(loop.id),
      persistLoopTerminal: (status, reason) => this.persistLoopTerminal(loop.id, status, reason),
      implementPrompt: (round, verdict) => this.nextImplementPrompt(loop, round, verdict),
    })
  }
  // ---------------------------------------------------------------- implement

  private async executeImplement(loop: LoopRecord, run: RunRecord): Promise<void> {
    const models = loop.models
    const harness = harnessFor(models.orchestratorModel)
    if (!this.verifyReferenceBoundary(loop, run)) return
    if (!this.verifyCritiqueTreeBoundary(loop, run, true)) return
    const wanted = this.wantedCast(loop, this.verdictForRound(loop.id, run.round - 1))
    if (wanted.length > 0) {
      const skill = ensureSkill()
      if (!skill.dir) {
        this.failAttemptAndLoop(
          loop,
          run,
          'The img2threejs skill is missing from this install.',
          'The implement round cannot sculpt its Reference Study cast until Gauntlet Gamesmith is reinstalled.',
        )
        return
      }
      scaffoldAssetTools(loop.workspaceDir, skill.dir, requireWorkspaceIdentity(loop))
      const sculptor = sculptorAgentMd(models, this.referenceDir(loop.id))
      if (sculptor) {
        const result = writeWorkspaceFileSafely(
          loop.workspaceDir,
          requireWorkspaceIdentity(loop),
          ['.claude', 'agents'],
          'sculptor.md',
          sculptor,
          { replace: true },
        )
        if (result === 'created' || result === 'updated') {
          this.log(loop.id, run.id, 'system', `Published the sculptor agent definition (${result}).`)
        }
      }
    }
    const scaffold = scaffoldEngine(loop.workspaceDir, requireWorkspaceIdentity(loop))
    if (scaffold.refreshed.length > 0) {
      this.log(loop.id, run.id, 'system', `Restored app-owned engine files: ${scaffold.refreshed.join(', ')}.`)
    }
    const agent = implementerAgentDefinition(models, this.referenceDir(loop.id))
    if (agent) {
      publishOwnedWorkspaceFile(loop.workspaceDir, requireWorkspaceIdentity(loop), ['.claude', 'agents'], agent.filename, agent.markdown, 'yaml-frontmatter', {
        managedPrefix: GAUNTLET_IMPLEMENTER_AGENT_PREFIX,
        maxFiles: 256,
        maxBytes: 4 * 1024 * 1024,
      })
    }
    const childBoundary = this.prepareChildStreams(loop, run)

    const priorSessionId = this.lastImplementSessionId(loop.id, run.round, run.id)
    const effective = effectivePromptForRun(run.prompt)
    const isResume = effective.resumeRequested && priorSessionId != null
    const prompt = effective.prompt

    this.log(
      loop.id,
      run.id,
      'system',
      `● Round ${run.round} — implement (${harness} ${models.orchestratorModel}, effort ${models.orchestratorEffort})${isResume ? ' — continuing interrupted session' : ''}`,
    )
    const plan = implementPlan({
      models,
      prompt,
      claudeHome: this.deps.harnessHome('claude'),
      codexHome: this.deps.harnessHome('codex'),
      resumeId: isResume ? priorSessionId : null,
    })
    const executable = this.executableEnvironment(loop, run, plan.env)
    const gate: LogGate = { suppress: false }
    const parser =
      harness === 'claude'
        ? this.makeImplementParser(loop, run, gate, childBoundary)
        : this.makeCodexImplementParser(loop, run, gate, childBoundary)
    const spawned = this.spawnDetached(loop, run, executable.command, plan.args, executable.env, prompt)
    if (!spawned) return
    await this.driveRun(loop, run, spawned.meta, IMPLEMENT_IDLE_MS, IMPLEMENT_HARD_CAP_MS, parser, gate, spawned.own, spawned.groupIdentity, childBoundary)
  }

  /**
   * Hold the round open while delegated workers are still writing.
   *
   * An orchestrator can finish its turn with children still running — a claude
   * one will not sit and wait, and on a real round it said "still waiting on
   * the codex runs" and exited, which committed a half-written build eight
   * minutes before codex finished. Waiting is the app's job, not an agent's.
   */
  private async awaitChildren(loop: LoopRecord, run: RunRecord, childBoundary: ChildStreamBoundary): Promise<void> {
    const deadline = this.deps.now() + IMPLEMENT_HARD_CAP_MS
    let announced = false
    while (!this.stopRequested.has(loop.id) && childrenActive(childBoundary, CHILD_QUIET_MS, this.deps.now()) && this.deps.now() < deadline) {
      if (!announced) {
        announced = true
        this.log(loop.id, run.id, 'system', '⏳ orchestrator finished, delegated workers still running — holding the round open.')
      }
      await this.deps.wait(15_000)
      this.pumpChildStreams()
    }
    if (this.stopRequested.has(loop.id)) return
    if (announced) {
      const stillActive = childrenActive(childBoundary, CHILD_QUIET_MS, this.deps.now())
      if (stillActive) throw new Error('Delegated-worker deadline expired before every worker emitted a terminal protocol event and became quiet.')
      this.log(loop.id, run.id, 'system', '✓ delegated workers finished.')
    }
  }

  private makeImplementParser(
    loop: LoopRecord,
    run: RunRecord,
    gate: LogGate,
    childBoundary: ChildStreamBoundary,
    initialWorkflowOffsets: Record<string, number> = {},
    initialWorkflowIdentities: Record<string, { dev: number; ino: number }> = {},
  ): StreamParser {
    return createClaudeImplementProtocol({
      ledger: this.ledger,
      loop,
      run,
      gate,
      childBoundary,
      initialWorkflowOffsets,
      initialWorkflowIdentities,
      now: this.deps.now,
      nowIso: () => this.nowIso(),
      harnessHome: this.deps.harnessHome,
      log: (kind, text, agentId) => this.log(loop.id, run.id, kind, text, agentId),
      broadcast: () => this.broadcast(loop.id),
      finalize: (exit, collect) => this.finishImplement(loop, run, childBoundary, exit, collect),
    })
  }

  /**
   * Everything that happens after an implement run's process exits, whichever
   * CLI ran it: wait for delegated workers, record the run, then either stop
   * the loop or hand the round to the critic.
   */
  /**
   * An implement run driven by codex.
   *
   * Codex spawns its workers as threads of its own, each with its own session
   * log under CODEX_HOME, so per-worker tokens are read from there rather than
   * from the stream — the stream carries only the orchestrator's turns. Claude
   * workers, when the run delegates across harnesses, report through their own
   * stream files instead.
   */
  private makeCodexImplementParser(loop: LoopRecord, run: RunRecord, gate: LogGate, childBoundary: ChildStreamBoundary): StreamParser {
    return createCodexImplementProtocol({
      ledger: this.ledger,
      loop,
      run,
      gate,
      childBoundary,
      now: this.deps.now,
      nowIso: () => this.nowIso(),
      harnessHome: this.deps.harnessHome,
      log: (kind, text, agentId) => this.log(loop.id, run.id, kind, text, agentId),
      broadcast: () => this.broadcast(loop.id),
      finalize: (exit, collect) => this.finishImplement(loop, run, childBoundary, exit, collect),
    })
  }

  private async finishImplement(
    loop: LoopRecord,
    run: RunRecord,
    childBoundary: ChildStreamBoundary,
    exit: ExitInfo,
    collect: () => ImplementOutcome,
  ): Promise<void> {
    await finalizeImplement({
      ledger: this.ledger,
      loop,
      run,
      now: this.deps.now,
      nowIso: () => this.nowIso(),
      referenceDir: this.referenceDir(loop.id),
      awaitChildren: () => this.awaitChildren(loop, run, childBoundary),
      isStopRequested: () => this.stopRequested.has(loop.id),
      finishCancelled: (finalExit, reason, terminalLog) => this.finishCancelledAttempt(loop, run, finalExit, reason, terminalLog),
      verifyCritiqueTree: (terminalLog) => this.verifyCritiqueTreeBoundary(loop, run, false, terminalLog),
      retryRateLimit: (error, terminalLog) => this.retryRateLimit(loop, run, error, terminalLog),
      failAttempt: (error, reason, terminalLog) => { this.failAttemptAndLoop(loop, run, error, reason, terminalLog) },
      verifyReference: (terminalLog) => this.verifyReferenceBoundary(loop, run, terminalLog),
      persistLog: (kind, text) => { this.persistLog(loop.id, run.id, kind, text) },
      notifyPersistedLog: (kind, text) => this.notifyPersistedLog(loop.id, run.id, kind, text),
      persistLoopTerminal: (status, reason) => this.persistLoopTerminal(loop.id, status, reason),
      finishLoop: (status, reason) => this.finishLoop(loop.id, status, reason),
      broadcast: () => this.broadcast(loop.id),
    }, exit, collect)
  }

  // ---------------------------------------------------------------- critique

  private async executeCritique(loop: LoopRecord, run: RunRecord): Promise<void> {
    const models = loop.models
    if (!this.verifyReferenceBoundary(loop, run)) return
    const childBoundary = this.prepareChildStreams(loop, run)
    if (!run.revision) {
      this.failAttemptAndLoop(loop, run, 'Critique has no implementation revision binding.', `Round ${run.round} critique has no implementation revision binding.`)
      return
    }
    if (!workspaceMatchesRevision(loop.workspaceDir, loop.id, run.revision)) {
      this.log(loop.id, run.id, 'error', `Stale critique rejected before launch: workspace no longer matches revision ${run.revision}.`)
      this.failAttemptAndLoop(
        loop,
        run,
        'Workspace changed after implementation revision capture.',
        `Workspace changed before round ${run.round} critique could judge revision ${run.revision.slice(0, 12)}.`,
      )
      return
    }
    let verdictPath: string
    try {
      verdictPath = prepareVerdictArtifact(loop.workspaceDir, run.round, run.id)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.failAttemptAndLoop(
        loop,
        run,
        `Could not prepare a fresh verdict artifact: ${message}`,
        `Round ${run.round} critique could not claim its verdict path: ${message}`,
      )
      return
    }
    this.log(
      loop.id,
      run.id,
      'system',
      `● Round ${run.round} — critique (${run.harness} ${models.criticModel}, effort ${models.criticEffort}, fresh eyes)`,
    )
    const exactPrompt = buildCriticPrompt(
      loop.prompt,
      run.round,
      this.referenceDir(loop.id),
      run.revision,
      path.basename(verdictPath),
      engineGateRules(),
    )
    const plan = critiquePlan({
      models,
      prompt: exactPrompt,
      claudeHome: this.deps.harnessHome('claude'),
      codexHome: this.deps.harnessHome('codex'),
    })
    const executable = this.executableEnvironment(loop, run, plan.env)
    const gate: LogGate = { suppress: false }
    const parser = this.makeCritiqueParser(loop, run, gate)
    const spawned = this.spawnDetached(loop, run, executable.command, plan.args, executable.env, exactPrompt)
    if (!spawned) return
    await this.driveRun(loop, run, spawned.meta, CRITIQUE_TIMEOUT_MS, CRITIQUE_TIMEOUT_MS, parser, gate, spawned.own, spawned.groupIdentity, childBoundary)
  }

  private makeCritiqueParser(loop: LoopRecord, run: RunRecord, gate: LogGate): StreamParser {
    return createCritiqueProtocol({
      ledger: this.ledger,
      loop,
      run,
      gate,
      referenceDir: this.referenceDir(loop.id),
      maxAttempts: MAX_CRITIQUE_ATTEMPTS,
      now: this.deps.now,
      nowIso: () => this.nowIso(),
      log: (kind, text, agentId) => this.log(loop.id, run.id, kind, text, agentId),
      persistLog: (kind, text) => { this.persistLog(loop.id, run.id, kind, text) },
      notifyPersistedLog: (kind, text) => this.notifyPersistedLog(loop.id, run.id, kind, text),
      broadcast: () => this.broadcast(loop.id),
      finishCancelled: (exit, reason, terminalLog) => this.finishCancelledAttempt(loop, run, exit, reason, terminalLog),
      verifyReference: (terminalLog) => this.verifyReferenceBoundary(loop, run, terminalLog),
      failOrRetry: (error, label, maxAttempts, prompt, terminalLog) => this.failOrRetryPhase(loop, run, error, label, maxAttempts, prompt, terminalLog),
      overBudget: () => this.overBudget(loop.id),
      finishLoop: (status, reason) => this.finishLoop(loop.id, status, reason),
      persistLoopTerminal: (status, reason) => this.persistLoopTerminal(loop.id, status, reason),
      implementPrompt: (round, verdict) => this.nextImplementPrompt(loop, round, verdict),
    })
  }
  private overBudget(loopId: string): boolean {
    if (!this.budgetReached(loopId)) return false
    const loop = this.ledger.getLoop(loopId)
    if (!loop?.budgetUsd) return false
    this.finishLoop(loopId, 'stopped', `Budget ceiling hit: $${loop.totalCostUsd.toFixed(2)} of $${loop.budgetUsd.toFixed(2)} (equivalent API cost).`)
    return true
  }

  private budgetReached(loopId: string, pendingCostUsd = 0): boolean {
    const loop = this.ledger.getLoop(loopId)
    return !!loop?.budgetUsd && loop.totalCostUsd + Math.max(0, pendingCostUsd) >= loop.budgetUsd
  }

}
