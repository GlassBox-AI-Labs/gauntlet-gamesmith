import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AccountRotation, HarnessKind, ProbeResult } from '../shared/harness'
import type {
  BuildLogLine,
  BuildModels,
  BuildRecord,
  BuildSnapshot,
  PhaseAttempt,
  PhaseRole,
  StartBuildInput,
  StartBuildResult,
  Verdict,
} from '../shared/build'
import { channelForKind, markResumePrompt, attemptPromptLabel } from '../shared/build'
import { IPC } from '../shared/ipc'
import { describeModels, harnessFor, isUltracode, resolveModels } from '../shared/models'
import { buildCriticPrompt, buildReferencePrompt, composeImplementPrompt, effectivePromptForAttempt } from '../shared/prompts'
import { redactLogText, redactedErrorMessage } from '../shared/redact-log'
import { referencePackDir, referenceRootForBuild } from '../shared/reference-path'
import {
  assertChildStreamBoundary,
  CHILD_STARTUP_GRACE_MS,
  childStreamFailures,
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
import { defaultBuildTitle, type Ledger, type AttemptProcessOwnership } from './ledger'
import { createNewBuildWorkspace } from './new-build-workspace'
import { publishOwnedWorkspaceFile, publishOwnedWorkspaceSnapshot, writeWorkspaceFileSafely } from './owned-workspace-write'
import type { PreparedContext } from './build-attachments'
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
import { planCompletion, planResume, planStart } from './round-planner'
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
  type AttemptProcessMeta,
} from './attempt-process'
import { commitRunningAttempt } from './attempt-transition'
import { ChildStreamTailer } from './streams/child-tailer'
import { prepareVerdictArtifact } from './verdict'
import { assertWorkspaceBoundary, captureWorkspaceIdentity } from './workspace-boundary'
import { boundedBuildSnapshot } from './ipc-projection'

/**
 * How long a build may make no progress before we call it stuck. This is idle
 * time, not total runtime: a fan-out that works for four hours is healthy, and
 * killing it at a fixed wall-clock limit threw away 2h15m of finished agent
 * work mid final-verification. A hard ceiling still backstops a wedged process.
 */
const IMPLEMENT_IDLE_MS = 40 * 60_000
const IMPLEMENT_HARD_CAP_MS = 12 * 60 * 60_000
const CRITIQUE_TIMEOUT_MS = 60 * 60_000
const REFERENCE_TIMEOUT_MS = 60 * 60_000
/** No observable worker startup or post-terminal write for this long settles its stream. */
const CHILD_QUIET_MS = CHILD_STARTUP_GRACE_MS
const MAX_CRITIQUE_ATTEMPTS = 2
const MAX_REFERENCE_ATTEMPTS = 2
const MAX_ACCOUNT_ROTATIONS = 3
const MAX_LIMIT_WAIT_MS = 6 * 60 * 60 * 1_000
const MAX_STREAM_READ_BYTES = 1024 * 1024
const MAX_PARTIAL_LINE_CHARS = 256 * 1024
const UNTRUSTED_HISTORY_MESSAGE = 'Untrusted history (imported or created before trust provenance shipped) is read-only; start a new trusted build in this workspace.'
const UNSAFE_WORKSPACE_MESSAGE = 'Workspace safety check failed: the path overlaps private app data or CLI credential homes. Start a new trusted build in a separate project folder.'
const UNKNOWN_LAUNCH_OWNERSHIP = 'Launch identity was not durably recorded before the app exited.'

function requireWorkspaceIdentity(build: Pick<BuildRecord, 'workspaceIdentity'>): { dev: number; ino: number } {
  if (!build.workspaceIdentity) throw new Error('Workspace identity is unavailable; app-owned publication is blocked.')
  return build.workspaceIdentity
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
export interface BuildRunnerDeps {
  now(): number
  wait(ms: number): Promise<void>
  defer(work: () => void, ms: number): NodeJS.Timeout
  cancelDeferred(timer: NodeJS.Timeout): void
  repeat(work: () => void, ms: number): NodeJS.Timeout
  cancelRepeat(timer: NodeJS.Timeout): void
  spawnChild(command: string, args: string[], options: DetachedSpawnOptions): ReturnType<typeof spawn>
  completeProcessMeta(
    workspaceDir: string,
    attemptId: string,
    marker: ReturnType<typeof prepareProcessMeta>,
    pid: number,
    streams: ProcessStreamIdentity,
    groupIdentities: readonly string[],
  ): AttemptProcessMeta
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
  prepareContext?(ids: string[]): PreparedContext | null
  rotateAccount?(kind: HarnessKind, error: string): Promise<AccountRotation>
}

const DEFAULT_DEPS: BuildRunnerDeps = {
  now: () => Date.now(),
  wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  defer: (work, ms) => setTimeout(work, ms),
  cancelDeferred: (timer) => clearTimeout(timer),
  repeat: (work, ms) => setInterval(work, ms),
  cancelRepeat: (timer) => clearInterval(timer),
  spawnChild: (command, args, options) => spawn(command, args, options),
  completeProcessMeta: (workspaceDir, attemptId, marker, pid, streams, groupIdentities) => completeProcessMeta(
    workspaceDir,
    attemptId,
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
  models: BuildModels,
  userPrompt: string,
  round: number,
  verdict: Verdict | null,
  referenceDir: string,
  wanted: CastEntry[] = [],
): string {
  const rules = [delegationRules(models, referenceDir), wanted.length > 0 ? sculptorRules(models, referenceDir) : '']
    .filter(Boolean)
    .join(' ')
  return composeImplementPrompt(userPrompt, round, verdict, rules, referenceDir, engineContract(), wanted, models.referenceMode)
}

interface ExitHolder {
  exited: boolean
  code: number | null
  spawnError: string | null
}

interface Attachment {
  buildId: string
  attemptId: string
  meta: AttemptProcessMeta
  timedOut: boolean
}

export class BuildRunner {
  private current: Attachment | null = null
  private stopRequested = new Set<string>()
  private retryTimers = new Map<string, NodeJS.Timeout>()
  /** Account changes spent per build, bounded independently of retry pauses. */
  private rotations = new Map<string, number>()
  /** Newly spawned groups whose durable identity write failed remain owned until exit/escalation. */
  private terminatingBuilds = new Set<string>()
  /** A build has at most one bounded signal escalation chain. */
  private interruptingAttempts = new Set<string>()
  /** Child streams of the build being driven; also pumped while awaiting stragglers. */
  private childTail: { buildId: string; attemptId: string; boundary: ChildStreamBoundary; tailer: ChildStreamTailer } | null = null
  /** IPC notifications queued until their enclosing ledger transaction commits. */
  private logNotificationBuffer: BuildLogLine[] | null = null
  /** Renderer/report refreshes requested during a transaction build only after commit. */
  private broadcastBuffer: Set<string> | null = null
  private deps: BuildRunnerDeps

  constructor(
    private ledger: Ledger,
    private send: (channel: string, payload: unknown) => void,
    deps: Partial<BuildRunnerDeps> | ((kind: HarnessKind, error: string) => Promise<AccountRotation>) = {},
  ) {
    this.deps = typeof deps === 'function'
      ? { ...DEFAULT_DEPS, rotateAccount: deps }
      : { ...DEFAULT_DEPS, ...deps }
  }

  private nowIso(): string {
    return new Date(this.deps.now()).toISOString()
  }

  snapshot(): BuildSnapshot | null {
    const build = this.ledger.runningBuild() ?? this.ledger.latestBuild()
    if (!build) return null
    const totalAttempts = this.ledger.attemptCount(build.id)
    const projection = this.ledger.recentAttemptProjectionForBuild(build.id, 200)
    return boundedBuildSnapshot({
      build,
      attempts: projection.attempts,
      totalAttempts,
      hasMoreAttempts: totalAttempts > projection.attempts.length,
      detailTruncated: projection.truncatedFields,
      aggregate: this.ledger.attemptAggregate(build.id),
    })
  }

  /** New builds own a scoped pack; pre-v1 builds keep using their legacy root. */
  private referenceDir(buildId: string): string {
    if (this.ledger.getBuild(buildId)?.models.referenceMode === 'skip') return referencePackDir(buildId)
    return referenceRootForBuild(
      buildId,
      this.ledger.hasAttemptRole(buildId, 'reference'),
    )
  }

  private referenceFingerprint(buildId: string): string | null {
    const referenceId = this.ledger.firstSucceededAttemptIdForRole(buildId, 'reference')
    if (!referenceId) return null
    const prefix = 'Reference Pack frozen at sha256:'
    const text = this.ledger.eventTextForAttemptWithPrefix(referenceId, prefix)
    return text?.slice(prefix.length).trim() ?? null
  }

  /** Fail closed when a later phase sees a changed frozen Reference Pack. */
  private verifyReferenceBoundary(build: BuildRecord, attempt: PhaseAttempt, terminalLog?: { kind: string; text: string }): boolean {
    if (!this.verifySuppliedContext(build, attempt, terminalLog)) return false
    if (build.models.referenceMode === 'skip') return true
    const pack = scanReferencePack(build.workspaceDir, this.referenceDir(build.id), build)
    if (!pack.ready) {
      const message = pack.issues.join('; ')
      this.failAttemptAndBuild(
        build,
        attempt,
        `Reference Pack is not ready: ${message}`,
        `Frozen Reference Pack failed its phase-boundary scan before ${attempt.role}: ${message}`,
        terminalLog,
      )
      return false
    }
    let actual: string
    try {
      actual = referencePackFingerprint(build.workspaceDir, this.referenceDir(build.id))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.failAttemptAndBuild(
        build,
        attempt,
        `Reference Pack verification failed: ${message}`,
        `Frozen Reference Pack could not be verified before ${attempt.role}: ${message}`,
        terminalLog,
      )
      return false
    }
    const expected = this.referenceFingerprint(build.id)
    if (!expected) {
      // Compatibility for builds created before pack fingerprints: bind once at
      // the first safe phase seam, then enforce it for every later attempt.
      const referenceId = this.ledger.firstSucceededAttemptIdForRole(build.id, 'reference')
      this.log(build.id, referenceId, 'artifact', `Reference Pack frozen at sha256:${actual}`)
      return true
    }
    if (actual === expected) return true
    this.log(build.id, attempt.id, 'error', `Phase boundary rejected: Reference Pack changed (expected ${expected}, found ${actual}).`)
    this.failAttemptAndBuild(
      build,
      attempt,
      'Frozen Reference Pack changed before phase execution.',
      `Frozen Reference Pack changed before round ${attempt.round} ${attempt.role}.`,
      terminalLog,
    )
    return false
  }

  /** Bind the research phase to the source tree that existed before it ran. */
  private verifySuppliedContext(build: BuildRecord, attempt: PhaseAttempt, terminalLog?: { kind: string; text: string }): boolean {
    const prefix = 'Supplied context frozen at sha256:'
    const expected = this.ledger.eventTextForBuildWithPrefix(build.id, prefix)?.slice(prefix.length)
    if (!expected) return true
    try {
      if (referencePackFingerprint(build.workspaceDir, `${this.referenceDir(build.id)}/supplied`) === expected) return true
    } catch { /* A missing or unsafe supplied tree fails closed as well. */ }
    this.failAttemptAndBuild(build, attempt, 'Supplied reference files changed.', 'Supplied reference files failed their immutable snapshot check.', terminalLog)
    return false
  }

  private ensureReferenceSourceBaseline(build: BuildRecord, attempt: PhaseAttempt, terminalLog?: { kind: string; text: string }): boolean {
    if (!this.verifySuppliedContext(build, attempt, terminalLog)) return false
    try {
      if (attempt.revision) {
        if (workspaceMatchesRevision(build.workspaceDir, build.id, attempt.revision)) return true
        throw new Error(`workspace no longer matches source baseline ${attempt.revision.slice(0, 12)}`)
      }
      const revision = captureRoundRevision({ workspaceDir: build.workspaceDir, buildId: build.id, round: 0 })
      this.ledger.patchAttempt(attempt.id, { revision })
      attempt.revision = revision
      this.log(build.id, attempt.id, 'artifact', `Reference source baseline frozen at revision ${revision}.`)
      return true
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.log(build.id, attempt.id, 'error', `Reference source boundary rejected: ${message}`)
      this.failAttemptAndBuild(
        build,
        attempt,
        `Reference source boundary rejected: ${message}`,
        `Reference Study could not prove that project source stayed unchanged: ${message}`,
        terminalLog,
      )
      return false
    }
  }

  private critiqueTreeBaseline(attemptId: string): string | null {
    const prefix = 'Critique evidence baseline frozen at sha256:'
    return this.ledger.eventsForAttempt(attemptId, 'artifact', 100).find((event) => event.text.startsWith(prefix))?.text.slice(prefix.length).trim() ?? null
  }

  private copyCritiqueTreeBaseline(sourceAttemptId: string, targetAttemptId: string): void {
    const baseline = this.critiqueTreeBaseline(sourceAttemptId)
    if (baseline) this.log(this.ledger.getAttempt(targetAttemptId)!.buildId, targetAttemptId, 'artifact', `Critique evidence baseline frozen at sha256:${baseline}`)
  }

  /** Implementers may read prior critique but cannot forge or replace it. */
  private verifyCritiqueTreeBoundary(build: BuildRecord, attempt: PhaseAttempt, bind: boolean, terminalLog?: { kind: string; text: string }): boolean {
    try {
      const actual = phaseTreeFingerprint(build.workspaceDir, 'critique')
      const expected = this.critiqueTreeBaseline(attempt.id)
      if (!expected && bind) {
        this.log(build.id, attempt.id, 'artifact', `Critique evidence baseline frozen at sha256:${actual}`)
        return true
      }
      if (expected === actual) return true
      throw new Error(expected ? `expected ${expected}, found ${actual}` : 'no pre-launch baseline was recorded')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.log(build.id, attempt.id, 'error', `Critique evidence boundary rejected: ${message}`)
      this.failAttemptAndBuild(
        build,
        attempt,
        `Critique evidence boundary rejected: ${message}`,
        `Round ${attempt.round} implement could not prove critique evidence stayed unchanged: ${message}`,
        terminalLog,
      )
      return false
    }
  }

  private scheduleRetry(buildId: string, retryAtMs: number): void {
    if (this.retryTimers.has(buildId)) return
    const delay = Math.max(0, retryAtMs - this.deps.now())
    const timer = this.deps.defer(() => {
      this.retryTimers.delete(buildId)
      void this.executeNext(buildId)
    }, delay)
    timer.unref()
    this.retryTimers.set(buildId, timer)
  }

  private queuedRetryAt(buildId: string): number | null {
    const latest = this.ledger.latestInterruptedAttemptForBuild(buildId)
    return retryAtFromError(latest?.error ?? null)
  }

  /** Try another configured subscription profile before falling back to a pause. */
  private async rotateForUsageLimit(
    build: BuildRecord,
    attempt: PhaseAttempt,
    error: string,
  ): Promise<{ rotated: boolean; waitMs?: number; message?: string | null }> {
    if (!isRateLimitError(error) || !this.deps.rotateAccount) return { rotated: false, message: null }
    const used = this.rotations.get(build.id) ?? 0
    if (used >= MAX_ACCOUNT_ROTATIONS) {
      return {
        rotated: false,
        message: `Stopped after changing accounts ${MAX_ACCOUNT_ROTATIONS} time(s); reconnect an account on the Agents tab, then Resume.`,
      }
    }
    const outcome = await this.deps.rotateAccount(attempt.harness, error)
    if (outcome.ok) {
      this.rotations.set(build.id, used + 1)
      this.log(build.id, attempt.id, 'system', `Usage window exhausted on ${outcome.from}; continuing with ${outcome.to ?? 'the next account'}.`)
      return { rotated: true }
    }
    const waitMs = outcome.resetAt == null ? null : outcome.resetAt - this.deps.now()
    if (waitMs != null && waitMs > 0 && waitMs <= MAX_LIMIT_WAIT_MS) {
      this.log(build.id, attempt.id, 'system', `Every usable account is cooling down; retrying when the first window reopens in ${Math.ceil(waitMs / 60_000)}m.`)
      return { rotated: true, waitMs }
    }
    return {
      rotated: false,
      message: `${outcome.from} is rate limited and ${outcome.reason ?? 'no other account can take over'}. Connect or refresh an account on the Agents tab, then Resume.`,
    }
  }

  /** Persist a failed phase and build, charging a running attempt once. */
  private failAttemptAndBuild(build: BuildRecord, attempt: PhaseAttempt, error: string, reason: string, terminalLog?: { kind: string; text: string }): boolean {
    let applied = commitRunningAttempt(this.ledger, build.id, attempt.id, {
      status: 'failed',
      error,
      finishedAt: this.nowIso(),
    }, () => {
      if (terminalLog) this.persistLog(build.id, attempt.id, terminalLog.kind, terminalLog.text)
      this.persistBuildTerminal(build.id, 'failed', reason)
    })
    if (!applied && this.ledger.getAttempt(attempt.id)?.status === 'queued') {
      this.ledger.transaction(() => {
        if (this.ledger.getAttempt(attempt.id)?.status !== 'queued') return
        this.ledger.patchAttempt(attempt.id, { status: 'failed', error, finishedAt: this.nowIso() })
        if (terminalLog) this.persistLog(build.id, attempt.id, terminalLog.kind, terminalLog.text)
        this.persistBuildTerminal(build.id, 'failed', reason)
        applied = true
      })
    }
    if (applied) {
      if (terminalLog) this.notifyPersistedLog(build.id, attempt.id, terminalLog.kind, terminalLog.text)
      this.finishBuild(build.id, 'failed', reason)
    }
    return applied
  }

  private async retryRateLimit(build: BuildRecord, attempt: PhaseAttempt, error: string, terminalLog?: { kind: string; text: string }): Promise<boolean> {
    const priorPauses = this.ledger.rateLimitPauseCount(build.id, attempt.role, attempt.round)
    if (!isRateLimitError(error)) return false
    const rotation = await this.rotateForUsageLimit(build, attempt, error)
    if (priorPauses >= MAX_RATE_LIMIT_PAUSES) {
      const reason = `${attempt.role} remains rate limited after ${MAX_RATE_LIMIT_PAUSES} automatic pauses; Resume later to retry without losing phase progress.`
      const applied = commitRunningAttempt(this.ledger, build.id, attempt.id, {
        status: 'interrupted',
        error: `Automatic rate-limit pause budget reached after ${MAX_RATE_LIMIT_PAUSES} pauses. ${error}`,
      }, () => {
        if (terminalLog) this.persistLog(build.id, attempt.id, terminalLog.kind, terminalLog.text)
        this.persistBuildTerminal(build.id, 'stopped', reason)
      })
      if (applied) {
        if (terminalLog) this.notifyPersistedLog(build.id, attempt.id, terminalLog.kind, terminalLog.text)
        this.finishBuild(build.id, 'stopped', reason)
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
    if (this.budgetReached(build.id, this.ledger.getAttempt(attempt.id)?.costUsd ?? 0)) {
      const latest = this.ledger.getBuild(build.id)
      const reason = latest?.budgetUsd
        ? `Budget ceiling hit: $${latest.totalCostUsd.toFixed(2)} of $${latest.budgetUsd.toFixed(2)} (equivalent API cost).`
        : 'Equivalent API cost budget reached.'
      const applied = commitRunningAttempt(this.ledger, build.id, attempt.id, {
        status: 'interrupted',
        error: `Rate limited; retry skipped because the equivalent API cost budget was reached. ${error}`,
      }, () => {
        if (terminalLog) this.persistLog(build.id, attempt.id, terminalLog.kind, terminalLog.text)
        this.persistBuildTerminal(build.id, 'stopped', reason)
      })
      if (applied) {
        if (terminalLog) this.notifyPersistedLog(build.id, attempt.id, terminalLog.kind, terminalLog.text)
        this.finishBuild(build.id, 'stopped', reason)
      }
      return true
    }
    const retryAt = new Date(pause.retryAtMs).toISOString()
    let queuedId: string | null = null
    const applied = commitRunningAttempt(this.ledger, build.id, attempt.id, {
      status: 'interrupted',
      error: `Rate limited; retry scheduled for ${retryAt}. ${error}`,
    }, () => {
      if (terminalLog) this.persistLog(build.id, attempt.id, terminalLog.kind, terminalLog.text)
      const queued = this.ledger.createAttempt({
        buildId: build.id,
        round: attempt.round,
        role: attempt.role,
        harness: harnessFor(attempt.role === 'critique' ? build.models.criticModel : build.models.orchestratorModel),
        prompt:
          attempt.role === 'implement' ? markResumePrompt(attempt.prompt) : attempt.prompt,
      })
      queuedId = queued.id
      if (attempt.revision) this.ledger.patchAttempt(queued.id, { revision: attempt.revision })
    })
    if (!applied) return true
    if (terminalLog) this.notifyPersistedLog(build.id, attempt.id, terminalLog.kind, terminalLog.text)
    if (attempt.role === 'implement' && queuedId) this.copyCritiqueTreeBaseline(attempt.id, queuedId)
    this.log(build.id, attempt.id, 'system', `Rate limit is a retryable pause — next ${attempt.role} attempt at ${retryAt} (backoff ${Math.ceil(pause.delayMs / 1_000)}s).`)
    this.broadcast(build.id)
    this.scheduleRetry(build.id, pause.retryAtMs)
    return true
  }

  /**
   * A retry that is handed the same brief as the attempt that just failed can
   * only repeat it: the previous attempt audited its own work, found it sound,
   * and died on a gate it was never told about. Lead the retry with the reason.
   */
  private static retryPromptFor(prompt: string, error: string): string {
    return `The previous attempt at this phase FAILED and was rejected for exactly this reason:\n\n${error.slice(0, 4_000)}\n\nThis is the retry. Fix that specific rejection before anything else, keep every other valid artifact the previous attempt produced, and do not finish until the stated reason no longer applies.\n\n${prompt}`
  }

  /** One same-phase retry protocol for artifact phases; rate pauses do not consume attempts. */
  private async failOrRetryPhase(build: BuildRecord, attempt: PhaseAttempt, error: string, label: string, maxAttempts: number, prompt: string, terminalLog?: { kind: string; text: string }): Promise<void> {
    if (await this.retryRateLimit(build, attempt, error, terminalLog)) return
    const attempts = this.ledger.failedAttemptCount(build.id, attempt.role, attempt.round) + 1
    if (this.budgetReached(build.id, this.ledger.getAttempt(attempt.id)?.costUsd ?? 0)) {
      const latest = this.ledger.getBuild(build.id)
      const reason = latest?.budgetUsd
        ? `Budget ceiling hit: $${latest.totalCostUsd.toFixed(2)} of $${latest.budgetUsd.toFixed(2)} (equivalent API cost).`
        : 'Equivalent API cost budget reached.'
      const applied = commitRunningAttempt(this.ledger, build.id, attempt.id, { status: 'failed', error }, () => {
        if (terminalLog) this.persistLog(build.id, attempt.id, terminalLog.kind, terminalLog.text)
        this.persistBuildTerminal(build.id, 'stopped', reason)
      })
      if (applied) {
        if (terminalLog) this.notifyPersistedLog(build.id, attempt.id, terminalLog.kind, terminalLog.text)
        this.finishBuild(build.id, 'stopped', reason)
      }
      return
    }
    if (attempts >= maxAttempts) {
      this.failAttemptAndBuild(build, attempt, error, `${label} failed after ${maxAttempts} attempts: ${error}`, terminalLog)
      return
    }
    this.log(build.id, attempt.id, 'system', `${label} failed (${error}) — retrying without discarding valid phase artifacts.`)
    let retryId: string | null = null
    const applied = commitRunningAttempt(this.ledger, build.id, attempt.id, { status: 'failed', error }, () => {
      if (terminalLog) this.persistLog(build.id, attempt.id, terminalLog.kind, terminalLog.text)
      const retry = this.ledger.createAttempt({
        buildId: build.id,
        round: attempt.round,
        role: attempt.role,
        harness: harnessFor(attempt.role === 'critique' ? build.models.criticModel : build.models.orchestratorModel),
        prompt: BuildRunner.retryPromptFor(prompt, error),
      })
      retryId = retry.id
      if (attempt.revision) this.ledger.patchAttempt(retry.id, { revision: attempt.revision })
    })
    if (!applied) return
    if (terminalLog) this.notifyPersistedLog(build.id, attempt.id, terminalLog.kind, terminalLog.text)
    if (attempt.role === 'implement' && retryId) this.copyCritiqueTreeBaseline(attempt.id, retryId)
    this.broadcast(build.id)
    void this.executeNext(build.id)
  }

  /** Apply the identical user-stop/timeout terminal transition for every phase. */
  private finishCancelledAttempt(build: BuildRecord, attempt: PhaseAttempt, exit: ExitInfo, timeoutReason: string, terminalLog?: { kind: string; text: string }): boolean {
    const userStopped = this.stopRequested.has(build.id)
    if (!userStopped && !exit.timedOut) return false
    const attemptError = userStopped ? 'Stopped by user.' : 'Timed out.'
    const reason = userStopped ? 'Stopped by user.' : timeoutReason
    const applied = commitRunningAttempt(this.ledger, build.id, attempt.id, { status: 'cancelled', error: attemptError }, () => {
      if (terminalLog) this.persistLog(build.id, attempt.id, terminalLog.kind, terminalLog.text)
      this.persistBuildTerminal(build.id, 'stopped', reason)
    })
    if (applied) {
      if (terminalLog) this.notifyPersistedLog(build.id, attempt.id, terminalLog.kind, terminalLog.text)
      this.finishBuild(build.id, 'stopped', reason)
    }
    return true
  }

  /** Stop without retrying whenever the selected profile is not subscription-backed. */
  private stopForSubscription(build: BuildRecord, attempt: PhaseAttempt, harness: HarnessKind, readiness: SubscriptionReadiness): void {
    const reason = this.subscriptionBlockMessage(harness, readiness)
    let applied = false
    if (this.ledger.getAttempt(attempt.id)?.status === 'running') {
      applied = commitRunningAttempt(this.ledger, build.id, attempt.id, {
        status: 'interrupted',
        error: reason,
        finishedAt: this.nowIso(),
      }, () => {
        this.persistLog(build.id, attempt.id, 'error', reason)
        this.persistBuildTerminal(build.id, 'stopped', reason)
      })
    } else {
      this.atomicLogs(() => {
        if (this.ledger.getAttempt(attempt.id)?.status !== 'queued') return
        this.ledger.patchAttempt(attempt.id, { status: 'interrupted', error: reason, finishedAt: this.nowIso() })
        this.persistLog(build.id, attempt.id, 'error', reason)
        this.persistBuildTerminal(build.id, 'stopped', reason)
        applied = true
      })
    }
    if (!applied) return
    if (this.ledger.getAttempt(attempt.id)?.status === 'interrupted') this.notifyPersistedLog(build.id, attempt.id, 'error', reason)
    this.notifyPersistedLog(build.id, null, 'done', this.terminalMessage('stopped', reason))
    this.broadcast(build.id)
  }

  private quarantineRunningAttempt(build: BuildRecord, attempt: PhaseAttempt, reason: string): void {
    const applied = commitRunningAttempt(this.ledger, build.id, attempt.id, {
      status: 'interrupted',
      error: reason,
      finishedAt: this.nowIso(),
    }, () => {
      this.persistLog(build.id, attempt.id, 'error', reason)
      this.persistBuildTerminal(build.id, 'stopped', reason)
    })
    if (!applied) return
    this.notifyPersistedLog(build.id, attempt.id, 'error', reason)
    this.notifyPersistedLog(build.id, null, 'done', this.terminalMessage('stopped', reason))
    this.broadcast(build.id)
  }

  private requiredHarnesses(build: BuildRecord, role: PhaseRole, primary: HarnessKind): HarnessKind[] {
    const workerModels = role === 'implement'
      ? [build.models.subagentModel, build.models.assetModel]
      : role === 'reference'
        ? [build.models.researchModel]
        : []
    return [...new Set<HarnessKind>([
      primary,
      ...workerModels.filter((model): model is string => model != null).map(harnessFor),
    ])]
  }

  private subscriptionBlock(
    build: BuildRecord,
    role: PhaseRole,
    primary: HarnessKind,
  ): { harness: HarnessKind; readiness: SubscriptionReadiness } | null {
    for (const harness of this.requiredHarnesses(build, role, primary)) {
      const readiness = this.deps.subscriptionReady(harness, build.workspaceDir, this.deps.harnessHome(harness))
      if (!readiness.ok) return { harness, readiness }
    }
    return null
  }

  private subscriptionBlockForAttempt(build: BuildRecord, attempt: PhaseAttempt): { harness: HarnessKind; readiness: SubscriptionReadiness } | null {
    return this.subscriptionBlock(build, attempt.role, attempt.harness)
  }

  private executableRoots(build: BuildRecord): string[] {
    return [build.workspaceDir, ...this.deps.protectedRoots()]
  }

  /** Resolve and pin every CLI this phase may execute, including workers. */
  private executableEnvironment(build: BuildRecord, attempt: PhaseAttempt, planEnv: Record<string, string>): { command: string; env: Record<string, string> } {
    const roots = this.executableRoots(build)
    const executables = new Map(
      this.requiredHarnesses(build, attempt.role, attempt.harness).map((harness) => [harness, this.deps.cliExecutable(harness, roots)]),
    )
    const env = {
      ...subscriptionEnv(planEnv, process.env, attempt.harness, roots),
      ...this.deps.validatedExecutableEnv(executables, roots),
    }
    return {
      command: executables.get(attempt.harness)!,
      env,
    }
  }

  private processMetaFromOwnership(build: BuildRecord, attempt: PhaseAttempt, ownership: AttemptProcessOwnership): AttemptProcessMeta {
    const projection = attempt.metrics?.projection
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
      ...processStreamPaths(build.workspaceDir, attempt.id),
      loggedOutLines: projection?.loggedOutLines ?? 0,
      loggedErrLines: projection?.loggedErrLines ?? 0,
      childOffsets: projection?.childOffsets ?? {},
      childIdentities: projection?.childIdentities ?? {},
      workflowOffsets: projection?.workflowOffsets ?? {},
      workflowIdentities: projection?.workflowIdentities ?? {},
    }
  }

  /** A canonical owner blocks all new launches until its whole group is gone. */
  private retainedProcessOwnership(): { build: BuildRecord; attempt: PhaseAttempt; meta: AttemptProcessMeta } | null {
    const retained = this.ledger.attemptsWithProcessOwnership()[0]
    if (!retained) return null
    const build = this.ledger.getBuild(retained.attempt.buildId)
    if (!build) throw new Error('Retained process ownership references a missing attempt.')
    // This is a control-only view: path derivation is side-effect free, so a
    // removed/replaced workspace can still be quarantined and its canonical
    // process group interrupted without touching that filesystem surface.
    const meta = this.processMetaFromOwnership(build, retained.attempt, retained.ownership)
    let groupPresent = processMatches(meta)
    try {
      groupPresent ||= this.deps.processGroupStillOwned(meta.pid, retained.ownership.groupIdentities)
    } catch {
      groupPresent = true
    }
    // A running attempt still needs its canonical ownership row to drain and
    // finalize streams after a leader exited while the app was down. Recovery,
    // not this launch guard, decides that transition.
    if (groupPresent || retained.attempt.status === 'running') return { build, attempt: retained.attempt, meta }
    this.ledger.clearAttemptProcessOwnership(retained.attempt.id)
    return null
  }

  private retainedOwnershipMessage(owner: { build: BuildRecord; attempt: PhaseAttempt; meta: AttemptProcessMeta }): string {
    return `A previously launched ${owner.attempt.role} process group (${owner.meta.pid}) is still owned for workspace ${owner.build.workspaceDir}; wait for it to exit before starting or resuming work.`
  }

  private quarantinedUnknownLaunch(workspaceDir: string): boolean {
    return this.ledger.hasAttemptErrorPrefixForWorkspace(workspaceDir, UNKNOWN_LAUNCH_OWNERSHIP)
  }

  private subscriptionBlockMessage(harness: HarnessKind, readiness: SubscriptionReadiness): string {
    return `Subscription readiness blocked ${harness}: ${redactedErrorMessage(readiness.error, 'The selected CLI profile is not ready for subscription execution.')}`
  }

  /** Revalidate the canonical project root at every privileged phase seam. */
  private verifyWorkspaceBoundary(build: BuildRecord): boolean {
    try {
      this.ledger.assertBuildWorkspaceIdentity(build.id)
      return true
    } catch {
      // This Ledger operation updates canonical state atomically and
      // intentionally does not mirror into the now-untrusted workspace.
      if (this.ledger.quarantineUnsafeWorkspace(build.id, UNSAFE_WORKSPACE_MESSAGE)) {
        this.notifyWorkspaceQuarantine(build.id)
      }
      return false
    }
  }

  /** Project the canonical quarantine without regenerating a workspace report. */
  private notifyWorkspaceQuarantine(buildId: string): void {
    const event = [...this.ledger.eventsForBuild(buildId, 20)].reverse().find((line) => line.kind === 'workspace-boundary')
    if (event) this.notifyLog(event)
    const build = this.ledger.getBuild(buildId)
    if (!build) return
    const projection = this.ledger.recentAttemptProjectionForBuild(buildId, 200)
    try {
      this.send(IPC.build.update, boundedBuildSnapshot({
        build,
        attempts: projection.attempts,
        totalAttempts: this.ledger.attemptCount(buildId),
        detailTruncated: projection.truncatedFields,
        aggregate: this.ledger.attemptAggregate(buildId),
      }))
    } catch {
      /* canonical quarantine remains visible after renderer reconnect */
    }
  }

  start(input: StartBuildInput, workspaceMode: 'exact' | 'new-child' = 'exact'): StartBuildResult {
    if (this.current) return { ok: false, error: 'A build is already running. Stop it first.' }
    try {
      const owner = this.retainedProcessOwnership()
      if (owner) return { ok: false, error: this.retainedOwnershipMessage(owner) }
    } catch (error) {
      return { ok: false, error: redactedErrorMessage(error, 'Retained process ownership could not be verified.') }
    }
    if (this.terminatingBuilds.size > 0 || this.ledger.runningBuild()) return { ok: false, error: 'A build is already running. Stop it first.' }
    const prompt = input.prompt
    if (!prompt.trim()) return { ok: false, error: 'Prompt is empty.' }
    if (prompt.length > 100_000) return { ok: false, error: 'Prompt must be at most 100000 characters.' }
    if (redactLogText(prompt) !== prompt) {
      return { ok: false, error: 'Prompt contains credential-shaped material. Remove credentials or secrets before starting the build.' }
    }
    const requestedWorkspace = input.workspaceDir.trim()
    if (!requestedWorkspace || !path.isAbsolute(requestedWorkspace)) return { ok: false, error: 'Workspace must be an absolute path.' }
    const maxRounds = Math.max(1, Math.min(100, Math.floor(input.maxRounds) || 10))
    const budgetUsd = input.budgetUsd && input.budgetUsd > 0 ? input.budgetUsd : null
    let context: PreparedContext | null = null
    try {
      if (input.attachmentIds?.length) {
        if (!this.deps.prepareContext) throw new Error('Attachment storage is unavailable.')
        context = this.deps.prepareContext(input.attachmentIds)
      }
    } catch (error) { return { ok: false, error: redactedErrorMessage(error, 'Could not prepare attachments.') } }
    let workspaceDir: string
    let scaffold: ReturnType<typeof scaffoldEngine>
    try {
      const captured = workspaceMode === 'new-child'
        ? createNewBuildWorkspace(requestedWorkspace, defaultBuildTitle(prompt), this.deps.protectedRoots())
        : (() => {
            const exact = assertWorkspaceBoundary(requestedWorkspace, this.deps.protectedRoots())
            fs.mkdirSync(exact, { recursive: true })
            return captureWorkspaceIdentity(exact, this.deps.protectedRoots())
          })()
      workspaceDir = captured.workspaceDir
      scaffold = scaffoldEngine(workspaceDir, captured.workspaceIdentity)
    } catch (error) {
      return { ok: false, error: `Cannot use workspace: ${redactedErrorMessage(error, 'The selected path is unsafe.')}` }
    }
    if (this.quarantinedUnknownLaunch(workspaceDir)) {
      return { ok: false, error: `${UNKNOWN_LAUNCH_OWNERSHIP} This workspace is quarantined against another editor launch because process exit was never observed.` }
    }

    const models = resolveModels(input, input, input, input)
    if (models.referenceMode === 'files' && !context) return { ok: false, error: 'Files-only Reference Study requires attachments.' }
    const initialPhase = planStart(models.referenceMode)
    let build: BuildRecord
    try {
      build = this.atomicLogs(() => {
        const created = this.ledger.createBuild({ prompt, workspaceDir, maxRounds, budgetUsd, models })
        this.log(created.id, null, 'system', `Build started — workspace ${workspaceDir}, max ${maxRounds} rounds${budgetUsd ? `, budget $${budgetUsd}` : ''}.`)
        this.log(created.id, null, 'system', scaffold.created.length
          ? `Engine scaffolded — ${scaffold.created.join(', ')}.`
          : 'Engine contract refreshed; workspace already scaffolded.')
        this.log(created.id, null, 'system', describeModels(models))
        const referenceDir = referencePackDir(created.id)
        if (context) {
          const supplied = context.publish(workspaceDir, referenceDir)
          this.log(created.id, null, 'artifact', `Supplied context frozen at sha256:${supplied.fingerprint}`)
          this.log(created.id, null, 'artifact', `Copied ${supplied.files} supplied reference files (${supplied.bytes} bytes) to ${referenceDir}/supplied/manifest.json.`)
          for (const file of supplied.paths) this.log(created.id, null, 'artifact', `Supplied reference file: ${file}`)
        }
        this.ledger.createAttempt({
          buildId: created.id,
          round: initialPhase.round,
          role: initialPhase.role,
          harness: harnessFor(models.orchestratorModel),
          prompt: initialPhase.role === 'reference' ? buildReferencePrompt(prompt, referenceDir, researchRules(models, referenceDir), models.referenceMode) : buildImplementPrompt(models, prompt, 1, null, referenceDir),
        })
        if (initialPhase.role === 'implement') this.ledger.patchBuild(created.id, { round: 1 })
        this.log(created.id, null, 'system', models.referenceMode === 'skip' ? 'Reference Study skipped by operator; no reference agent is queued.' : models.referenceMode === 'files' ? 'Reference Study uses supplied files only; web research and research fan-out are disabled.' : 'Reference Study uses web research and supplied files.')
        return created
      })
    } catch (error) {
      return { ok: false, error: `Could not start build: ${redactedErrorMessage(error, 'History could not be created.')}` }
    }
    this.broadcast(build.id)
    void this.executeNext(build.id)
    return { ok: true, buildId: build.id }
  }

  /**
   * Boot-time recovery. Detached agents survive app restarts: if the build's
   * process is still alive we re-attach to its output file (no interruption);
   * if it finished while the app was down we drain and finalize it; only when
   * no process metadata exists do we requeue a fresh attempt.
   */
  recoverAll(): void {
    try {
      const owner = this.retainedProcessOwnership()
      if (owner && owner.attempt.status !== 'running') {
        const workspaceSafe = this.verifyWorkspaceBoundary(owner.build)
        // Quit may have ended the direct leader while a captured descendant
        // remained. Resume the identity-bound SIGINT→SIGKILL supervision on
        // boot; never leave a billed stopped owner with no settlement path.
        this.interrupt(owner.meta, owner.build.id, owner.attempt.id)
        if (workspaceSafe) {
          this.log(owner.build.id, owner.attempt.id, 'error', this.retainedOwnershipMessage(owner))
          this.broadcast(owner.build.id)
        }
        if (this.ledger.attemptProcessOwnership(owner.attempt.id)) return
      }
    } catch (error) {
      // A corrupt or ambiguous canonical owner must fail closed before any
      // queued recovery can create a second detached editor.
      console.error('Cannot audit retained process ownership:', error)
      return
    }
    for (const build of this.ledger.runningBuilds()) {
      try {
      try {
        this.ledger.assertBuildWorkspaceIdentity(build.id)
      } catch {
        const active = this.ledger.activeAttemptForBuild(build.id)
        const ownership = active ? this.ledger.attemptProcessOwnership(active.id) : null
        if (active && ownership) {
          const meta = this.processMetaFromOwnership(build, active, ownership)
          this.interrupt(meta, build.id, active.id)
        }
        if (this.ledger.quarantineUnsafeWorkspace(build.id, UNSAFE_WORKSPACE_MESSAGE)) this.notifyWorkspaceQuarantine(build.id)
        continue
      }
      if (!build.playTrusted && !build.executionTrusted) {
        this.finishBuild(build.id, 'stopped', UNTRUSTED_HISTORY_MESSAGE)
        continue
      }
        const active = this.ledger.activeAttemptForBuild(build.id)
      if (active) {
        const ownership = this.ledger.attemptProcessOwnership(active.id)
        if (!ownership) {
          const reason = `${UNKNOWN_LAUNCH_OWNERSHIP} Canonical process ownership is missing, so recovery will not trust portable workspace metadata or launch a duplicate editor. Confirm any CLI process is stopped, then start a new trusted build.`
          this.quarantineRunningAttempt(build, active, reason)
          continue
        }
        if (active.role === 'assets') {
          const meta = this.processMetaFromOwnership(build, active, ownership)
          this.interrupt(meta, build.id, active.id)
          this.quarantineRunningAttempt(
            build,
            active,
            'Legacy standalone Asset Build was stopped during recovery; Resume hands its remaining cast to the implement phase.',
          )
          continue
        }
        const subscriptionBlock = this.subscriptionBlockForAttempt(build, active)
        if (subscriptionBlock) {
          if (!this.verifyWorkspaceBoundary(build)) continue
          const meta = this.processMetaFromOwnership(build, active, ownership)
          this.interrupt(meta, build.id, active.id)
          this.stopForSubscription(build, active, subscriptionBlock.harness, subscriptionBlock.readiness)
          continue
        }
        // Subscription probes execute external binaries and may take seconds.
        // Rebind the exact registered root before reading any recovery surface.
        if (!this.verifyWorkspaceBoundary(build)) continue
        const meta = this.processMetaFromOwnership(build, active, ownership)
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
            const reason = `App restart rejected unsafe ${active.role} canonical ownership — ${!startMatches ? 'recorded start does not match this attempt' : 'PID identity no longer belongs to this attempt'}. The retained owner must be verified absent before new work can start.`
            this.interruptCaptured(meta, ownership.groupIdentities, build.id, active.id)
            this.quarantineRunningAttempt(build, active, reason)
            continue
          }
          this.log(
            build.id,
            active.id,
            'system',
            alive
              ? `App restarted — re-attached to live ${active.role} (pid ${meta.pid}); agents were never interrupted.`
              : `App restarted — ${active.role} ended while the app was down; draining its output.`,
          )
          this.broadcast(build.id)
          const gate: LogGate = { suppress: false }
          const childBoundary = recoverChildStreams(build.workspaceDir, build)
          // Recovery must pick the reader the build was spawned with. Handing a
          // codex stream to the claude protocol built claude workflow paths for
          // an attempt that has none, and the throw failed the whole build — so a
          // codex implement build could never survive an app restart.
          const parser =
            active.role === 'reference'
              ? this.makeReferenceParser(build, active, gate, childBoundary)
              : active.role === 'implement'
                ? harnessFor(build.models.orchestratorModel) === 'claude'
                  ? this.makeImplementParser(build, active, gate, childBoundary, meta.workflowOffsets, meta.workflowIdentities)
                  : this.makeCodexImplementParser(build, active, gate, childBoundary)
                : this.makeCritiqueParser(build, active, gate)
          const idle = active.role === 'implement' ? IMPLEMENT_IDLE_MS : active.role === 'reference' ? REFERENCE_TIMEOUT_MS : CRITIQUE_TIMEOUT_MS
          const cap = active.role === 'implement' ? IMPLEMENT_HARD_CAP_MS : active.role === 'reference' ? REFERENCE_TIMEOUT_MS : CRITIQUE_TIMEOUT_MS
          const recoveredGroup = ownership.groupIdentities
          void this.driveAttempt(build, active, meta, idle, cap, parser, gate, null, recoveredGroup, childBoundary)
          continue
        }
      } else {
        const queued = this.ledger.oldestQueuedAttemptForBuild(build.id)
        if (!queued) {
          this.finishBuild(build.id, 'stopped', 'No pending work found after app restart.')
          continue
        }
        const subscriptionBlock = this.subscriptionBlockForAttempt(build, queued)
        if (subscriptionBlock) {
          this.stopForSubscription(build, queued, subscriptionBlock.harness, subscriptionBlock.readiness)
          continue
        }
      }
      this.broadcast(build.id)
      void this.executeNext(build.id)
      } catch (error) {
        try {
          this.quarantineRecoveryFailure(build, error)
        } catch (quarantineError) {
          // Preserve iteration: a canonical ownership row still blocks any
          // replacement launch even if its visibility transition also fails.
          console.error('Could not quarantine failed build recovery:', quarantineError)
        }
      }
    }
  }

  /** Isolate one broken recovery surface without abandoning later builds. */
  private quarantineRecoveryFailure(build: BuildRecord, error: unknown): void {
    const reason = `Recovery setup failed safely: ${redactedErrorMessage(error, 'Recovery state could not be validated.')}`
    const attempt = this.ledger.latestAttemptForBuild(build.id)
    if (attempt?.status === 'running') {
      const ownership = this.ledger.attemptProcessOwnership(attempt.id)
      if (ownership) {
        const meta = this.processMetaFromOwnership(build, attempt, ownership)
        this.interruptCaptured(meta, ownership.groupIdentities, build.id, attempt.id)
      }
      this.quarantineRunningAttempt(build, attempt, reason)
      return
    }
    if (attempt?.status === 'queued') {
      this.atomicLogs(() => {
        this.ledger.patchAttempt(attempt.id, { status: 'interrupted', error: reason, finishedAt: this.nowIso() })
        this.persistLog(build.id, attempt.id, 'error', reason)
        this.persistBuildTerminal(build.id, 'stopped', reason)
      })
      this.notifyPersistedLog(build.id, attempt.id, 'error', reason)
      this.notifyPersistedLog(build.id, null, 'done', this.terminalMessage('stopped', reason))
      this.broadcast(build.id)
      return
    }
    this.finishBuild(build.id, 'stopped', reason)
  }

  /** The attempt currently being supervised, if any. */
  activeAttempt(): { buildId: string; attemptId: string; pid: number; role: string } | null {
    if (this.current) {
      const attempt = this.ledger.getAttempt(this.current.attemptId)
      return { buildId: this.current.buildId, attemptId: this.current.attemptId, pid: this.current.meta.pid, role: attempt?.role ?? 'build' }
    }
    const retained = this.retainedProcessOwnership()
    return retained
      ? { buildId: retained.build.id, attemptId: retained.attempt.id, pid: retained.meta.pid, role: retained.attempt.role }
      : null
  }

  /** True while quitting would discard ownership-settlement supervision. */
  hasUnsettledOwnership(): boolean {
    return this.terminatingBuilds.size > 0 || this.ledger.attemptsWithProcessOwnership().length > 0
  }

  /**
   * Whether quit must wait regardless of the dialog's Keep-agents choice.
   * A normal current attempt may intentionally survive quit; a group already in
   * stop/recovery escalation may not lose its only settlement timers.
   */
  quitSettlementPending(): boolean {
    return this.terminatingBuilds.size > 0 || (!this.current && this.ledger.attemptsWithProcessOwnership().length > 0)
  }

  /**
   * Begin graceful shutdown: SIGINT the agent and mark the build stopped.
   * Callers that intend to exit the app must use stopForQuitAndWait below so
   * bounded escalation and verified group-absence checks remain alive.
   */
  stopForQuit(): void {
    if (!this.current) {
      const owner = this.retainedProcessOwnership()
      if (owner) {
        this.stopRequested.add(owner.build.id)
        const workspaceSafe = this.verifyWorkspaceBoundary(owner.build)
        this.interrupt(owner.meta, owner.build.id, owner.attempt.id)
        if (workspaceSafe && owner.attempt.status === 'running') {
          const reason = 'Stopped by user at quit.'
          try {
            const finishedAt = this.nowIso()
            this.ledger.cancelAttemptAndStopBuildCanonical(
              owner.build.id,
              owner.attempt.id,
              reason,
              finishedAt,
              Math.max(0, Math.floor(this.deps.now() - owner.meta.startedAtMs)),
            )
            this.notifyPersistedLog(owner.build.id, owner.attempt.id, 'process-control', reason)
          } catch (error) {
            if (this.ledger.quarantineUnsafeWorkspace(owner.build.id, UNSAFE_WORKSPACE_MESSAGE)) this.notifyWorkspaceQuarantine(owner.build.id)
            this.controlLog(owner.build.id, owner.attempt.id, 'error', `Quit state could not be committed after process interruption began: ${redactedErrorMessage(error, 'canonical process ownership remains active.')}`)
          }
        }
        return
      }
      const paused = this.ledger.runningBuild()
      if (paused) this.finishBuild(paused.id, 'stopped', 'Stopped by user at quit.')
      return
    }
    const { buildId, attemptId, meta } = this.current
    this.stopRequested.add(buildId)
    const build = this.ledger.getBuild(buildId)
    const workspaceSafe = build ? this.verifyWorkspaceBoundary(build) : false
    this.interrupt(meta, buildId, attemptId)
    if (!workspaceSafe) return
    const attempt = this.ledger.getAttempt(attemptId)
    const reason = 'Stopped by user at quit.'
    try {
      const finishedAt = this.nowIso()
      this.ledger.cancelAttemptAndStopBuildCanonical(
        buildId,
        attemptId,
        reason,
        finishedAt,
        Math.max(0, Math.floor(this.deps.now() - Date.parse(attempt?.startedAt ?? attempt?.createdAt ?? finishedAt))),
      )
      this.notifyPersistedLog(buildId, attemptId, 'process-control', reason)
    } catch (error) {
      if (this.ledger.quarantineUnsafeWorkspace(buildId, UNSAFE_WORKSPACE_MESSAGE)) this.notifyWorkspaceQuarantine(buildId)
      this.controlLog(buildId, attemptId, 'error', `Quit state could not be committed after process interruption began: ${redactedErrorMessage(error, 'canonical process ownership remains active.')}`)
    }
  }

  /**
   * Stop a build and keep the caller alive through bounded group settlement.
   * Electron's before-quit handler must await this result: `false` means the
   * identity-bound group is still present or could not be proven absent, so
   * quitting would discard the escalation timers and must be cancelled.
   */
  async stopForQuitAndWait(maxWaitMs = 20_000): Promise<boolean> {
    this.stopForQuit()
    const attempts = Math.max(1, Math.ceil(Math.min(Math.max(maxWaitMs, 0), 60_000) / 100))
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (this.ledger.attemptsWithProcessOwnership().length === 0) return true
      await this.deps.wait(100)
    }
    return this.ledger.attemptsWithProcessOwnership().length === 0
  }

  /** Earliest unfinished phase in one historical round (legacy Asset Build included). */
  private resumeTarget(buildId: string, round: number): PhaseAttempt | null {
    if (round < 1) return null
    const roundAttempts = this.ledger.attemptsForBuild(buildId).filter((attempt) => attempt.round === round)
    for (const role of ['assets', 'implement', 'critique'] as const) {
      const attempts = roundAttempts.filter((attempt) => attempt.role === role)
      if (attempts.length === 0) continue
      if (!attempts.some((attempt) => attempt.status === 'succeeded')) return attempts.at(-1) ?? null
    }
    return null
  }

  /** Revive a stopped build: requeue where it left off and keep going. */
  resumeBuild(buildId: string): StartBuildResult {
    const build = this.ledger.getBuild(buildId)
    if (!build) return { ok: false, error: 'Build not found.' }
    try {
      this.ledger.assertBuildWorkspaceIdentity(build.id)
    } catch {
      if (this.ledger.quarantineUnsafeWorkspace(build.id, UNSAFE_WORKSPACE_MESSAGE)) this.notifyWorkspaceQuarantine(build.id)
      return { ok: false, error: UNSAFE_WORKSPACE_MESSAGE }
    }
    if (this.ledger.hasAttemptErrorPrefixForWorkspace(build.workspaceDir, UNKNOWN_LAUNCH_OWNERSHIP)) {
      return { ok: false, error: `${UNKNOWN_LAUNCH_OWNERSHIP} Resume is disabled to avoid duplicating an untracked editor; start a new trusted build after confirming the old CLI is stopped.` }
    }
    if (!build.playTrusted && !build.executionTrusted) return { ok: false, error: UNTRUSTED_HISTORY_MESSAGE }
    if (build.status === 'running') return { ok: false, error: 'Build is already running.' }
    if (build.status === 'passed') return { ok: false, error: 'Build already passed — start a new build to keep improving.' }
    if (this.current || this.terminatingBuilds.size > 0 || this.ledger.runningBuild()) return { ok: false, error: 'Another build is running. Stop it first.' }
    try {
      const owner = this.retainedProcessOwnership()
      if (owner) return { ok: false, error: this.retainedOwnershipMessage(owner) }
    } catch (error) {
      return { ok: false, error: redactedErrorMessage(error, 'Retained process ownership could not be verified.') }
    }
    const last = this.ledger.latestAttemptForBuild(buildId)
    const plannedResume = planResume(last, build.maxRounds, build.models.referenceMode)
    // Imported queued attempts carry no local process/session authority. Start a fresh attempt.
    const resume = !build.playTrusted && plannedResume.kind === 'continue-queued'
      ? { ...plannedResume, kind: 'retry' as const }
      : plannedResume
    const resumeTarget: { role: PhaseRole; harness: HarnessKind } | null =
      resume.kind === 'continue-queued' || resume.kind === 'retry'
        ? { role: resume.attempt.role, harness: resume.attempt.harness }
        : resume.kind === 'queue-critique'
          ? { role: 'critique', harness: harnessFor(build.models.criticModel) }
          : resume.kind === 'finish-exhausted'
            ? null
            : { role: resume.kind === 'queue-reference' ? 'reference' : 'implement', harness: harnessFor(build.models.orchestratorModel) }
    if (resumeTarget) {
      const subscriptionBlock = this.subscriptionBlock(build, resumeTarget.role, resumeTarget.harness)
      if (subscriptionBlock) return { ok: false, error: this.subscriptionBlockMessage(subscriptionBlock.harness, subscriptionBlock.readiness) }
    }
    this.stopRequested.delete(buildId)
    let earlyResult: StartBuildResult | null = null
    this.atomicLogs(() => {
      this.ledger.patchBuild(buildId, { status: 'running', stopReason: null })
      if (resume.kind === 'continue-queued') {
        this.log(buildId, null, 'system', `Build resumed by user — continuing the already queued round ${resume.attempt.round} ${resume.attempt.role}.`)
      } else if (resume.kind === 'retry') {
        const prior = resume.attempt
        if (!build.playTrusted && prior.status === 'queued') {
          this.ledger.patchAttempt(prior.id, { status: 'interrupted', finishedAt: this.nowIso(), error: 'Explicit Resume replaced the imported queued attempt with a fresh local attempt.' })
        }
        const retry = this.ledger.createAttempt({
          buildId,
          round: prior.round,
          role: prior.role,
          harness: harnessFor(prior.role === 'critique' ? build.models.criticModel : build.models.orchestratorModel),
          prompt: prior.role === 'implement' ? markResumePrompt(prior.prompt) : prior.prompt,
        })
        if (prior.revision) this.ledger.patchAttempt(retry.id, { revision: prior.revision })
        if (prior.role === 'implement') this.copyCritiqueTreeBaseline(prior.id, retry.id)
        this.log(buildId, null, 'system', `Build resumed by user — retrying round ${prior.round} ${prior.role}.`)
      } else if (resume.kind === 'queue-implement') {
        this.ledger.patchBuild(buildId, { round: resume.round })
        this.ledger.createAttempt({
          buildId,
          round: resume.round,
          role: 'implement',
          harness: harnessFor(build.models.orchestratorModel),
          prompt: this.nextImplementPrompt(build, resume.round, resume.prior?.verdict ?? null),
        })
        this.log(buildId, null, 'system', resume.prior?.role === 'critique' ? `Build resumed by user — starting round ${resume.round}.` : 'Build resumed by user — Reference Pack ready; starting round 1.')
      } else if (resume.kind === 'queue-critique') {
        const prior = resume.prior
        const critique = this.ledger.createAttempt({
          buildId,
          round: resume.round,
          role: 'critique',
          harness: harnessFor(build.models.criticModel),
          prompt: buildCriticPrompt(build.prompt, resume.round, this.referenceDir(buildId), prior.revision ?? '<missing-revision>', 'verdict.json', '', build.models.referenceMode),
        })
        this.ledger.patchAttempt(critique.id, { revision: prior.revision })
        this.log(buildId, null, 'system', `Build resumed by user — judging round ${resume.round}.`)
      } else if (resume.kind === 'finish-exhausted') {
        const afterImplement = resume.prior.role === 'implement'
        const reason = afterImplement
          ? `Max rounds (${build.maxRounds}) reached after round ${resume.prior.round} — no critique, since no round is left for it to gate.`
          : `Max rounds (${build.maxRounds}) reached.`
        this.persistBuildTerminal(buildId, 'exhausted', reason)
        earlyResult = afterImplement ? { ok: true } : { ok: false, error: 'Max rounds already reached.' }
      } else {
        const referenceDir = referencePackDir(buildId)
        this.ledger.createAttempt({
          buildId,
          round: 0,
          role: 'reference',
          harness: harnessFor(build.models.orchestratorModel),
          prompt: buildReferencePrompt(build.prompt, referenceDir, researchRules(build.models, referenceDir), build.models.referenceMode),
        })
        this.log(buildId, null, 'system', 'Build resumed by user — starting Reference Study.')
      }
    })
    if (earlyResult) {
      if (resume.kind === 'finish-exhausted') {
        const reason = resume.prior.role === 'implement'
          ? `Max rounds (${build.maxRounds}) reached after round ${resume.prior.round} — no critique, since no round is left for it to gate.`
          : `Max rounds (${build.maxRounds}) reached.`
        this.notifyPersistedLog(buildId, null, 'done', this.terminalMessage('exhausted', reason))
      }
      this.broadcast(buildId)
      return earlyResult
    }
    this.broadcast(buildId)
    void this.executeNext(buildId)
    return { ok: true, buildId }
  }

  stop(buildId: string): void {
    const build = this.ledger.getBuild(buildId)
    if (!build) return
    this.stopRequested.add(buildId)
    if (this.current?.buildId === buildId) {
      const workspaceSafe = this.verifyWorkspaceBoundary(build)
      this.interrupt(this.current.meta, buildId, this.current.attemptId)
      this.controlLog(
        buildId,
        this.current.attemptId,
        'system',
        workspaceSafe
          ? 'Stop requested — interrupting current attempt (SIGINT).'
          : 'Stop requested after the workspace root changed — interrupting the canonical process group (SIGINT).',
      )
      return
    }
    const retained = this.retainedProcessOwnership()
    if (retained?.build.id === buildId) {
      const workspaceSafe = this.verifyWorkspaceBoundary(build)
      this.interrupt(retained.meta, buildId, retained.attempt.id)
      this.controlLog(
        buildId,
        retained.attempt.id,
        'system',
        workspaceSafe
          ? 'Stop requested — resuming interruption of the retained process group (SIGINT).'
          : 'Stop requested after the workspace root changed — resuming canonical process-group interruption (SIGINT).',
      )
      return
    }
    this.finishBuild(buildId, 'stopped', 'Stopped by user.')
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
  private refreshCanonicalGroup(meta: AttemptProcessMeta, buildId: string, attemptId: string): void {
    const ownership = this.ledger.attemptProcessOwnership(attemptId)
    if (!ownership || !processMatches(meta)) return
    const fresh = this.deps.processGroupIdentity(meta.pid)
    if (!fresh.includes(`${meta.pid}:${meta.processIdentity}`)) return
    const union = [...new Set([...ownership.groupIdentities, ...fresh])]
    if (union.length === ownership.groupIdentities.length) return
    this.ledger.updateAttemptProcessGroupIdentities(attemptId, union)
    meta.groupIdentities = union
    if (!this.ledger.getBuild(buildId)) throw new Error('Cannot advance process-group ownership for a missing attempt.')
  }

  private interrupt(meta: AttemptProcessMeta, buildId: string, attemptId: string): void {
    if (this.interruptingAttempts.has(attemptId)) return
    if (!processMatches(meta)) {
      const captured = this.ledger.attemptProcessOwnership(attemptId)?.groupIdentities ?? meta.groupIdentities
      this.interruptCaptured(meta, captured, buildId, attemptId)
      return
    }
    const report = (message: string): void => {
      try {
        this.controlLog(buildId, attemptId, message.includes('could not') || message.includes('skipped') ? 'error' : 'system', message)
      } catch (error) {
        console.error('Could not persist process-control event:', error)
      }
    }
    try {
      this.refreshCanonicalGroup(meta, buildId, attemptId)
    } catch (error) {
      report(`Could not advance canonical process-group ownership before interruption: ${error instanceof Error ? error.message : String(error)}`)
    }
    this.interruptingAttempts.add(attemptId)
    this.terminatingBuilds.add(buildId)
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
        this.interruptingAttempts.delete(attemptId)
        this.terminatingBuilds.delete(buildId)
        if (outcome === 'gone') {
          if (this.ledger.attemptProcessOwnership(attemptId)) this.ledger.clearAttemptProcessOwnership(attemptId)
          if (this.ledger.getBuild(buildId)?.status === 'running') void this.executeNext(buildId)
        } else {
          report('Process-group ownership could not be proven settled; the canonical ownership claim remains and new work is blocked pending manual intervention.')
        }
      },
    )
  }

  private interruptCaptured(
    meta: AttemptProcessMeta,
    groupIdentity: readonly string[],
    buildId: string,
    attemptId: string,
  ): void {
    if (this.interruptingAttempts.has(attemptId)) return
    const report = (message: string): void => {
      try {
        this.controlLog(buildId, attemptId, message.includes('could not') || message.includes('skipped') ? 'error' : 'system', message)
      } catch (error) {
        console.error('Could not persist process-control event:', error)
      }
    }
    this.interruptingAttempts.add(attemptId)
    this.terminatingBuilds.add(buildId)
    interruptCapturedProcessGroup(
      meta.pid,
      groupIdentity,
      report,
      (outcome) => {
        this.interruptingAttempts.delete(attemptId)
        this.terminatingBuilds.delete(buildId)
        if (outcome === 'gone') {
          if (this.ledger.attemptProcessOwnership(attemptId)) this.ledger.clearAttemptProcessOwnership(attemptId)
          if (this.ledger.getBuild(buildId)?.status === 'running') void this.executeNext(buildId)
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
  private persistLog(buildId: string, attemptId: string | null, kind: string, text: string, agentId?: string): BuildLogLine {
    const line: BuildLogLine = { buildId, attemptId, ts: this.nowIso(), kind, channel: channelForKind(kind), text: redactLogText(text.slice(0, 4000)) }
    if (agentId) line.agentId = redactLogText(agentId).slice(0, 256)
    if (attemptId) {
      const attempt = this.ledger.getAttempt(attemptId)
      if (attempt) {
        line.round = attempt.round
        line.role = attempt.role
      }
    }
    this.ledger.appendEvent(line)
    return line
  }

  /** Process control must remain durable even when the workspace mirror is unsafe. */
  private controlLog(buildId: string, attemptId: string, kind: string, text: string): void {
    try {
      const attempt = this.ledger.getAttempt(attemptId)
      const line: BuildLogLine = {
        buildId,
        attemptId,
        ts: this.nowIso(),
        kind,
        channel: channelForKind(kind),
        text: redactLogText(text.slice(0, 4000)),
        ...(attempt ? { round: attempt.round, role: attempt.role } : {}),
      }
      this.ledger.appendCanonicalEvent(line)
      this.notifyLog(line)
    } catch (error) {
      console.error('Could not persist canonical process-control event:', error)
    }
  }

  private notifyLog(line: BuildLogLine): void {
    try {
      this.send(IPC.build.log, line)
    } catch {
      /* durable log delivery survives a transient renderer boundary failure */
    }
  }

  private log(buildId: string, attemptId: string | null, kind: string, text: string, agentId?: string): void {
    const line = this.persistLog(buildId, attemptId, kind, text, agentId)
    if (this.logNotificationBuffer) this.logNotificationBuffer.push(line)
    else this.notifyLog(line)
  }

  /** Commit projected events/state before exposing any of those events over IPC. */
  private atomicLogs<T>(work: () => T): T {
    if (this.logNotificationBuffer) return this.ledger.transaction(work)
    const notifications: BuildLogLine[] = []
    const broadcasts = new Set<string>()
    this.logNotificationBuffer = notifications
    this.broadcastBuffer = broadcasts
    try {
      const result = this.ledger.transaction(work)
      this.logNotificationBuffer = null
      this.broadcastBuffer = null
      for (const line of notifications) this.notifyLog(line)
      for (const buildId of broadcasts) this.broadcast(buildId)
      return result
    } catch (error) {
      this.logNotificationBuffer = null
      this.broadcastBuffer = null
      throw error
    }
  }

  private notifyPersistedLog(buildId: string, attemptId: string | null, kind: string, text: string): void {
    const safeText = redactLogText(text.slice(0, 4000))
    const events = attemptId ? this.ledger.eventsForAttempt(attemptId, kind, 100) : this.ledger.eventsForBuild(buildId, 100)
    const line = [...events].reverse().find((event) => event.kind === kind && event.text === safeText)
    if (line) this.notifyLog(line)
  }

  /** Surface every delegated child's stream in the build log, attributed to its slug. */
  private pumpChildStreams(): number {
    if (!this.childTail) return 0
    const { buildId, attemptId, boundary, tailer } = this.childTail
    assertChildStreamBoundary(boundary)
    const events = tailer.poll()
    for (const event of events) this.log(buildId, attemptId, event.kind, event.text, event.agentId)
    return events.length
  }

  /** Preserve a complete execution prompt in the event log without hitting the per-line cap. */
  private logPrompt(buildId: string, attemptId: string, label: string, prompt: string): void {
    const chunkSize = 3_600
    // Redact before slicing so a credential-shaped value cannot straddle two
    // separately sanitized log records.
    const safePrompt = redactLogText(prompt)
    const chunks = Array.from({ length: Math.ceil(safePrompt.length / chunkSize) }, (_, index) => safePrompt.slice(index * chunkSize, (index + 1) * chunkSize))
    for (const [index, chunk] of chunks.entries()) {
      const suffix = chunks.length > 1 ? ` (${index + 1}/${chunks.length})` : ''
      this.log(buildId, attemptId, 'prompt', `${label}${suffix}:\n${chunk}`)
    }
  }

  private broadcast(buildId: string): void {
    if (this.broadcastBuffer) {
      this.broadcastBuffer.add(buildId)
      return
    }
    const build = this.ledger.getBuild(buildId)
    if (!build) return
    const totalAttempts = this.ledger.attemptCount(buildId)
    const projection = this.ledger.recentAttemptProjectionForBuild(buildId, 200)
    try {
      this.send(IPC.build.update, boundedBuildSnapshot({ build, attempts: projection.attempts, totalAttempts, detailTruncated: projection.truncatedFields, aggregate: this.ledger.attemptAggregate(buildId) }))
    } catch {
      /* the ledger remains authoritative across a transient renderer failure */
    }
    if (build.status !== 'running') try {
      const attempts = this.ledger.recentAttemptProjectionForBuild(buildId, 500).attempts
      const snapshot = publishOwnedWorkspaceSnapshot(
        build.workspaceDir,
        requireWorkspaceIdentity(build),
        ['.gauntlet-gamesmith', 'reports', build.id],
        'report-v2',
        '.md',
        buildReport(
          build,
          attempts,
          scanCritiqueArtifacts(build.workspaceDir, build),
          scanReferencePack(build.workspaceDir, this.referenceDir(build.id), build),
          { totalAttempts, aggregate: this.ledger.attemptAggregate(buildId) },
        ),
        'html',
        { managedPrefix: 'report-v2-', maxFiles: 8, maxBytes: 8 * 1024 * 1024 },
      )
      const relativeSnapshot = path.relative(build.workspaceDir, snapshot)
      const message = `Immutable report snapshot: ${relativeSnapshot}`
      if (!this.ledger.eventsForBuild(build.id, 100).some((event) => event.kind === 'artifact' && event.text === message)) {
        const line = this.persistLog(build.id, null, 'artifact', message)
        this.notifyLog(line)
      }
    } catch (error) {
      this.log(build.id, null, 'error', `Report write failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private terminalMessage(status: 'passed' | 'exhausted' | 'stopped' | 'failed', reason: string): string {
    const icon = status === 'passed' ? '🏆' : status === 'failed' ? '✗' : '■'
    return `${icon} Build ${status}: ${reason}`
  }

  /** State and canonical terminal event are written together; safe to call repeatedly. */
  private persistBuildTerminal(buildId: string, status: 'passed' | 'exhausted' | 'stopped' | 'failed', reason: string): void {
    this.ledger.patchBuild(buildId, { status, stopReason: reason })
    const message = this.terminalMessage(status, reason)
    if (!this.ledger.eventsForBuild(buildId, 100).some((event) => event.kind === 'done' && event.text === message)) {
      this.persistLog(buildId, null, 'done', message)
    }
  }

  private finishBuild(buildId: string, status: 'passed' | 'exhausted' | 'stopped' | 'failed', reason: string): void {
    const retryTimer = this.retryTimers.get(buildId)
    if (retryTimer) this.deps.cancelDeferred(retryTimer)
    this.retryTimers.delete(buildId)
    this.rotations.delete(buildId)
    this.ledger.transaction(() => this.persistBuildTerminal(buildId, status, reason))
    this.stopRequested.delete(buildId)
    this.notifyPersistedLog(buildId, null, 'done', this.terminalMessage(status, reason))
    this.broadcast(buildId)
  }

  private async executeNext(buildId: string): Promise<void> {
    if (this.current || this.terminatingBuilds.has(buildId)) return
    const build = this.ledger.getBuild(buildId)
    if (!build || build.status !== 'running') return
    if (!this.verifyWorkspaceBoundary(build)) return
    const owner = this.retainedProcessOwnership()
    if (owner) {
      this.log(build.id, null, 'error', this.retainedOwnershipMessage(owner))
      return
    }
    if (this.stopRequested.has(buildId)) {
      this.finishBuild(buildId, 'stopped', 'Stopped by user.')
      return
    }
    const retryAt = this.queuedRetryAt(buildId)
    if (retryAt && retryAt > this.deps.now()) {
      this.scheduleRetry(buildId, retryAt)
      return
    }
    const attempt = this.ledger.nextQueuedAttempt(buildId)
    if (!attempt) return
    try {
      if (attempt.role === 'assets') {
        this.atomicLogs(() => {
          this.ledger.patchAttempt(attempt.id, {
            status: 'interrupted',
            error: 'Legacy Asset Build handed over to the folded implement phase.',
            finishedAt: this.nowIso(),
          })
          this.ledger.createAttempt({
            buildId: build.id,
            round: attempt.round,
            role: 'implement',
            harness: harnessFor(build.models.orchestratorModel),
            prompt: this.nextImplementPrompt(build, attempt.round, this.verdictForRound(build.id, attempt.round - 1)),
          })
          this.log(build.id, attempt.id, 'system', 'Legacy Asset Build migrated into the implement round; no standalone asset process was launched.')
        })
        this.broadcast(build.id)
        void this.executeNext(build.id)
        return
      }
      const subscriptionBlock = this.subscriptionBlockForAttempt(build, attempt)
      if (subscriptionBlock) {
        this.stopForSubscription(build, attempt, subscriptionBlock.harness, subscriptionBlock.readiness)
        return
      }
      // Authentication/status probes are external calls. Re-check immediately
      // before handing the project path to a role in case it changed meanwhile.
      if (!this.verifyWorkspaceBoundary(build)) return
      if (attempt.role === 'reference') await this.executeReference(build, attempt)
      else if (attempt.role === 'implement') await this.executeImplement(build, attempt)
      else await this.executeCritique(build, attempt)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const persisted = this.ledger.getAttempt(attempt.id)
      this.ledger.patchAttempt(attempt.id, {
        durationMs: persisted?.startedAt ? this.deps.now() - Date.parse(persisted.startedAt) : 0,
        finishedAt: this.nowIso(),
      })
      this.failAttemptAndBuild(build, attempt, message, `Attempt crashed: ${message}`)
    }
  }

  private prepareChildStreams(build: BuildRecord, attempt: PhaseAttempt): ChildStreamBoundary {
    const priorAttemptId = this.ledger.latestAttemptIdExcept(build.id, attempt.id)
    if (priorAttemptId) {
      const archived = archiveChildStreams(build.workspaceDir, priorAttemptId, build)
      if (archived) this.log(build.id, attempt.id, 'system', `Archived ${archived} delegated raw stream${archived === 1 ? '' : 's'} under .gauntlet-gamesmith/agents/${priorAttemptId}/.`)
    }
    return observeChildStreams(build.workspaceDir, build)
  }

  private failLaunch(build: BuildRecord, attempt: PhaseAttempt, message: string, startedAtMs: number): void {
    this.ledger.patchAttempt(attempt.id, {
      durationMs: Math.max(0, this.deps.now() - startedAtMs),
      finishedAt: this.nowIso(),
    })
    // Workspace process metadata is immutable portable evidence. Canonical
    // ownership in SQLite controls recovery; never unlink an agent-replaceable
    // pathname after a separable identity check.
    this.log(build.id, attempt.id, 'error', message)
    this.failAttemptAndBuild(build, attempt, message, message)
  }

  /** Fail closed after spawn without consulting the workspace mirror. */
  private stopSpawnedRunCanonical(build: BuildRecord, attempt: PhaseAttempt, reason: string, startedAtMs: number): void {
    this.stopRequested.add(build.id)
    if (this.ledger.getAttempt(attempt.id)?.status !== 'running') return
    try {
      const finishedAt = this.nowIso()
      this.ledger.interruptAttemptAndStopBuildCanonical(
        build.id,
        attempt.id,
        reason,
        finishedAt,
        Math.max(0, Math.floor(this.deps.now() - startedAtMs)),
      )
      this.notifyPersistedLog(build.id, attempt.id, 'process-control', reason)
    } catch (error) {
      try {
        this.controlLog(build.id, attempt.id, 'error', `Post-spawn quarantine could not be committed; launch supervision remains active: ${redactedErrorMessage(error, 'canonical state unavailable.')}`)
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
    build: BuildRecord,
    attempt: PhaseAttempt,
    child: ReturnType<typeof spawn>,
    own: ExitHolder,
    message: string,
    startedAtMs: number,
  ): void {
    this.terminatingBuilds.add(build.id)
    this.stopRequested.add(build.id)
    const report = (kind: string, text: string): void => {
      try {
        this.controlLog(build.id, attempt.id, kind, text)
      } catch (error) {
        console.error('Could not persist direct-child process-control event:', error)
      }
    }
    let finished = false
    const reason = `${UNKNOWN_LAUNCH_OWNERSHIP} ${message} Canonical process-group ownership was not established after the stock CLI started; an early direct-child exit cannot prove that no detached descendant survived. This workspace remains quarantined against another launch.`
    const finishKnownGone = (): void => {
      if (finished || !own.exited) return
      finished = true
      this.terminatingBuilds.delete(build.id)
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
        this.terminatingBuilds.delete(build.id)
        report('error', 'The unidentified direct child never reported exit after SIGKILL; permanent workspace quarantine remains in force.')
      }, 1_000).unref?.()
    }, 15_000).unref?.()
    // Scheduling direct-handle escalation precedes durable state work so a DB
    // or visibility failure cannot strand the child without a kill timer.
    this.stopSpawnedRunCanonical(build, attempt, reason, startedAtMs)
    if (own.exited) finishKnownGone()
  }

  /** Spawn a detached CLI process whose stdout/stderr stream to files. */
  private spawnDetached(
    build: BuildRecord,
    attempt: PhaseAttempt,
    command: string,
    args: string[],
    env: Record<string, string>,
    effectivePrompt = attempt.prompt,
  ): { meta: AttemptProcessMeta; own: ExitHolder; groupIdentity: readonly string[] } | null {
    const subscriptionBlock = this.subscriptionBlockForAttempt(build, attempt)
    if (subscriptionBlock) {
      this.stopForSubscription(build, attempt, subscriptionBlock.harness, subscriptionBlock.readiness)
      return null
    }
    // CLI version/account probes can take seconds. They are provenance setup,
    // not part of the detached attempt: capture the launch time only after
    // those probes finish so boot recovery does not reject a healthy process
    // whose durable process start legitimately trails the attempt timestamp.
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
      const model = attempt.role === 'critique' ? build.models.criticModel : build.models.orchestratorModel
      const effort = attempt.role === 'critique' ? build.models.criticEffort : build.models.orchestratorEffort
      const version = redactLogText(this.deps.cliVersion(command, env, build.workspaceDir))
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
      let accountLabel = `${attempt.harness}:profile-unavailable`
      try {
        accountLabel = redactLogText(this.deps.accountLabel(attempt.harness, command, env, build.workspaceDir))
          .replace(/[\u0000-\u001f\u007f]/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 255) || accountLabel
      } catch {
        /* the status command failed without widening into credential-file reads */
      }
      // Version/account probes are external processes. Rebind the root before
      // launch state is committed or the detached editor is spawned.
      if (!this.verifyWorkspaceBoundary(build)) {
        closeStreams()
        return null
      }
      startedAtMs = this.deps.now()
      marker = prepareProcessMeta(build.workspaceDir, attempt.id, startedAtMs, requireWorkspaceIdentity(build))
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
      this.ledger.patchAttempt(attempt.id, {
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
      this.log(build.id, attempt.id, 'raw-stream', 'Raw output stream opened for this attempt.')
      this.logPrompt(build.id, attempt.id, attemptPromptLabel(attempt), effectivePrompt)
      this.log(
        build.id,
        attempt.id,
        'system',
        `Build provenance: ${command} ${version} · model ${model} · effort ${effort} · prompt sha256:${promptSha256} · ${accountLabel} on ${machineLabel} · subscription auth · price table ${PRICE_TABLE_VERSION} · cost labeled equivalent API cost.`,
      )
      this.broadcast(build.id)
    } catch (error) {
      closeStreams()
      const message = startedAtMs === 0
        ? `Could not establish build provenance: ${error instanceof Error ? error.message : String(error)}`
        : `Cannot persist process launch record: ${error instanceof Error ? error.message : String(error)}`
      this.failLaunch(build, attempt, message, startedAtMs || this.deps.now())
      return null
    }
    if (!this.verifyWorkspaceBoundary(build)) {
      closeStreams()
      return null
    }
    let child: ReturnType<typeof spawn>
    try {
      child = this.deps.spawnChild(command, args, { cwd: build.workspaceDir, env, detached: true, stdio: ['ignore', spawnedOutFd, spawnedErrFd] })
    } catch (error) {
      closeStreams()
      const message = `Could not spawn ${command}: ${error instanceof Error ? error.message : String(error)}`
      this.failLaunch(build, attempt, message, startedAtMs)
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
      this.controlLog(build.id, attempt.id, 'error', `Spawned child could not be detached from the app handle: ${error instanceof Error ? error.message : String(error)}. Continuing direct supervision.`)
    }
    if (!safePid(child.pid)) {
      const message = `${command} spawned without a safe PID.`
      this.superviseUnidentifiedChild(build, attempt, child, own, message, startedAtMs)
      return null
    }
    let meta: AttemptProcessMeta | null = null
    let groupIdentity: readonly string[] = []
    try {
      groupIdentity = this.deps.processGroupIdentity(child.pid)
      meta = this.deps.completeProcessMeta(build.workspaceDir, attempt.id, marker, child.pid, streamIdentity, groupIdentity)
      if (!groupIdentity.includes(`${meta.pid}:${meta.processIdentity}`)) {
        throw new Error('Spawned process group did not retain the captured leader identity.')
      }
      this.ledger.setAttemptProcessOwnership(attempt.id, {
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
        this.superviseUnidentifiedChild(build, attempt, child, own, message, startedAtMs)
        return null
      }
      this.stopRequested.add(build.id)
      this.terminatingBuilds.add(build.id)
      let settled = false
      const settle = (outcome: 'gone' | 'unresolved'): void => {
        if (settled) return
        settled = true
        this.terminatingBuilds.delete(build.id)
        if (outcome === 'gone') {
          const canonical = this.ledger.attemptProcessOwnership(attempt.id)
          if (canonical && canonical.pid === meta!.pid && canonical.processIdentity === meta!.processIdentity) {
            this.ledger.clearAttemptProcessOwnership(attempt.id)
          }
          return
        }
        try {
          this.controlLog(build.id, attempt.id, 'error', `${UNKNOWN_LAUNCH_OWNERSHIP} The owned process group remained live after bounded escalation; manual intervention is required.`)
        } catch (reportError) {
          console.error('Could not persist unresolved process-control event:', reportError)
        }
      }
      const report = (line: string): void => {
        try {
          this.controlLog(build.id, attempt.id, line.includes('could not') || line.includes('skipped') ? 'error' : 'system', line)
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
        build,
        attempt,
        `${UNKNOWN_LAUNCH_OWNERSHIP} ${message} Process-group ownership could not be committed after the stock CLI started; this workspace remains quarantined against another launch.`,
        startedAtMs,
      )
      return null
    }
    return { meta, own, groupIdentity }
  }

  /**
   * Tail the attempt's output files, feeding lines to the parser (replaying from
   * byte 0 on re-attach with already-logged lines suppressed), until the
   * process exits — then finalize.
   */
  private async driveAttempt(
    build: BuildRecord,
    attempt: PhaseAttempt,
    meta: AttemptProcessMeta,
    idleMs: number,
    hardCapMs: number,
    parser: StreamParser,
    gate: LogGate,
    own: ExitHolder | null,
    initialGroupIdentity: readonly string[],
    childBoundary: ChildStreamBoundary,
  ): Promise<void> {
    try {
      await this.driveOwnedAttempt(build, attempt, meta, idleMs, hardCapMs, parser, gate, own, initialGroupIdentity, childBoundary)
    } catch (error) {
      const message = `Build supervision could not start safely: ${error instanceof Error ? error.message : String(error)}`
      this.stopRequested.add(build.id)
      this.interrupt(meta, build.id, attempt.id)
      this.controlLog(build.id, attempt.id, 'error', message)
      this.stopSpawnedRunCanonical(build, attempt, message, meta.startedAtMs)
      if (this.current?.attemptId === attempt.id) this.current = null
      if (this.childTail?.attemptId === attempt.id) this.childTail = null
    }
  }

  private async driveOwnedAttempt(
    build: BuildRecord,
    attempt: PhaseAttempt,
    meta: AttemptProcessMeta,
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
    const canonicalProjection = this.ledger.getAttempt(attempt.id)?.metrics?.projection
    if (canonicalProjection) {
      meta.loggedOutLines = canonicalProjection.loggedOutLines
      meta.loggedErrLines = canonicalProjection.loggedErrLines
      meta.childOffsets = canonicalProjection.childOffsets
      meta.childIdentities = canonicalProjection.childIdentities ?? {}
      meta.workflowOffsets = canonicalProjection.workflowOffsets
      meta.workflowIdentities = canonicalProjection.workflowIdentities ?? {}
    }
    const att: Attachment = { buildId: build.id, attemptId: attempt.id, meta, timedOut: false }
    this.current = att
    const childDirectory = assertChildStreamBoundary(childBoundary)
    const childTailer = new ChildStreamTailer(
      childDirectory,
      meta.startedAtMs,
      meta.childOffsets,
      meta.childIdentities,
    )
    this.childTail = { buildId: build.id, attemptId: attempt.id, boundary: childBoundary, tailer: childTailer }

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
        ) throw new Error('attempt stream changed identity after launch')
        fd = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0))
        const stat = fs.fstatSync(fd)
        if (
          !stat.isFile()
          || stat.nlink !== 1
          || stat.dev !== entry.dev
          || stat.ino !== entry.ino
          || stat.dev !== expected.dev
          || stat.ino !== expected.ino
        ) throw new Error('attempt stream changed identity while it was opened')
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
          build.id,
          attempt.id,
          'error',
          `Parser rejected a ${attempt.harness} stdout line: ${error instanceof Error ? error.message : String(error)} · raw ${trunc(line, 300)}`,
        )
      }
    }

    const parseStderr = (line: string): void => {
      try {
        parser.onStderr(line)
      } catch (error) {
        this.log(build.id, attempt.id, 'error', `Parser rejected stderr: ${error instanceof Error ? error.message : String(error)} · raw ${trunc(line, 300)}`)
      }
    }

    const boundPartialLine = (text: string, stream: 'stdout' | 'stderr'): string => {
      if (text.length <= MAX_PARTIAL_LINE_CHARS) return text
      const warned = stream === 'stdout' ? warnedLongOut : warnedLongErr
      if (!warned) {
        this.log(
          build.id,
          attempt.id,
          'error',
          `${attempt.harness} ${stream} emitted a line longer than ${MAX_PARTIAL_LINE_CHARS} characters; retaining its tail and continuing supervision.`,
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
      const currentMetrics = this.ledger.getAttempt(attempt.id)?.metrics ?? { agents: [], perModel: {} }
      this.ledger.patchAttempt(attempt.id, {
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
              if (processMatches(meta)) this.interrupt(meta, build.id, attempt.id)
              else this.interruptCaptured(meta, groupSnapshot(), build.id, attempt.id)
              this.controlLog(
                build.id,
                attempt.id,
                'error',
                stalled
                  ? `No progress for ${Math.round(idleFor / 60_000)} min — interrupting.`
                  : `Attempt exceeded the ${Math.round(hardCapMs / 3_600_000)}h ceiling — interrupting.`,
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
                this.ledger.updateAttemptProcessGroupIdentities(attempt.id, union)
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
      workspaceSafe = this.verifyWorkspaceBoundary(build)
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
      this.interrupt(meta, build.id, attempt.id)
      this.controlLog(build.id, attempt.id, 'error', `Attempt supervision failed: ${message}`)
      workspaceSafe = this.verifyWorkspaceBoundary(build)
      if (!workspaceSafe) {
        // Keep process control, but do not refresh portable metadata or touch
        // any path beneath a workspace root that now resolves into app data.
        return
      }
      const currentAttempt = this.ledger.getAttempt(attempt.id)
      if (currentAttempt && (currentAttempt.status === 'running' || currentAttempt.status === 'queued')) {
        this.ledger.patchAttempt(attempt.id, {
          durationMs: this.deps.now() - meta.startedAtMs,
          finishedAt: this.nowIso(),
        })
      }
      if (this.ledger.getBuild(build.id)?.status === 'running') {
        this.failAttemptAndBuild(build, attempt, `Attempt supervision failed: ${message}`, `Attempt supervision failed: ${message}`)
      }
    } finally {
      if (workspaceSafe && this.childTail?.attemptId === attempt.id) {
        try {
          this.pumpChildStreams()
        } catch (error) {
          this.controlLog(build.id, attempt.id, 'error', `Final child-stream drain failed: ${error instanceof Error ? error.message : String(error)}`)
        }
        this.childTail = null
      } else if (this.childTail?.attemptId === attempt.id) {
        this.childTail = null
      }
      if (this.current?.attemptId === attempt.id) this.current = null
      const captured = groupSnapshot()
      let descendantsRemain = captured.length > 0
      try {
        descendantsRemain &&= this.deps.processGroupStillOwned(meta.pid, captured)
      } catch (error) {
        descendantsRemain = true
        this.controlLog(build.id, attempt.id, 'error', `Final process-group absence could not be verified; canonical ownership is retained: ${error instanceof Error ? error.message : String(error)}`)
      }
      if (!descendantsRemain && this.ledger.attemptProcessOwnership(attempt.id)) this.ledger.clearAttemptProcessOwnership(attempt.id)
      // Retain the workspace process snapshot as portable replay evidence.
      // Canonical ownership is cleared only in SQLite after verified absence.
    }
    if (!driveFailed) void this.executeNext(build.id)
  }

  /** Session id of an earlier attempt for this exact round, if reported. */
  private lastImplementSessionId(buildId: string, round: number, exceptAttemptId: string): string | null {
    return this.ledger.latestImplementSessionId(buildId, round, exceptAttemptId)
  }

  private castFor(build: BuildRecord): CastEntry[] {
    if (build.models.referenceMode === 'skip') return []
    return parseCast(scanReferencePack(build.workspaceDir, this.referenceDir(build.id), build).manifest)
  }

  private wantedCast(build: BuildRecord, verdict: Verdict | null): CastEntry[] {
    if (!build.models.assetModel) return []
    const cast = this.castFor(build)
    if (cast.length === 0) return []
    const faulted = assetTargets(verdict?.findings ?? [])
    return faulted.length > 0
      ? cast.filter((entry) => faulted.includes(entry.name))
      : unbuiltCast(build.workspaceDir, cast)
  }

  private verdictForRound(buildId: string, round: number): Verdict | null {
    return this.ledger.attemptsForBuild(buildId)
      .find((candidate) => candidate.role === 'critique' && candidate.round === round && candidate.verdict)
      ?.verdict ?? null
  }

  private nextImplementPrompt(build: BuildRecord, round: number, verdict: Verdict | null): string {
    return buildImplementPrompt(
      build.models,
      build.prompt,
      round,
      verdict,
      this.referenceDir(build.id),
      this.wantedCast(build, verdict),
    )
  }

  // --------------------------------------------------------------- reference

  private async executeReference(build: BuildRecord, attempt: PhaseAttempt): Promise<void> {
    const models = build.models
    if (!this.ensureReferenceSourceBaseline(build, attempt)) return
    const childBoundary = this.prepareChildStreams(build, attempt)
    this.log(
      build.id,
      attempt.id,
      'system',
      `● Reference Study (${attempt.harness} ${models.orchestratorModel}, effort ${models.orchestratorEffort})`,
    )
    const plan = referencePlan({
      models,
      prompt: attempt.prompt,
      claudeHome: this.deps.harnessHome('claude'),
      codexHome: this.deps.harnessHome('codex'),
    })
    const executable = this.executableEnvironment(build, attempt, plan.env)
    const gate: LogGate = { suppress: false }
    const parser = this.makeReferenceParser(build, attempt, gate, childBoundary)
    const spawned = this.spawnDetached(build, attempt, executable.command, plan.args, executable.env)
    if (!spawned) return
    await this.driveAttempt(build, attempt, spawned.meta, REFERENCE_TIMEOUT_MS, REFERENCE_TIMEOUT_MS, parser, gate, spawned.own, spawned.groupIdentity, childBoundary)
  }

  private makeReferenceParser(build: BuildRecord, attempt: PhaseAttempt, gate: LogGate, childBoundary: ChildStreamBoundary): StreamParser {
    return createReferenceProtocol({
      ledger: this.ledger,
      build,
      attempt,
      gate,
      childBoundary,
      referenceDir: this.referenceDir(build.id),
      maxAttempts: MAX_REFERENCE_ATTEMPTS,
      now: this.deps.now,
      nowIso: () => this.nowIso(),
      harnessHome: this.deps.harnessHome,
      log: (kind, text, agentId) => this.log(build.id, attempt.id, kind, text, agentId),
      persistLog: (kind, text) => { this.persistLog(build.id, attempt.id, kind, text) },
      notifyPersistedLog: (kind, text) => this.notifyPersistedLog(build.id, attempt.id, kind, text),
      broadcast: () => this.broadcast(build.id),
      awaitChildren: () => this.awaitChildren(build, attempt, childBoundary),
      isStopRequested: () => this.stopRequested.has(build.id),
      finishCancelled: (exit, reason, terminalLog) => this.finishCancelledAttempt(build, attempt, exit, reason, terminalLog),
      ensureSourceBaseline: (terminalLog) => this.ensureReferenceSourceBaseline(build, attempt, terminalLog),
      failOrRetry: (error, label, maxAttempts, prompt, terminalLog) => this.failOrRetryPhase(build, attempt, error, label, maxAttempts, prompt, terminalLog),
      overBudget: () => this.overBudget(build.id),
      persistBuildTerminal: (status, reason) => this.persistBuildTerminal(build.id, status, reason),
      implementPrompt: (round, verdict) => this.nextImplementPrompt(build, round, verdict),
    })
  }
  // ---------------------------------------------------------------- implement

  private async executeImplement(build: BuildRecord, attempt: PhaseAttempt): Promise<void> {
    const models = build.models
    const harness = harnessFor(models.orchestratorModel)
    if (!this.verifyReferenceBoundary(build, attempt)) return
    if (!this.verifyCritiqueTreeBoundary(build, attempt, true)) return
    const wanted = this.wantedCast(build, this.verdictForRound(build.id, attempt.round - 1))
    if (wanted.length > 0) {
      const skill = ensureSkill()
      if (!skill.dir) {
        this.failAttemptAndBuild(
          build,
          attempt,
          'The img2threejs skill is missing from this install.',
          'The implement round cannot sculpt its Reference Study cast until Gauntlet Gamesmith is reinstalled.',
        )
        return
      }
      scaffoldAssetTools(build.workspaceDir, skill.dir, requireWorkspaceIdentity(build))
      const sculptor = sculptorAgentMd(models, this.referenceDir(build.id))
      if (sculptor) {
        const result = writeWorkspaceFileSafely(
          build.workspaceDir,
          requireWorkspaceIdentity(build),
          ['.claude', 'agents'],
          'sculptor.md',
          sculptor,
          { replace: true },
        )
        if (result === 'created' || result === 'updated') {
          this.log(build.id, attempt.id, 'system', `Published the sculptor agent definition (${result}).`)
        }
      }
    }
    const scaffold = scaffoldEngine(build.workspaceDir, requireWorkspaceIdentity(build))
    if (scaffold.refreshed.length > 0) {
      this.log(build.id, attempt.id, 'system', `Restored app-owned engine files: ${scaffold.refreshed.join(', ')}.`)
    }
    const agent = implementerAgentDefinition(models, this.referenceDir(build.id))
    if (agent) {
      publishOwnedWorkspaceFile(build.workspaceDir, requireWorkspaceIdentity(build), ['.claude', 'agents'], agent.filename, agent.markdown, 'yaml-frontmatter', {
        managedPrefix: GAUNTLET_IMPLEMENTER_AGENT_PREFIX,
        maxFiles: 256,
        maxBytes: 4 * 1024 * 1024,
      })
    }
    const childBoundary = this.prepareChildStreams(build, attempt)

    const priorSessionId = build.playTrusted ? this.lastImplementSessionId(build.id, attempt.round, attempt.id) : null
    const effective = effectivePromptForAttempt(attempt.prompt)
    const isResume = effective.resumeRequested && priorSessionId != null
    const prompt = effective.prompt

    this.log(
      build.id,
      attempt.id,
      'system',
      `● Round ${attempt.round} — implement (${harness} ${models.orchestratorModel}, effort ${models.orchestratorEffort})${isResume ? ' — continuing interrupted session' : ''}`,
    )
    const plan = implementPlan({
      models,
      prompt,
      claudeHome: this.deps.harnessHome('claude'),
      codexHome: this.deps.harnessHome('codex'),
      resumeId: isResume ? priorSessionId : null,
    })
    const executable = this.executableEnvironment(build, attempt, plan.env)
    const gate: LogGate = { suppress: false }
    const parser =
      harness === 'claude'
        ? this.makeImplementParser(build, attempt, gate, childBoundary)
        : this.makeCodexImplementParser(build, attempt, gate, childBoundary)
    const spawned = this.spawnDetached(build, attempt, executable.command, plan.args, executable.env, prompt)
    if (!spawned) return
    await this.driveAttempt(build, attempt, spawned.meta, IMPLEMENT_IDLE_MS, IMPLEMENT_HARD_CAP_MS, parser, gate, spawned.own, spawned.groupIdentity, childBoundary)
  }

  /**
   * Hold the round open while delegated workers are still writing.
   *
   * An orchestrator can finish its turn with children still running — a claude
   * one will not sit and wait, and on a real round it said "still waiting on
   * the codex runs" and exited, which committed a half-written build eight
   * minutes before codex finished. Waiting is the app's job, not an agent's.
   */
  private async awaitChildren(build: BuildRecord, attempt: PhaseAttempt, childBoundary: ChildStreamBoundary): Promise<void> {
    const deadline = this.deps.now() + IMPLEMENT_HARD_CAP_MS
    let announced = false
    while (!this.stopRequested.has(build.id) && childrenActive(childBoundary, CHILD_QUIET_MS, this.deps.now()) && this.deps.now() < deadline) {
      if (!announced) {
        announced = true
        this.log(build.id, attempt.id, 'system', '⏳ orchestrator finished, delegated workers still running — holding the round open.')
      }
      await this.deps.wait(15_000)
      this.pumpChildStreams()
    }
    if (this.stopRequested.has(build.id)) return
    const failures = childStreamFailures(childBoundary, CHILD_QUIET_MS, this.deps.now())
    for (const failure of failures) {
      this.log(
        build.id,
        attempt.id,
        'error',
        `Delegated ${failure.harness} worker "${failure.agentId}" ${failure.reason}; it will no longer hold the round open.`,
        failure.agentId,
      )
    }
    if (announced) {
      const stillActive = childrenActive(childBoundary, CHILD_QUIET_MS, this.deps.now())
      if (stillActive) throw new Error('Delegated-worker deadline expired before every worker emitted a terminal protocol event and became quiet.')
      this.log(
        build.id,
        attempt.id,
        failures.length > 0 ? 'error' : 'system',
        failures.length > 0
          ? `Delegated-worker wait released after ${failures.length} worker${failures.length === 1 ? '' : 's'} failed to produce a complete protocol stream.`
          : '✓ delegated workers finished.',
      )
    }
  }

  private makeImplementParser(
    build: BuildRecord,
    attempt: PhaseAttempt,
    gate: LogGate,
    childBoundary: ChildStreamBoundary,
    initialWorkflowOffsets: Record<string, number> = {},
    initialWorkflowIdentities: Record<string, { dev: number; ino: number }> = {},
  ): StreamParser {
    return createClaudeImplementProtocol({
      ledger: this.ledger,
      build,
      attempt,
      gate,
      childBoundary,
      initialWorkflowOffsets,
      initialWorkflowIdentities,
      now: this.deps.now,
      nowIso: () => this.nowIso(),
      harnessHome: this.deps.harnessHome,
      log: (kind, text, agentId) => this.log(build.id, attempt.id, kind, text, agentId),
      broadcast: () => this.broadcast(build.id),
      finalize: (exit, collect) => this.finishImplement(build, attempt, childBoundary, exit, collect),
    })
  }

  /**
   * Everything that happens after an implement attempt's process exits, whichever
   * CLI ran it: wait for delegated workers, record the build, then either stop
   * the build or hand the round to the critic.
   */
  /**
   * An implement attempt driven by codex.
   *
   * Codex spawns its workers as threads of its own, each with its own session
   * log under CODEX_HOME, so per-worker tokens are read from there rather than
   * from the stream — the stream carries only the orchestrator's turns. Claude
   * workers, when the attempt delegates across harnesses, report through their own
   * stream files instead.
   */
  private makeCodexImplementParser(build: BuildRecord, attempt: PhaseAttempt, gate: LogGate, childBoundary: ChildStreamBoundary): StreamParser {
    return createCodexImplementProtocol({
      ledger: this.ledger,
      build,
      attempt,
      gate,
      childBoundary,
      now: this.deps.now,
      nowIso: () => this.nowIso(),
      harnessHome: this.deps.harnessHome,
      log: (kind, text, agentId) => this.log(build.id, attempt.id, kind, text, agentId),
      broadcast: () => this.broadcast(build.id),
      finalize: (exit, collect) => this.finishImplement(build, attempt, childBoundary, exit, collect),
    })
  }

  private async finishImplement(
    build: BuildRecord,
    attempt: PhaseAttempt,
    childBoundary: ChildStreamBoundary,
    exit: ExitInfo,
    collect: () => ImplementOutcome,
  ): Promise<void> {
    await finalizeImplement({
      ledger: this.ledger,
      build,
      attempt,
      now: this.deps.now,
      nowIso: () => this.nowIso(),
      referenceDir: this.referenceDir(build.id),
      awaitChildren: () => this.awaitChildren(build, attempt, childBoundary),
      isStopRequested: () => this.stopRequested.has(build.id),
      finishCancelled: (finalExit, reason, terminalLog) => this.finishCancelledAttempt(build, attempt, finalExit, reason, terminalLog),
      verifyCritiqueTree: (terminalLog) => this.verifyCritiqueTreeBoundary(build, attempt, false, terminalLog),
      retryRateLimit: (error, terminalLog) => this.retryRateLimit(build, attempt, error, terminalLog),
      failAttempt: (error, reason, terminalLog) => { this.failAttemptAndBuild(build, attempt, error, reason, terminalLog) },
      verifyReference: (terminalLog) => this.verifyReferenceBoundary(build, attempt, terminalLog),
      persistLog: (kind, text) => { this.persistLog(build.id, attempt.id, kind, text) },
      notifyPersistedLog: (kind, text) => this.notifyPersistedLog(build.id, attempt.id, kind, text),
      persistBuildTerminal: (status, reason) => this.persistBuildTerminal(build.id, status, reason),
      finishBuild: (status, reason) => this.finishBuild(build.id, status, reason),
      broadcast: () => this.broadcast(build.id),
    }, exit, collect)
  }

  // ---------------------------------------------------------------- critique

  private async executeCritique(build: BuildRecord, attempt: PhaseAttempt): Promise<void> {
    const models = build.models
    if (!this.verifyReferenceBoundary(build, attempt)) return
    const childBoundary = this.prepareChildStreams(build, attempt)
    if (!attempt.revision) {
      this.failAttemptAndBuild(build, attempt, 'Critique has no implementation revision binding.', `Round ${attempt.round} critique has no implementation revision binding.`)
      return
    }
    if (!workspaceMatchesRevision(build.workspaceDir, build.id, attempt.revision)) {
      this.log(build.id, attempt.id, 'error', `Stale critique rejected before launch: workspace no longer matches revision ${attempt.revision}.`)
      this.failAttemptAndBuild(
        build,
        attempt,
        'Workspace changed after implementation revision capture.',
        `Workspace changed before round ${attempt.round} critique could judge revision ${attempt.revision.slice(0, 12)}.`,
      )
      return
    }
    let verdictPath: string
    try {
      verdictPath = prepareVerdictArtifact(build.workspaceDir, attempt.round, attempt.id)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.failAttemptAndBuild(
        build,
        attempt,
        `Could not prepare a fresh verdict artifact: ${message}`,
        `Round ${attempt.round} critique could not claim its verdict path: ${message}`,
      )
      return
    }
    this.log(
      build.id,
      attempt.id,
      'system',
      `● Round ${attempt.round} — critique (${attempt.harness} ${models.criticModel}, effort ${models.criticEffort}, fresh eyes)`,
    )
    const exactPrompt = buildCriticPrompt(
      build.prompt,
      attempt.round,
      this.referenceDir(build.id),
      attempt.revision,
      path.basename(verdictPath),
      engineGateRules(),
      models.referenceMode,
    )
    const plan = critiquePlan({
      models,
      prompt: exactPrompt,
      claudeHome: this.deps.harnessHome('claude'),
      codexHome: this.deps.harnessHome('codex'),
    })
    const executable = this.executableEnvironment(build, attempt, plan.env)
    const gate: LogGate = { suppress: false }
    const parser = this.makeCritiqueParser(build, attempt, gate)
    const spawned = this.spawnDetached(build, attempt, executable.command, plan.args, executable.env, exactPrompt)
    if (!spawned) return
    await this.driveAttempt(build, attempt, spawned.meta, CRITIQUE_TIMEOUT_MS, CRITIQUE_TIMEOUT_MS, parser, gate, spawned.own, spawned.groupIdentity, childBoundary)
  }

  private makeCritiqueParser(build: BuildRecord, attempt: PhaseAttempt, gate: LogGate): StreamParser {
    return createCritiqueProtocol({
      ledger: this.ledger,
      build,
      attempt,
      gate,
      referenceDir: this.referenceDir(build.id),
      maxAttempts: MAX_CRITIQUE_ATTEMPTS,
      now: this.deps.now,
      nowIso: () => this.nowIso(),
      log: (kind, text, agentId) => this.log(build.id, attempt.id, kind, text, agentId),
      persistLog: (kind, text) => { this.persistLog(build.id, attempt.id, kind, text) },
      notifyPersistedLog: (kind, text) => this.notifyPersistedLog(build.id, attempt.id, kind, text),
      broadcast: () => this.broadcast(build.id),
      finishCancelled: (exit, reason, terminalLog) => this.finishCancelledAttempt(build, attempt, exit, reason, terminalLog),
      verifyReference: (terminalLog) => this.verifyReferenceBoundary(build, attempt, terminalLog),
      failOrRetry: (error, label, maxAttempts, prompt, terminalLog) => this.failOrRetryPhase(build, attempt, error, label, maxAttempts, prompt, terminalLog),
      overBudget: () => this.overBudget(build.id),
      finishBuild: (status, reason) => this.finishBuild(build.id, status, reason),
      persistBuildTerminal: (status, reason) => this.persistBuildTerminal(build.id, status, reason),
      implementPrompt: (round, verdict) => this.nextImplementPrompt(build, round, verdict),
    })
  }
  private overBudget(buildId: string): boolean {
    if (!this.budgetReached(buildId)) return false
    const build = this.ledger.getBuild(buildId)
    if (!build?.budgetUsd) return false
    this.finishBuild(buildId, 'stopped', `Budget ceiling hit: $${build.totalCostUsd.toFixed(2)} of $${build.budgetUsd.toFixed(2)} (equivalent API cost).`)
    return true
  }

  private budgetReached(buildId: string, pendingCostUsd = 0): boolean {
    const build = this.ledger.getBuild(buildId)
    return !!build?.budgetUsd && build.totalCostUsd + Math.max(0, pendingCostUsd) >= build.budgetUsd
  }

}
