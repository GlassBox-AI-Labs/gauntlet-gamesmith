import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type {
  AgentMetric,
  LoopLogLine,
  LoopModels,
  LoopRecord,
  LoopSnapshot,
  RunMetrics,
  RunRecord,
  RunRole,
  StartLoopInput,
  StartLoopResult,
  TokenTotals,
  Verdict,
} from '../shared/loop'
import { channelForKind, RESUME_PREFIX, runPromptLabel } from '../shared/loop'
import { describeModels, harnessFor, isCrossHarness, isUltracode, resolveModels } from '../shared/models'
import { buildCriticPrompt, buildReferencePrompt, composeImplementPrompt } from '../shared/prompts'
import { agentsDir, childrenActive, readChildAgents } from './child-agents'
import { codexTokens, readCodexUsage } from './codex-usage'
import { delegationRules, implementerAgentMd, researchRules } from './delegation'
import { engineContract, engineGateRules, scaffoldEngine, type ScaffoldResult } from './engine-stack'
import { critiquePlan, DISPATCHER_MODEL, implementPlan, referencePlan } from './harness-plans'
import { cliHome, runsDir, subscriptionEnv } from './harness-env'
import type { Ledger } from './ledger'
import { estimateCostUsd } from './pricing'
import { referencePackDir, scanReferencePack } from './reference-pack'
import { buildReport, scanCritiqueArtifacts } from './report'
import { captureRoundRevision } from './round-revision'
import { translateClaudeLine } from './streams/claude-stream'
import { ChildStreamTailer } from './streams/child-tailer'
import { translateCodexLine } from './streams/codex-stream'
import { readWorkflowProgress, workflowDir, type WorkflowRunSummary } from './workflow-progress'
import { WorkflowTail, workflowTailDir } from './workflow-tail'

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

/**
 * Which cost figure to trust for an implement run.
 *
 * `total_cost_usd` covers the main thread only. On a run that fanned out
 * through a workflow it reported $5.11 while the CLI's own per-model
 * accounting reported $14.39 for the same run — the fan-out is missing from
 * it. `modelUsage` counts every agent and is what the run's breakdown itemises,
 * so the headline total comes from there whenever the CLI provides it, and the
 * total always equals the sum of the parts shown beneath it.
 */
export function implementCostUsd(
  perModel: RunMetrics['perModel'],
  totalCostUsd: number | null,
  liveEstimate: number | null,
): number | null {
  const costs = Object.values(perModel).map((m) => m.costUsd)
  if (costs.some((c) => c != null)) return costs.reduce((sum: number, c) => sum + (c ?? 0), 0)
  return totalCostUsd ?? liveEstimate
}

/**
 * Token totals for an implement run.
 *
 * `result.usage` covers the orchestrator's own thread. On a fan-out that is a
 * sliver of the run, so writing it over the live figures at finalize made the
 * counter collapse the moment the round ended — the same trap implementCostUsd
 * already avoids for cost. `perModel` comes from the CLI's own modelUsage,
 * which counts every agent, so it wins whenever the CLI provides it. Null means
 * neither source knows, and the live figures should be left alone.
 */
export function implementTokens(
  perModel: RunMetrics['perModel'],
  usage: Record<string, number> | undefined,
): { input: number; output: number } | null {
  const models = Object.values(perModel)
  if (models.length) {
    return {
      input: models.reduce((sum, m) => sum + m.tokens.input + m.tokens.cacheRead + m.tokens.cacheWrite, 0),
      output: models.reduce((sum, m) => sum + m.tokens.output, 0),
    }
  }
  if (!usage) return null
  return {
    input: (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0),
    output: usage.output_tokens ?? 0,
  }
}

function trunc(value: string, max: number): string {
  const flat = value.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

function emptyTokens(): TokenTotals {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function parseVerdict(text: string): Verdict | null {
  const candidates: string[] = []
  for (const match of text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)) candidates.push(match[1].trim())
  candidates.reverse()
  const scoreIdx = text.lastIndexOf('"score"')
  if (scoreIdx >= 0) {
    const start = text.lastIndexOf('{', scoreIdx)
    if (start >= 0) {
      let depth = 0
      for (let i = start; i < text.length; i += 1) {
        if (text[i] === '{') depth += 1
        else if (text[i] === '}') {
          depth -= 1
          if (depth === 0) {
            candidates.push(text.slice(start, i + 1))
            break
          }
        }
      }
    }
  }
  for (const candidate of candidates) {
    try {
      const verdict = normalizeVerdict(JSON.parse(candidate))
      if (verdict) return verdict
    } catch {
      /* try next candidate */
    }
  }
  return null
}

/**
 * Deterministic verdict channel: the critique protocol also writes its verdict
 * to critique/round-<n>/verdict.json, so a critic that muffs the final-message
 * format does not throw away a finished evaluation. `sinceMs` rejects files
 * left behind by an earlier loop that reused the same workspace and round.
 */
export function readVerdictArtifact(workspaceDir: string, round: number, sinceMs: number): Verdict | null {
  const file = path.join(workspaceDir, 'critique', `round-${round}`, 'verdict.json')
  try {
    if (fs.statSync(file).mtimeMs < sinceMs) return null
    return parseVerdict(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function normalizeVerdict(value: unknown): Verdict | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  let score = Number(raw.score)
  if (!Number.isFinite(score)) return null
  if (score > 1 && score <= 10) score /= 10
  score = Math.min(1, Math.max(0, score))
  const findings = Array.isArray(raw.findings)
    ? raw.findings
        .map((f) => {
          const finding = f as Record<string, unknown>
          const text = typeof finding?.text === 'string' ? finding.text : typeof f === 'string' ? f : ''
          return { severity: typeof finding?.severity === 'string' ? finding.severity : 'note', text: text.slice(0, 600) }
        })
        .filter((f) => f.text)
        .slice(0, 100)
    : []
  return { score, pass: raw.pass === true, summary: String(raw.summary ?? '').slice(0, 2000), findings }
}

/**
 * The user's prompt says what game to build; the engine contract says what to
 * build it out of. It is passed on every round rather than only the first,
 * because by round seven the critic is pushing hard on lighting and game feel
 * and the architecture is exactly what gets quietly traded away to fix
 * findings.
 */
function buildImplementPrompt(
  models: LoopModels,
  userPrompt: string,
  round: number,
  verdict: Verdict | null,
  referenceDir: string,
): string {
  return composeImplementPrompt(userPrompt, round, verdict, delegationRules(models, referenceDir), referenceDir, engineContract())
}

/** On-disk record of a detached run process; lets the app die and re-attach. */
interface ProcMeta {
  pid: number
  outPath: string
  errPath: string
  startedAtMs: number
  loggedOutLines: number
  loggedErrLines: number
  /** Byte offsets into each child stream, so a re-attach does not replay child logs. */
  childOffsets?: Record<string, number>
}

interface ExitHolder {
  exited: boolean
  code: number | null
  spawnError: string | null
}

/** What an implement parser hands back once its process has exited. */
interface ImplementOutcome {
  metrics: RunMetrics
  costUsd: number | null
  tokens: { input: number; output: number } | null
  numTurns: number | null
  sessionId: string | null
  summary: string | null
  /** Non-null when the harness reported the run as failed. */
  error: string | null
  /** The CLI's own result event, for the metric log line. */
  logResult: Record<string, unknown> | null
}

interface ExitInfo {
  code: number | null // null = exit code unknown (re-attached process)
  timedOut: boolean
  spawnError: string | null
}

interface StreamParser {
  onLine(line: string): void
  onStderr(text: string): void
  /** Called on the drive loop regardless of output, for work that must happen
   *  while the process is quiet — an orchestrator waiting on a fan-out emits
   *  nothing for minutes, which is exactly when its agents need reading. */
  tick?(): void
  /** Epoch ms of the last observed progress, for idle detection. */
  progressAt?(): number
  finalize(exit: ExitInfo): Promise<void> | void
}

interface Attachment {
  loopId: string
  runId: string
  pid: number
  timedOut: boolean
}

interface LogGate {
  suppress: boolean
}

export class LoopRunner {
  private current: Attachment | null = null
  private stopRequested = new Set<string>()
  /** Round/role of a run never change, so stamping log lines needs one lookup per run. */
  private runStamps = new Map<string, { round: number; role: RunRole }>()
  /** Child streams of the run being driven; also pumped while awaiting stragglers. */
  private childTail: { loopId: string; runId: string; tailer: ChildStreamTailer } | null = null

  constructor(
    private ledger: Ledger,
    private send: (channel: string, payload: unknown) => void,
  ) {}

  snapshot(): LoopSnapshot | null {
    const loop = this.ledger.runningLoop() ?? this.ledger.latestLoop()
    if (!loop) return null
    return { loop, runs: this.ledger.runsForLoop(loop.id) }
  }

  /** New loops own a scoped pack; pre-v1 loops keep using their legacy root. */
  private referenceDir(loopId: string): string {
    return this.ledger.runsForLoop(loopId).some((run) => run.role === 'reference') ? referencePackDir(loopId) : 'reference'
  }

  start(input: StartLoopInput): StartLoopResult {
    if (this.current || this.ledger.runningLoop()) return { ok: false, error: 'A loop is already running. Stop it first.' }
    const prompt = input.prompt.trim()
    if (!prompt) return { ok: false, error: 'Prompt is empty.' }
    const workspaceDir = input.workspaceDir.trim()
    if (!workspaceDir || !path.isAbsolute(workspaceDir)) return { ok: false, error: 'Workspace must be an absolute path.' }
    const maxRounds = Math.max(1, Math.min(100, Math.floor(input.maxRounds) || 10))
    const budgetUsd = input.budgetUsd && input.budgetUsd > 0 ? input.budgetUsd : null
    let scaffold: ScaffoldResult
    try {
      fs.mkdirSync(workspaceDir, { recursive: true })
      // Round one starts on the engine rather than spending its budget
      // deciding on one — and deciding differently in every workspace.
      scaffold = scaffoldEngine(workspaceDir)
    } catch (error) {
      return { ok: false, error: `Cannot create workspace: ${error instanceof Error ? error.message : String(error)}` }
    }

    const models = resolveModels(input, input, input)
    const loop = this.ledger.createLoop({ prompt, workspaceDir, maxRounds, budgetUsd, models })
    this.log(loop.id, null, 'system', `Loop started — workspace ${workspaceDir}, max ${maxRounds} rounds${budgetUsd ? `, budget $${budgetUsd}` : ''}.`)
    this.log(
      loop.id,
      null,
      'system',
      scaffold.created.length
        ? `Engine scaffolded — ${scaffold.created.join(', ')}.`
        : 'Engine contract refreshed; workspace already scaffolded.',
    )
    this.log(
      loop.id,
      null,
      'system',
      describeModels(models),
    )
    const referenceDir = referencePackDir(loop.id)
    this.ledger.createRun({
      loopId: loop.id,
      round: 0,
      role: 'reference',
      harness: harnessFor(models.orchestratorModel),
      prompt: buildReferencePrompt(prompt, referenceDir, researchRules(models, referenceDir)),
    })
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
    for (const loop of this.ledger.runningLoops()) {
      const runs = this.ledger.runsForLoop(loop.id)
      const active = runs.find((r) => r.status === 'running')
      if (active) {
        const meta = this.readMeta(loop.workspaceDir, active.id)
        if (meta) {
          const alive = this.pidAlive(meta.pid)
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
          const parser =
            active.role === 'reference'
              ? this.makeReferenceParser(loop, active, gate)
              : active.role === 'implement'
                ? this.makeImplementParser(loop, active, gate)
                : this.makeCritiqueParser(loop, active, gate)
          const idle = active.role === 'implement' ? IMPLEMENT_IDLE_MS : active.role === 'reference' ? REFERENCE_TIMEOUT_MS : CRITIQUE_TIMEOUT_MS
          const cap = active.role === 'implement' ? IMPLEMENT_HARD_CAP_MS : active.role === 'reference' ? REFERENCE_TIMEOUT_MS : CRITIQUE_TIMEOUT_MS
          void this.driveRun(loop, active, meta, idle, cap, parser, gate, null)
          continue
        }
        this.ledger.requeueInterruptedRun(active)
        this.log(loop.id, null, 'system', `App restarted — no live process found; requeued round ${active.round} ${active.role}.`)
      } else if (!runs.some((r) => r.status === 'queued')) {
        this.finishLoop(loop.id, 'stopped', 'No pending work found after app restart.')
        continue
      }
      this.broadcast(loop.id)
      void this.executeNext(loop.id)
    }
  }

  /** The run currently being supervised, if any. */
  activeRun(): { loopId: string; runId: string; pid: number; role: string } | null {
    if (!this.current) return null
    const run = this.ledger.getRun(this.current.runId)
    return { loopId: this.current.loopId, runId: this.current.runId, pid: this.current.pid, role: run?.role ?? 'run' }
  }

  /**
   * Graceful shutdown chosen at quit: SIGINT the agent and mark the loop
   * stopped so the next launch does not resume it. (The SIGTERM/SIGKILL
   * escalation timers die with the app; SIGINT is the reliable signal.)
   */
  stopForQuit(): void {
    if (!this.current) return
    const { loopId, runId, pid } = this.current
    this.interruptPid(pid)
    this.ledger.patchRun(runId, { status: 'cancelled', error: 'Stopped by user at quit.', finishedAt: new Date().toISOString() })
    this.ledger.patchLoop(loopId, { status: 'stopped', stopReason: 'Stopped by user at quit.' })
  }

  /** Revive a stopped loop: requeue where it left off and keep going. */
  resumeLoop(loopId: string): StartLoopResult {
    const loop = this.ledger.getLoop(loopId)
    if (!loop) return { ok: false, error: 'Loop not found.' }
    if (loop.status === 'running') return { ok: false, error: 'Loop is already running.' }
    if (loop.status === 'passed') return { ok: false, error: 'Loop already passed — start a new run to keep improving.' }
    if (this.current || this.ledger.runningLoop()) return { ok: false, error: 'Another loop is running. Stop it first.' }
    this.stopRequested.delete(loopId)

    const runs = this.ledger.runsForLoop(loopId)
    const last = runs.at(-1)
    this.ledger.patchLoop(loopId, { status: 'running', stopReason: null })
    if (last && last.status !== 'succeeded') {
      const base = last.prompt.startsWith(RESUME_PREFIX) ? last.prompt.slice(RESUME_PREFIX.length) : last.prompt
      this.ledger.createRun({
        loopId,
        round: last.round,
        role: last.role,
        harness: last.harness,
        prompt: last.role === 'implement' ? RESUME_PREFIX + base : base,
      })
      this.log(loopId, null, 'system', `Loop resumed by user — retrying round ${last.round} ${last.role}.`)
    } else if (last?.role === 'reference') {
      const referenceDir = this.referenceDir(loopId)
      this.ledger.patchLoop(loopId, { round: 1 })
      this.ledger.createRun({
        loopId,
        round: 1,
        role: 'implement',
        harness: harnessFor(loop.models.orchestratorModel),
        prompt: buildImplementPrompt(loop.models, loop.prompt, 1, null, referenceDir),
      })
      this.log(loopId, null, 'system', 'Loop resumed by user — Reference Pack ready; starting round 1.')
    } else if (last?.role === 'implement' && last.round >= loop.maxRounds) {
      this.finishLoop(loopId, 'exhausted', `Max rounds (${loop.maxRounds}) reached after round ${last.round} — no critique, since no round is left for it to gate.`)
      return { ok: true }
    } else if (last?.role === 'implement') {
      this.ledger.createRun({
        loopId,
        round: last.round,
        role: 'critique',
        harness: loop.models.criticHarness,
        prompt: buildCriticPrompt(loop.prompt, last.round, this.referenceDir(loopId), engineGateRules()),
      })
      this.log(loopId, null, 'system', `Loop resumed by user — judging round ${last.round}.`)
    } else if (last?.role === 'critique') {
      const nextRound = last.round + 1
      if (nextRound > loop.maxRounds) {
        this.finishLoop(loopId, 'exhausted', `Max rounds (${loop.maxRounds}) reached.`)
        return { ok: false, error: 'Max rounds already reached.' }
      }
      this.ledger.patchLoop(loopId, { round: nextRound })
      this.ledger.createRun({
        loopId,
        round: nextRound,
        role: 'implement',
        harness: harnessFor(loop.models.orchestratorModel),
        prompt: buildImplementPrompt(loop.models, loop.prompt, nextRound, last.verdict, this.referenceDir(loopId)),
      })
      this.log(loopId, null, 'system', `Loop resumed by user — starting round ${nextRound}.`)
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
    this.broadcast(loopId)
    void this.executeNext(loopId)
    return { ok: true, loopId }
  }

  stop(loopId: string): void {
    this.stopRequested.add(loopId)
    if (this.current?.loopId === loopId) {
      this.log(loopId, this.current.runId, 'system', 'Stop requested — interrupting current run (SIGINT).')
      this.interruptPid(this.current.pid)
      return
    }
    this.finishLoop(loopId, 'stopped', 'Stopped by user.')
  }

  private pidAlive(pid: number): boolean {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }

  private interruptPid(pid: number): void {
    const tryKill = (signal: NodeJS.Signals): void => {
      try {
        process.kill(pid, signal)
      } catch {
        /* already gone */
      }
    }
    tryKill('SIGINT')
    setTimeout(() => this.pidAlive(pid) && tryKill('SIGTERM'), 10_000).unref()
    setTimeout(() => this.pidAlive(pid) && tryKill('SIGKILL'), 15_000).unref()
  }

  private metaPath(workspaceDir: string, runId: string): string {
    return path.join(runsDir(workspaceDir), `${runId}.json`)
  }

  private readMeta(workspaceDir: string, runId: string): ProcMeta | null {
    try {
      return JSON.parse(fs.readFileSync(this.metaPath(workspaceDir, runId), 'utf8')) as ProcMeta
    } catch {
      return null
    }
  }

  private writeMeta(workspaceDir: string, runId: string, meta: ProcMeta): void {
    try {
      fs.writeFileSync(this.metaPath(workspaceDir, runId), JSON.stringify(meta))
    } catch {
      /* non-fatal */
    }
  }

  private log(loopId: string, runId: string | null, kind: string, text: string, agentId?: string): void {
    const line: LoopLogLine = { loopId, runId, ts: new Date().toISOString(), kind, channel: channelForKind(kind), text: text.slice(0, 4000) }
    if (agentId) line.agentId = agentId
    if (runId) {
      let stamp = this.runStamps.get(runId)
      if (!stamp) {
        const run = this.ledger.getRun(runId)
        if (run) {
          stamp = { round: run.round, role: run.role }
          this.runStamps.set(runId, stamp)
        }
      }
      if (stamp) {
        line.round = stamp.round
        line.role = stamp.role
      }
    }
    this.ledger.appendEvent(line)
    this.send('loop:log', line)
  }

  /** Surface every delegated child's stream in the run log, attributed to its slug. */
  private pumpChildStreams(): void {
    if (!this.childTail) return
    const { loopId, runId, tailer } = this.childTail
    for (const event of tailer.poll()) this.log(loopId, runId, event.kind, event.text, event.agentId)
  }

  /** Preserve a complete execution prompt in the event log without hitting the per-line cap. */
  private logPrompt(loopId: string, runId: string, label: string, prompt: string): void {
    const chunkSize = 3_600
    const chunks = Array.from({ length: Math.ceil(prompt.length / chunkSize) }, (_, index) => prompt.slice(index * chunkSize, (index + 1) * chunkSize))
    for (const [index, chunk] of chunks.entries()) {
      const suffix = chunks.length > 1 ? ` (${index + 1}/${chunks.length})` : ''
      this.log(loopId, runId, 'prompt', `${label}${suffix}:\n${chunk}`)
    }
  }

  private broadcast(loopId: string): void {
    const loop = this.ledger.getLoop(loopId)
    if (!loop) return
    const runs = this.ledger.runsForLoop(loopId)
    this.send('loop:update', { loop, runs })
    try {
      fs.writeFileSync(
        path.join(loop.workspaceDir, 'gauntlet-report.md'),
        buildReport(loop, runs, scanCritiqueArtifacts(loop.workspaceDir), scanReferencePack(loop.workspaceDir, this.referenceDir(loop.id))),
      )
    } catch {
      /* workspace may be gone; the in-app report still works */
    }
  }

  private finishLoop(loopId: string, status: 'passed' | 'exhausted' | 'stopped' | 'failed', reason: string): void {
    this.ledger.patchLoop(loopId, { status, stopReason: reason })
    this.stopRequested.delete(loopId)
    const icon = status === 'passed' ? '🏆' : status === 'failed' ? '✗' : '■'
    this.log(loopId, null, 'done', `${icon} Loop ${status}: ${reason}`)
    this.broadcast(loopId)
  }

  private async executeNext(loopId: string): Promise<void> {
    if (this.current) return
    const loop = this.ledger.getLoop(loopId)
    if (!loop || loop.status !== 'running') return
    if (this.stopRequested.has(loopId)) {
      this.finishLoop(loopId, 'stopped', 'Stopped by user.')
      return
    }
    const run = this.ledger.nextQueuedRun(loopId)
    if (!run) return
    try {
      if (run.role === 'reference') await this.executeReference(loop, run)
      else if (run.role === 'implement') await this.executeImplement(loop, run)
      else await this.executeCritique(loop, run)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.ledger.patchRun(run.id, { status: 'failed', error: message, finishedAt: new Date().toISOString() })
      this.finishLoop(loopId, 'failed', `Run crashed: ${message}`)
    }
  }

  /** Spawn a detached CLI process whose stdout/stderr stream to files. */
  private spawnDetached(
    loop: LoopRecord,
    run: RunRecord,
    command: string,
    args: string[],
    env: Record<string, string>,
  ): { meta: ProcMeta; own: ExitHolder } | null {
    const outPath = path.join(runsDir(loop.workspaceDir), `${run.id}.out.ndjson`)
    const errPath = path.join(runsDir(loop.workspaceDir), `${run.id}.err.log`)
    const own: ExitHolder = { exited: false, code: null, spawnError: null }
    let outFd: number
    let errFd: number
    try {
      outFd = fs.openSync(outPath, 'a')
      errFd = fs.openSync(errPath, 'a')
    } catch (error) {
      this.ledger.patchRun(run.id, { status: 'failed', error: `Cannot open stream files: ${String(error)}` })
      this.finishLoop(loop.id, 'failed', 'Cannot open run stream files.')
      return null
    }
    const child = spawn(command, args, { cwd: loop.workspaceDir, env, detached: true, stdio: ['ignore', outFd, errFd] })
    fs.closeSync(outFd)
    fs.closeSync(errFd)
    child.on('error', (error) => {
      own.spawnError = error.message
      own.exited = true
      own.code = -1
    })
    child.on('exit', (code) => {
      own.exited = true
      own.code = code
    })
    child.unref()
    // Every run's exact execution prompt lands in its log, round-labeled, so
    // the log alone tells the full story of what each agent was asked to do.
    this.logPrompt(loop.id, run.id, runPromptLabel(run), run.prompt)
    const meta: ProcMeta = { pid: child.pid ?? -1, outPath, errPath, startedAtMs: Date.now(), loggedOutLines: 0, loggedErrLines: 0 }
    this.writeMeta(loop.workspaceDir, run.id, meta)
    this.ledger.patchRun(run.id, { status: 'running', startedAt: new Date().toISOString() })
    this.broadcast(loop.id)
    return { meta, own }
  }

  /**
   * Tail the run's output files, feeding lines to the parser (replaying from
   * byte 0 on re-attach with already-logged lines suppressed), until the
   * process exits — then finalize.
   */
  private async driveRun(
    loop: LoopRecord,
    run: RunRecord,
    meta: ProcMeta,
    idleMs: number,
    hardCapMs: number,
    parser: StreamParser,
    gate: LogGate,
    own: ExitHolder | null,
  ): Promise<void> {
    const att: Attachment = { loopId: loop.id, runId: run.id, pid: meta.pid, timedOut: false }
    this.current = att
    const childTailer = new ChildStreamTailer(agentsDir(loop.workspaceDir), meta.startedAtMs, meta.childOffsets)
    this.childTail = { loopId: loop.id, runId: run.id, tailer: childTailer }

    let outOffset = 0
    let outRemainder = ''
    let outLine = 0
    let errOffset = 0
    let errRemainder = ''
    let errLine = 0
    let lastMetaWrite = 0
    const initialOutLogged = meta.loggedOutLines
    const initialErrLogged = meta.loggedErrLines

    const readNew = (filePath: string, offset: number): { text: string; size: number } | null => {
      try {
        const size = fs.statSync(filePath).size
        if (size <= offset) return null
        const fd = fs.openSync(filePath, 'r')
        const buf = Buffer.alloc(size - offset)
        fs.readSync(fd, buf, 0, buf.length, offset)
        fs.closeSync(fd)
        return { text: buf.toString('utf8'), size }
      } catch {
        return null
      }
    }

    const pump = (): void => {
      const out = readNew(meta.outPath, outOffset)
      if (out) {
        outOffset = out.size
        const lines = (outRemainder + out.text).split('\n')
        outRemainder = lines.pop() ?? ''
        for (const line of lines) {
          outLine += 1
          gate.suppress = outLine <= initialOutLogged
          try {
            parser.onLine(line)
          } catch {
            /* one bad line must not kill the drive loop */
          }
        }
        gate.suppress = false
        meta.loggedOutLines = Math.max(meta.loggedOutLines, outLine)
      }
      const err = readNew(meta.errPath, errOffset)
      if (err) {
        errOffset = err.size
        const lines = (errRemainder + err.text).split('\n')
        errRemainder = lines.pop() ?? ''
        for (const line of lines) {
          errLine += 1
          gate.suppress = errLine <= initialErrLogged
          if (line.trim()) parser.onStderr(line)
        }
        gate.suppress = false
        meta.loggedErrLines = Math.max(meta.loggedErrLines, errLine)
      }
      this.pumpChildStreams()
      if (Date.now() - lastMetaWrite > 1_000) {
        lastMetaWrite = Date.now()
        meta.childOffsets = childTailer.snapshot()
        this.writeMeta(loop.workspaceDir, run.id, meta)
      }
    }

    await new Promise<void>((resolve) => {
      const interval = setInterval(() => {
        pump()
        parser.tick?.()
        const now = Date.now()
        const idleFor = now - (parser.progressAt?.() ?? now)
        const stalled = idleFor > idleMs
        const overCap = now - meta.startedAtMs > hardCapMs
        if (!att.timedOut && (stalled || overCap)) {
          att.timedOut = true
          this.log(
            loop.id,
            run.id,
            'error',
            stalled
              ? `No progress for ${Math.round(idleFor / 60_000)} min — interrupting.`
              : `Run exceeded the ${Math.round(hardCapMs / 3_600_000)}h ceiling — interrupting.`,
          )
          this.interruptPid(meta.pid)
        }
        const dead = own ? own.exited : !this.pidAlive(meta.pid)
        if (dead) {
          clearInterval(interval)
          resolve()
        }
      }, 400)
    })
    await sleep(300)
    pump()
    if (outRemainder.trim()) parser.onLine(outRemainder)

    this.current = null
    // finalize may keep waiting on delegated children; their streams stay tailed until it returns.
    await parser.finalize({ code: own ? own.code : null, timedOut: att.timedOut, spawnError: own?.spawnError ?? null })
    this.pumpChildStreams()
    this.childTail = null
    try {
      fs.unlinkSync(this.metaPath(loop.workspaceDir, run.id))
    } catch {
      /* already gone */
    }
  }

  /** Session id of the newest earlier implement run in this loop, if claude reported one. */
  private lastImplementSessionId(loopId: string, exceptRunId: string): string | null {
    const prior = this.ledger
      .runsForLoop(loopId)
      .filter((r) => r.role === 'implement' && r.id !== exceptRunId && r.sessionId)
      .at(-1)
    return prior?.sessionId ?? null
  }

  /** True if the workspace has a prior claude session transcript to `--continue` from. */
  private hasClaudeSession(workspaceDir: string): boolean {
    const projectDir = path.join(cliHome('claude'), 'projects', workspaceDir.replace(/[^a-zA-Z0-9-]/g, '-'))
    try {
      return fs.readdirSync(projectDir).some((file) => file.endsWith('.jsonl'))
    } catch {
      return false
    }
  }

  // --------------------------------------------------------------- reference

  private async executeReference(loop: LoopRecord, run: RunRecord): Promise<void> {
    const models = loop.models
    this.log(
      loop.id,
      run.id,
      'system',
      `● Reference Study (${run.harness} ${models.orchestratorModel}, effort ${models.orchestratorEffort})`,
    )
    const plan = referencePlan({
      models,
      prompt: run.prompt,
      claudeHome: cliHome('claude'),
      codexHome: cliHome('codex'),
    })
    const spawned = this.spawnDetached(loop, run, plan.bin, plan.args, subscriptionEnv(plan.env))
    if (!spawned) return
    this.ledger.patchRun(run.id, { model: models.orchestratorModel })
    const gate: LogGate = { suppress: false }
    const parser = this.makeReferenceParser(loop, run, gate)
    await this.driveRun(loop, run, spawned.meta, REFERENCE_TIMEOUT_MS, REFERENCE_TIMEOUT_MS, parser, gate, spawned.own)
  }

  private makeReferenceParser(loop: LoopRecord, run: RunRecord, gate: LogGate): StreamParser {
    const model = loop.models.orchestratorModel
    const tokens = emptyTokens()
    const startedAtMs = this.readMeta(loop.workspaceDir, run.id)?.startedAtMs ?? Date.now()
    let sawUsage = false
    let failure: string | null = null
    let summary = ''
    let sessionId: string | null = this.ledger.getRun(run.id)?.sessionId ?? null
    const plog = (kind: string, text: string): void => {
      if (!gate.suppress) this.log(loop.id, run.id, kind, text)
    }
    const flush = (): void => {
      const costUsd = estimateCostUsd(model, tokens)
      const agent: AgentMetric = {
        id: 'reference',
        label: 'reference researcher',
        model,
        messages: 1,
        tokens: { ...tokens },
        firstTs: new Date(startedAtMs).toISOString(),
        lastTs: new Date().toISOString(),
      }
      this.ledger.patchRun(run.id, {
        inputTokens: tokens.input + tokens.cacheRead + tokens.cacheWrite,
        outputTokens: tokens.output,
        costUsd,
        metrics: { agents: [agent], perModel: { [model]: { costUsd, tokens: { ...tokens } } } },
      })
      this.broadcast(loop.id)
    }
    const onClaudeLine = (line: string): void => {
      const t = translateClaudeLine(line)
      if (!t) return
      if (t.init) {
        sessionId = t.init.sessionId ?? sessionId
        this.ledger.patchRun(run.id, { sessionId })
        plog('system', `claude session ${sessionId?.slice(0, 8) ?? '?'} · model ${t.init.model ?? model}`)
      }
      if (t.usage) {
        sawUsage = true
        tokens.input += t.usage.usage.input_tokens ?? 0
        tokens.output += t.usage.usage.output_tokens ?? 0
        tokens.cacheRead += t.usage.usage.cache_read_input_tokens ?? 0
        tokens.cacheWrite += t.usage.usage.cache_creation_input_tokens ?? 0
        flush()
      }
      for (const event of t.events) plog(event.kind, `[reference] ${event.text}`)
      if (t.summary !== undefined) summary = t.summary
      if (t.result) {
        if (t.result.text !== null) summary = t.result.text
        const usage = t.result.usage
        if (usage) {
          sawUsage = true
          tokens.input = usage.input_tokens ?? tokens.input
          tokens.output = usage.output_tokens ?? tokens.output
          tokens.cacheRead = usage.cache_read_input_tokens ?? tokens.cacheRead
          tokens.cacheWrite = usage.cache_creation_input_tokens ?? tokens.cacheWrite
        }
        if (t.result.isError) failure = t.result.text !== null ? trunc(t.result.text, 400) : 'claude reference study failed'
      }
    }
    const onCodexLine = (line: string): void => {
      const t = translateCodexLine(line)
      if (!t) return
      if (t.threadStarted !== undefined) {
        sessionId = t.threadStarted ?? sessionId
        this.ledger.patchRun(run.id, { sessionId })
        plog('system', `codex thread ${sessionId?.slice(0, 8) ?? '?'}`)
      }
      for (const event of t.events) plog(event.kind, `[reference] ${event.text}`)
      if (t.summary !== undefined) summary = t.summary
      if (t.turn?.usage) {
        sawUsage = true
        const turn = codexTokens(t.turn.usage)
        tokens.input += turn.input
        tokens.output += turn.output
        tokens.cacheRead += turn.cacheRead
        tokens.cacheWrite += turn.cacheWrite
        flush()
      }
      if (t.error) {
        failure = t.error
        plog('error', failure)
      }
    }
    const finalize = (exit: ExitInfo): void => {
      const durationMs = Date.now() - startedAtMs
      const costUsd = sawUsage ? estimateCostUsd(model, tokens) : null
      const pack = scanReferencePack(loop.workspaceDir, this.referenceDir(loop.id))
      const processError = exit.spawnError ?? failure ?? (exit.code !== 0 && exit.code !== null ? `${run.harness} exited ${exit.code}` : null)
      const artifactError = pack.ready ? null : pack.issues.join('; ')
      this.ledger.patchRun(run.id, {
        inputTokens: sawUsage ? tokens.input + tokens.cacheRead + tokens.cacheWrite : null,
        outputTokens: sawUsage ? tokens.output : null,
        costUsd,
        durationMs,
        sessionId,
        summary: summary ? summary.slice(0, 4000) : null,
        finishedAt: new Date().toISOString(),
      })
      this.accumulateCost(loop.id, costUsd)
      this.log(loop.id, run.id, 'metric', `▤ reference metrics: ${costUsd != null ? `$${costUsd.toFixed(2)} equiv (table est) · ` : ''}in ${formatTokens(tokens.input + tokens.cacheRead)} · out ${formatTokens(tokens.output)} · ${Math.round(durationMs / 60_000)}m`)
      const stopReason = this.stopRequested.has(loop.id) ? 'user' : exit.timedOut ? 'timeout' : null
      if (stopReason) {
        this.ledger.patchRun(run.id, { status: 'cancelled', error: stopReason === 'user' ? 'Stopped by user.' : 'Timed out.' })
        this.finishLoop(loop.id, 'stopped', stopReason === 'user' ? 'Stopped by user.' : 'Reference Study timed out.')
        return
      }
      if (processError || artifactError) {
        const error = processError ?? artifactError!
        this.ledger.patchRun(run.id, { status: 'failed', error })
        const attempts = this.ledger.runsForLoop(loop.id).filter((item) => item.role === 'reference').length
        if (attempts < MAX_REFERENCE_ATTEMPTS) {
          this.log(loop.id, run.id, 'system', `Reference Study incomplete (${error}) — retrying and preserving downloaded files.`)
          this.ledger.createRun({
            loopId: loop.id,
            round: 0,
            role: 'reference',
            harness: harnessFor(model),
            prompt: buildReferencePrompt(loop.prompt, this.referenceDir(loop.id), researchRules(loop.models, this.referenceDir(loop.id))),
          })
          this.broadcast(loop.id)
          void this.executeNext(loop.id)
          return
        }
        this.finishLoop(loop.id, 'failed', `Reference Study failed twice: ${error}`)
        return
      }
      this.ledger.patchRun(run.id, { status: 'succeeded' })
      this.log(loop.id, run.id, 'shot', `▦ Reference Pack ready: ${pack.images.length} stills · ${pack.motion.length} motion frames · ${pack.journey.length} journey shots · ${pack.videos.length} video → ${pack.root}/`)
      if (this.overBudget(loop.id)) return
      this.ledger.patchLoop(loop.id, { round: 1 })
      this.ledger.createRun({
        loopId: loop.id,
        round: 1,
        role: 'implement',
        harness: harnessFor(model),
        prompt: buildImplementPrompt(loop.models, loop.prompt, 1, null, this.referenceDir(loop.id)),
      })
      this.log(loop.id, null, 'system', 'Reference Pack frozen — round 1 queued.')
      this.broadcast(loop.id)
      void this.executeNext(loop.id)
    }
    return {
      onLine: run.harness === 'claude' ? onClaudeLine : onCodexLine,
      onStderr: (text) => plog('stderr', trunc(text, 400)),
      finalize,
    }
  }

  // ---------------------------------------------------------------- implement

  private async executeImplement(loop: LoopRecord, run: RunRecord): Promise<void> {
    const models = loop.models
    const harness = harnessFor(models.orchestratorModel)
    const agentMd = implementerAgentMd(models, this.referenceDir(loop.id))
    if (agentMd) {
      const agentDir = path.join(loop.workspaceDir, '.claude', 'agents')
      fs.mkdirSync(agentDir, { recursive: true })
      fs.writeFileSync(path.join(agentDir, 'implementer.md'), agentMd)
    }
    // Rewrite the contract and the gate every round. The gate is the one file
    // in the workspace a worker has an incentive to weaken, and a gate that
    // can be edited to pass is not a gate.
    const scaffold = scaffoldEngine(loop.workspaceDir)
    if (scaffold.refreshed.length) {
      this.log(loop.id, run.id, 'system', `Restored app-owned files: ${scaffold.refreshed.join(', ')}.`)
    }
    // Delegated workers write their streams here. Clearing the directory keeps
    // last round's children out of this round's metrics and liveness check.
    fs.rmSync(agentsDir(loop.workspaceDir), { recursive: true, force: true })
    fs.mkdirSync(agentsDir(loop.workspaceDir), { recursive: true })

    const priorSessionId = this.lastImplementSessionId(loop.id, run.id)
    const canResume = harness === 'claude' ? priorSessionId != null || this.hasClaudeSession(loop.workspaceDir) : priorSessionId != null
    const isResume = run.prompt.startsWith(RESUME_PREFIX) && canResume
    const prompt = isResume
      ? 'The app running you was restarted and your previous session was interrupted. Continue exactly where you left off. First audit what already landed on disk; do NOT redo completed work — dispatch workers only for the remaining gaps, telling each one to read the existing code in its slice before writing. Same rules apply.'
      : run.prompt.startsWith(RESUME_PREFIX)
        ? run.prompt.slice(RESUME_PREFIX.length)
        : run.prompt

    this.log(
      loop.id,
      run.id,
      'system',
      `● Round ${run.round} — implement (${harness} ${models.orchestratorModel}, effort ${models.orchestratorEffort})${isResume ? ' — continuing interrupted session' : ''}`,
    )
    const plan = implementPlan({
      models,
      prompt,
      claudeHome: cliHome('claude'),
      codexHome: cliHome('codex'),
      resumeId: isResume ? priorSessionId : null,
      resumeLatest: isResume && !priorSessionId,
    })
    const spawned = this.spawnDetached(loop, run, plan.bin, plan.args, subscriptionEnv(plan.env))
    if (!spawned) return
    const gate: LogGate = { suppress: false }
    const parser =
      harness === 'claude' ? this.makeImplementParser(loop, run, gate) : this.makeCodexImplementParser(loop, run, gate)
    await this.driveRun(loop, run, spawned.meta, IMPLEMENT_IDLE_MS, IMPLEMENT_HARD_CAP_MS, parser, gate, spawned.own)
  }

  /**
   * Hold the round open while delegated workers are still writing.
   *
   * An orchestrator can finish its turn with children still running — a claude
   * one will not sit and wait, and on a real round it said "still waiting on
   * the codex runs" and exited, which committed a half-written build eight
   * minutes before codex finished. Waiting is the app's job, not an agent's.
   */
  private async awaitChildren(loop: LoopRecord, run: RunRecord): Promise<void> {
    const deadline = Date.now() + IMPLEMENT_HARD_CAP_MS
    let announced = false
    while (childrenActive(loop.workspaceDir, CHILD_QUIET_MS) && Date.now() < deadline) {
      if (!announced) {
        announced = true
        this.log(loop.id, run.id, 'system', '⏳ orchestrator finished, delegated workers still running — holding the round open.')
      }
      await sleep(15_000)
      this.pumpChildStreams()
    }
    if (announced) this.log(loop.id, run.id, 'system', '✓ delegated workers finished.')
  }

  private makeImplementParser(loop: LoopRecord, run: RunRecord, gate: LogGate): StreamParser {
    const plog = (kind: string, text: string): void => {
      if (!gate.suppress) this.log(loop.id, run.id, kind, text)
    }
    const agentLabels = new Map<string, { label: string; model: string | null }>()
    const finishedAgents = new Set<string>()
    // The CLI now launches subagents in the background: the Agent tool_result
    // comes back within a millisecond saying "launched", and the real ending
    // arrives much later as a system/task_notification. Treating that launch
    // receipt as completion marked every agent done the instant it started.
    const backgrounded = new Set<string>()
    /** Tracked tasks that are shell commands, not agents. */
    const notAgents = new Set<string>()
    /**
     * slice → the agent whose tool call launched that delegated worker.
     *
     * A cross-harness worker is a process the app never started, so nothing
     * links it to its owner except the command that started it: the redirect
     * into `.gauntlet-loop/agents/<slice>.<harness>.jsonl` names the slice, and
     * the tool call carrying it names the agent. Without this every delegated
     * worker hung off the bottom of the list instead of under its dispatcher.
     */
    const childParents = new Map<string, string>()
    const msgUsage = new Map<string, { agentKey: string; model: string | null; usage: Record<string, number>; ts: string }>()
    let result: Record<string, unknown> | null = null
    let fallbackId = 0
    let lastTokenFlush = Date.now()
    let liveCostEstimate: number | null = null
    // Filled from the init event; without it we cannot locate the workflow dir.
    let sessionId: string | null = this.ledger.getRun(run.id)?.sessionId ?? null
    let workflowAgents: AgentMetric[] = []
    let childAgents: AgentMetric[] = []
    let workflowRuns: WorkflowRunSummary[] = []
    let workflowTokens = 0
    const loggedWorkflowRuns = new Set<string>()

    let tail: WorkflowTail | null = null

    // Last state we logged per agent, so a poll only reports what changed.
    const loggedAgents = new Map<string, { done: boolean; lastToolAt: number; tools: number }>()

    const logWorkflowActivity = (agents: AgentMetric[]): void => {
      for (const agent of agents) {
        const seen = loggedAgents.get(agent.id)
        if (!seen) {
          loggedAgents.set(agent.id, { done: false, lastToolAt: 0, tools: agent.toolCalls ?? 0 })
          plog('spawn', `⇉ [${agent.phase ?? 'workflow'}] "${agent.label}" started (${agent.model ?? '?'})`)
          continue
        }
        if (agent.state === 'done' && !seen.done) {
          seen.done = true
          plog(
            'spawn',
            `⇊ "${agent.label}" finished — ${agent.costUsd != null ? `$${agent.costUsd.toFixed(2)} · ` : ''}${agent.toolCalls ?? 0} tools · ${formatTokens(agent.totalTokens ?? 0)} tokens`,
          )
          if (agent.note) plog('agent', `  [${agent.label}] ${trunc(agent.note, 300)}`)
          continue
        }
        // While an agent works, report what it is doing at most once a minute —
        // thirteen agents each logging every tool call would bury the feed.
        if (agent.state !== 'done' && agent.lastTool && (agent.toolCalls ?? 0) > seen.tools && Date.now() - seen.lastToolAt > 60_000) {
          seen.lastToolAt = Date.now()
          seen.tools = agent.toolCalls ?? 0
          plog('tool', `  [${agent.label}] → ${agent.lastTool} (${agent.toolCalls} tools · ${formatTokens(agent.totalTokens ?? 0)} tokens)`)
        }
      }
    }

    const pollWorkflows = (): void => {
      if (!sessionId) return
      // Live agent state comes from the transcripts the runtime appends as it
      // works; the wf_*.json summary only lands when a workflow ends, and is
      // read for the run status and phase names it carries.
      tail ??= new WorkflowTail(workflowTailDir(cliHome('claude'), loop.workspaceDir, sessionId))
      const live = tail.poll()
      const progress = readWorkflowProgress(workflowDir(cliHome('claude'), loop.workspaceDir, sessionId))
      const phaseById = new Map(progress.agents.map((a) => [a.id.split(':').at(-1), a.phase]))
      workflowAgents = live.map((a) => ({ ...a, phase: a.phase ?? phaseById.get(a.id.split(':').at(-1)) }))
      workflowRuns = progress.runs
      workflowTokens = live.reduce((sum, a) => sum + (a.totalTokens ?? 0), 0) || progress.totalTokens
      logWorkflowActivity(workflowAgents)
      for (const wf of progress.runs) {
        const key = `${wf.runId}:${wf.status}`
        if (loggedWorkflowRuns.has(key)) continue
        loggedWorkflowRuns.add(key)
        plog('spawn', `⇉ workflow "${wf.name}" ${wf.status} — ${wf.agentCount} agents · ${formatTokens(wf.totalTokens)} tokens`)
      }
    }

    // Codex subagents spend outside Claude's accounting entirely, so their
    // tokens are read from codex's own session logs. Cumulative per session, so
    // this replaces the previous figures rather than adding to them.
    const startedAtMs = this.readMeta(loop.workspaceDir, run.id)?.startedAtMs ?? Date.now()
    const pollChildren = (): void => {
      if (!isCrossHarness(loop.models)) return
      childAgents = readChildAgents(loop.workspaceDir, loop.models.subagentModel, cliHome('codex'))
    }

    // Live token + cost visibility: persist running totals every ~15s so the
    // ledger, dashboard, and report show tokens and estimated cost mid-run.
    const flushTokens = (force = false): void => {
      if (!force && Date.now() - lastTokenFlush < 15_000) return
      lastTokenFlush = Date.now()
      pollWorkflows()
      pollChildren()
      let input = 0
      let output = 0
      const perModel = new Map<string, TokenTotals>()
      for (const { usage, model } of msgUsage.values()) {
        const t = perModel.get(model ?? loop.models.orchestratorModel) ?? emptyTokens()
        t.input += usage.input_tokens ?? 0
        t.output += usage.output_tokens ?? 0
        t.cacheRead += usage.cache_read_input_tokens ?? 0
        t.cacheWrite += usage.cache_creation_input_tokens ?? 0
        perModel.set(model ?? loop.models.orchestratorModel, t)
        input += (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0)
        output += usage.output_tokens ?? 0
      }
      liveCostEstimate = null
      for (const [model, t] of perModel) {
        const cost = estimateCostUsd(model, t)
        if (cost != null) liveCostEstimate = (liveCostEstimate ?? 0) + cost
      }
      // The message stream carries the orchestrator only. While a fan-out is
      // running that is a tiny fraction of the spend — $1.50 against $87 of
      // agent work on one round — so add what the agents' own transcripts say.
      // At finalize this is replaced by the CLI's modelUsage, which already
      // counts them, so the two are never added together.
      for (const agent of [...workflowAgents, ...childAgents]) {
        if (agent.costUsd != null) liveCostEstimate = (liveCostEstimate ?? 0) + agent.costUsd
        input += agent.tokens.input + agent.tokens.cacheRead + agent.tokens.cacheWrite
        output += agent.tokens.output
      }
      this.ledger.patchRun(run.id, {
        inputTokens: input,
        outputTokens: output,
        costUsd: liveCostEstimate,
        metrics: this.buildImplementMetrics(loop.models, agentLabels, msgUsage, null, finishedAgents, workflowAgents, childAgents, childParents),
      })
      this.broadcast(loop.id)
    }

    const onLine = (line: string): void => {
      if (!line.trim()) return
      lastProgressAt = Date.now()
      let obj: Record<string, unknown>
      try {
        obj = JSON.parse(line) as Record<string, unknown>
      } catch {
        return
      }
      const type = obj.type as string
      const parentId = (obj.parent_tool_use_id as string | null) ?? null
      const agentKey = parentId ?? 'orchestrator'
      const who = parentId ? (agentLabels.get(parentId)?.label ?? `agent-${parentId.slice(-6)}`) : 'orchestrator'

      if (type === 'system' && obj.subtype === 'init') {
        const model = obj.model as string | undefined
        sessionId = (obj.session_id as string | undefined) ?? sessionId
        if (model || sessionId) this.ledger.patchRun(run.id, { ...(model ? { model } : {}), ...(sessionId ? { sessionId } : {}) })
        plog('system', `session ${sessionId?.slice(0, 8) ?? '?'} · model ${model ?? '?'}`)
        return
      }
      // The CLI raises task_started/task_notification for every tracked task,
      // shell commands included — `task_type: 'local_bash'` outnumbered real
      // agents ten to one on a real round, and each one logged as a subagent.
      // Only `local_agent` is an agent; the notification carries no task_type,
      // so the shell ones have to be remembered from their start event.
      if (type === 'system' && (obj.subtype === 'task_started' || obj.subtype === 'task_notification')) {
        const toolUseId = obj.tool_use_id as string | undefined
        if (!toolUseId) return
        if (obj.subtype === 'task_started') {
          // Two ways to be an agent: the CLI says so, or we watched the
          // orchestrator call the Agent tool with this id. Anything else is a
          // shell command wearing a task notice.
          if (obj.task_type !== 'local_agent' && !agentLabels.has(toolUseId)) {
            notAgents.add(toolUseId)
            return
          }
          if (obj.is_backgrounded) backgrounded.add(toolUseId)
          if (!agentLabels.has(toolUseId)) {
            agentLabels.set(toolUseId, { label: trunc((obj.description as string | undefined) ?? 'subagent', 30), model: null })
          }
          return
        }
        if (notAgents.has(toolUseId) || finishedAgents.has(toolUseId)) return
        finishedAgents.add(toolUseId)
        const label = agentLabels.get(toolUseId)?.label ?? `agent-${toolUseId.slice(-6)}`
        plog('spawn', `⇊ subagent "${label}" ${(obj.status as string | undefined) ?? 'finished'}`)
        return
      }
      if (type === 'assistant') {
        const message = obj.message as Record<string, unknown> | undefined
        if (!message) return
        const msgId = (message.id as string | undefined) ?? `noid-${fallbackId++}`
        if (message.usage && typeof message.usage === 'object') {
          msgUsage.set(msgId, {
            agentKey,
            model: (message.model as string | undefined) ?? null,
            usage: message.usage as Record<string, number>,
            ts: new Date().toISOString(),
          })
          flushTokens()
        }
        // Register spawns before displaying: the translator narrates them, but
        // only this parser tracks the tool_use id that later events reference.
        const content = Array.isArray(message.content) ? (message.content as Record<string, unknown>[]) : []
        for (const block of content) {
          if (block.type !== 'tool_use') continue
          const name = block.name as string
          const input = block.input as Record<string, unknown> | undefined
          if ((name === 'Agent' || name === 'Task') && block.id) {
            const label = trunc((input?.description as string | undefined) ?? (input?.subagent_type as string | undefined) ?? 'subagent', 30)
            const model = (input?.model as string | undefined) ?? null
            agentLabels.set(block.id as string, { label, model })
          } else {
            const raw = input ? JSON.stringify(input) : ''
            const stream = /agents[\\/]+([^/'"\s\\]+)\.(?:claude|codex)\.jsonl/.exec(raw)
            if (stream && parentId) childParents.set(stream[1], parentId)
          }
        }
        for (const event of translateClaudeLine(line)?.events ?? []) {
          plog(event.kind === 'claude' && parentId ? 'agent' : event.kind, `[${who}] ${event.text}`)
        }
        return
      }
      if (type === 'user') {
        const message = obj.message as Record<string, unknown> | undefined
        const content = Array.isArray(message?.content) ? (message?.content as Record<string, unknown>[]) : []
        for (const block of content) {
          if (block.type !== 'tool_result') continue
          const toolUseId = block.tool_use_id as string | undefined
          if (toolUseId && agentLabels.has(toolUseId) && !backgrounded.has(toolUseId) && !finishedAgents.has(toolUseId)) {
            finishedAgents.add(toolUseId)
            plog('spawn', `⇊ subagent "${agentLabels.get(toolUseId)!.label}" finished`)
          }
        }
        for (const event of translateClaudeLine(line)?.events ?? []) plog(event.kind, `[${who}] ${event.text}`)
        return
      }
      if (type === 'result') {
        result = obj
      }
    }

    const finalize = async (exit: ExitInfo): Promise<void> => {
      await this.finishImplement(loop, run, exit, () => {
        pollWorkflows()
        pollChildren()
        const metrics = this.buildImplementMetrics(loop.models, agentLabels, msgUsage, result, finishedAgents, workflowAgents, childAgents, childParents)
        if (workflowRuns.length) {
          plog(
            'metric',
            `▤ workflow fan-out: ${workflowRuns.length} workflow${workflowRuns.length === 1 ? '' : 's'} · ${workflowAgents.length} agents · ${formatTokens(workflowTokens)} tokens`,
          )
        }
        const res = result as Record<string, unknown> | null
        const usage = (res?.usage as Record<string, number> | undefined) ?? undefined
        const succeeded = res !== null && res.is_error !== true && (exit.code === 0 || exit.code === null)
        return {
          metrics,
          costUsd: implementCostUsd(
            metrics.perModel,
            typeof res?.total_cost_usd === 'number' ? (res.total_cost_usd as number) : null,
            liveCostEstimate,
          ),
          tokens: implementTokens(metrics.perModel, usage),
          numTurns: typeof res?.num_turns === 'number' ? (res.num_turns as number) : null,
          sessionId: (res?.session_id as string | undefined) ?? null,
          summary: typeof res?.result === 'string' ? (res.result as string).slice(0, 4000) : null,
          error: succeeded
            ? null
            : (exit.spawnError ??
              (typeof res?.result === 'string'
                ? trunc(res.result as string, 400)
                : `claude exited ${exit.code}${res ? ` (${res.subtype})` : ' without a result'}`)),
          logResult: res,
        }
      })
    }

    let lastProgressAt = Date.now()
    let lastWorkflowFootprint = ''
    let lastTick = 0
    const tick = (): void => {
      if (Date.now() - lastTick < 10_000) return
      lastTick = Date.now()
      const before = workflowAgents.length + childAgents.length
      pollWorkflows()
      pollChildren()
      // Any agent gaining tokens or tool calls counts as the run progressing.
      const footprint = [...workflowAgents, ...childAgents].map((a) => `${a.id}:${a.totalTokens}:${a.toolCalls}:${a.state}`).join('|')
      if (footprint !== lastWorkflowFootprint) {
        lastWorkflowFootprint = footprint
        lastProgressAt = Date.now()
      }
      if (workflowAgents.length + childAgents.length === 0 && before === 0) return
      flushTokens(true)
    }

    return { onLine, onStderr: (text) => plog('stderr', trunc(text, 400)), tick, progressAt: () => lastProgressAt, finalize }
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
  private makeCodexImplementParser(loop: LoopRecord, run: RunRecord, gate: LogGate): StreamParser {
    const plog = (kind: string, text: string): void => {
      if (!gate.suppress) this.log(loop.id, run.id, kind, text)
    }
    const models = loop.models
    const startedAtMs = this.readMeta(loop.workspaceDir, run.id)?.startedAtMs ?? Date.now()
    const tokens = emptyTokens()
    let threadId: string | null = null
    let lastAgentMessage = ''
    let failure: string | null = null
    let turns = 0
    let workers: AgentMetric[] = []
    let lastFlush = Date.now()
    let lastProgressAt = Date.now()

    const pollWorkers = (): void => {
      // Codex's own subagent threads, minus the orchestrator's own thread,
      // plus any claude workers this run delegated to a separate CLI.
      const spawned = readCodexUsage(cliHome('codex'), startedAtMs, models.subagentModel ?? models.orchestratorModel, threadId)
      const delegated = isCrossHarness(models) ? readChildAgents(loop.workspaceDir, models.subagentModel, cliHome('codex')) : []
      workers = [...spawned, ...delegated]
    }

    const metricsNow = (): RunMetrics => {
      const orchestrator: AgentMetric = {
        id: 'orchestrator',
        label: 'orchestrator',
        model: models.orchestratorModel,
        messages: turns,
        tokens,
        firstTs: new Date(startedAtMs).toISOString(),
        lastTs: new Date().toISOString(),
        costUsd: estimateCostUsd(models.orchestratorModel, tokens),
      }
      const perModel: RunMetrics['perModel'] = {}
      for (const agent of [orchestrator, ...workers]) {
        const key = agent.model ?? models.orchestratorModel
        const entry = perModel[key] ?? { costUsd: 0, tokens: emptyTokens() }
        entry.tokens.input += agent.tokens.input
        entry.tokens.output += agent.tokens.output
        entry.tokens.cacheRead += agent.tokens.cacheRead
        entry.tokens.cacheWrite += agent.tokens.cacheWrite
        entry.costUsd = estimateCostUsd(key, entry.tokens)
        perModel[key] = entry
      }
      return { agents: [orchestrator, ...workers], perModel }
    }

    const flush = (force = false): void => {
      if (!force && Date.now() - lastFlush < 15_000) return
      lastFlush = Date.now()
      pollWorkers()
      const metrics = metricsNow()
      const totals = implementTokens(metrics.perModel, undefined)
      this.ledger.patchRun(run.id, {
        metrics,
        inputTokens: totals?.input,
        outputTokens: totals?.output,
        costUsd: Object.values(metrics.perModel).reduce((sum, m) => sum + (m.costUsd ?? 0), 0),
      })
      this.broadcast(loop.id)
    }

    const onLine = (line: string): void => {
      if (!line.trim()) return
      lastProgressAt = Date.now()
      const t = translateCodexLine(line)
      if (!t) return
      if (t.threadStarted !== undefined) {
        threadId = t.threadStarted
        this.ledger.patchRun(run.id, { sessionId: threadId })
        plog('system', `codex thread ${threadId?.slice(0, 8) ?? '?'}`)
      }
      for (const event of t.events) plog(event.kind, event.text)
      if (t.summary !== undefined) lastAgentMessage = t.summary
      if (t.turn) {
        const turn = codexTokens(t.turn.usage)
        tokens.input += turn.input
        tokens.output += turn.output
        tokens.cacheRead += turn.cacheRead
        tokens.cacheWrite += turn.cacheWrite
        turns += 1
        flush(true)
      }
      if (t.error) {
        failure = t.error
        plog('error', failure)
      }
    }

    const finalize = async (exit: ExitInfo): Promise<void> => {
      await this.finishImplement(loop, run, exit, () => {
        pollWorkers()
        const metrics = metricsNow()
        const failed = failure ?? exit.spawnError ?? (exit.code !== 0 && exit.code !== null ? `codex exited ${exit.code}` : null)
        return {
          metrics,
          costUsd: Object.values(metrics.perModel).reduce((sum, m) => sum + (m.costUsd ?? 0), 0),
          tokens: implementTokens(metrics.perModel, undefined),
          numTurns: turns,
          sessionId: threadId,
          summary: lastAgentMessage ? lastAgentMessage.slice(0, 4000) : null,
          error: failed,
          logResult: null,
        }
      })
    }

    return {
      onLine,
      onStderr: (text) => plog('stderr', trunc(text, 400)),
      tick: () => flush(),
      progressAt: () => lastProgressAt,
      finalize,
    }
  }

  private async finishImplement(
    loop: LoopRecord,
    run: RunRecord,
    exit: ExitInfo,
    collect: () => ImplementOutcome,
  ): Promise<void> {
    // Counted after the wait, so a worker that outlived the orchestrator is in
    // the round's totals rather than missing from them.
    await this.awaitChildren(loop, run)
    const out = collect()
    this.ledger.patchRun(run.id, {
      metrics: out.metrics,
      costUsd: out.costUsd,
      inputTokens: out.tokens?.input,
      outputTokens: out.tokens?.output,
      numTurns: out.numTurns,
      // A CLI's own duration restarts whenever it re-inits mid-run: a 150-minute
      // run reported 3m16s, the time since its last init event. Our own start
      // time is the only one that spans the whole run.
      durationMs: Date.now() - (this.readMeta(loop.workspaceDir, run.id)?.startedAtMs ?? Date.parse(run.startedAt ?? run.createdAt)),
      sessionId: out.sessionId,
      summary: out.summary,
      finishedAt: new Date().toISOString(),
    })
    this.logRunMetrics(loop.id, run.id, 'implement', out.costUsd, out.logResult, out.metrics)
    this.accumulateCost(loop.id, out.costUsd)

    const stopReason = this.stopRequested.has(loop.id) ? 'user' : exit.timedOut ? 'timeout' : null
    if (stopReason) {
      this.ledger.patchRun(run.id, { status: 'cancelled', error: stopReason === 'user' ? 'Stopped by user.' : 'Timed out.' })
      this.finishLoop(loop.id, 'stopped', stopReason === 'user' ? 'Stopped by user.' : 'Implement run timed out.')
      return
    }
    if (out.error) {
      const rateLimited = /rate.?limit|usage limit|out of extra usage/i.test(out.error)
      this.ledger.patchRun(run.id, { status: 'failed', error: out.error })
      this.finishLoop(
        loop.id,
        'stopped',
        rateLimited
          ? `Rate limited — wait for the window to reset, then start a new run in the same workspace. (${out.error})`
          : `Implement run failed: ${out.error}`,
      )
      return
    }
    try {
      const parentRevision = this.ledger
        .runsForLoop(loop.id)
        .filter((prior) => prior.role === 'implement' && prior.round < run.round && prior.revision)
        .at(-1)?.revision
      const revision = captureRoundRevision({
        workspaceDir: loop.workspaceDir,
        loopId: loop.id,
        round: run.round,
        parentRevision,
      })
      this.ledger.patchRun(run.id, { status: 'succeeded', revision })
      this.log(loop.id, run.id, 'system', `Round ${run.round} committed at ${revision.slice(0, 12)}.`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.ledger.patchRun(run.id, { status: 'failed', error: `Could not commit round revision: ${message}` })
      this.finishLoop(loop.id, 'failed', `Round ${run.round} finished, but its Git revision could not be saved: ${message}`)
      return
    }
    if (this.overBudget(loop.id)) return
    // A verdict only earns its cost by gating another round. On the last one
    // there is no round left to gate, so the loop ends with the build itself.
    if (run.round >= loop.maxRounds) {
      this.finishLoop(loop.id, 'exhausted', `Max rounds (${loop.maxRounds}) reached after round ${run.round} — no critique, since no round is left for it to gate.`)
      return
    }
    this.ledger.createRun({
      loopId: loop.id,
      round: run.round,
      role: 'critique',
      harness: loop.models.criticHarness,
      prompt: buildCriticPrompt(loop.prompt, run.round, this.referenceDir(loop.id), engineGateRules()),
    })
    this.broadcast(loop.id)
    void this.executeNext(loop.id)
  }

  private buildImplementMetrics(
    models: LoopModels,
    agentLabels: Map<string, { label: string; model: string | null }>,
    msgUsage: Map<string, { agentKey: string; model: string | null; usage: Record<string, number>; ts: string }>,
    result: Record<string, unknown> | null,
    finished: Set<string> = new Set(),
    workflowAgents: AgentMetric[] = [],
    childAgents: AgentMetric[] = [],
    childParents: Map<string, string> = new Map(),
  ): RunMetrics {
    const agents = new Map<string, AgentMetric>()
    const ensure = (key: string): AgentMetric => {
      let agent = agents.get(key)
      if (!agent) {
        const reg = agentLabels.get(key)
        // On a cross-harness run these subagents write no code — each one
        // only launches the other CLI — so the row says so rather than reading as a
        // claude worker that quietly ignored the picked model.
        const dispatches = key !== 'orchestrator' && isCrossHarness(models)
        agent = {
          id: key,
          label:
            key === 'orchestrator'
              ? 'orchestrator'
              : `${reg?.label ?? `subagent ${key.slice(-6)}`}${dispatches ? ' (dispatcher)' : ''}`,
          // A dispatcher is a claude subagent whatever the workers are, so its
          // fallback is the model implementer.md pins it to — never the codex
          // model, which claude cannot run as a subagent.
          model:
            key === 'orchestrator'
              ? models.orchestratorModel
              : (reg?.model ?? (dispatches ? DISPATCHER_MODEL : (models.subagentModel ?? models.orchestratorModel))),
          messages: 0,
          tokens: emptyTokens(),
          firstTs: null,
          lastTs: null,
        }
        agents.set(key, agent)
      }
      return agent
    }
    ensure('orchestrator')
    // Seed from the spawn registry, not just from messages: a backgrounded agent
    // can start and finish without a single assistant message reaching this
    // stream, and it still belongs in the list.
    for (const key of agentLabels.keys()) ensure(key)
    for (const { agentKey, model, usage, ts } of msgUsage.values()) {
      const agent = ensure(agentKey)
      agent.messages += 1
      if (model && agent.id !== 'orchestrator') agent.model = model
      agent.tokens.input += usage.input_tokens ?? 0
      agent.tokens.output += usage.output_tokens ?? 0
      agent.tokens.cacheRead += usage.cache_read_input_tokens ?? 0
      agent.tokens.cacheWrite += usage.cache_creation_input_tokens ?? 0
      if (!agent.firstTs || ts < agent.firstTs) agent.firstTs = ts
      if (!agent.lastTs || ts > agent.lastTs) agent.lastTs = ts
    }
    const perModel: RunMetrics['perModel'] = {}
    const modelUsage = result?.modelUsage as Record<string, Record<string, number>> | undefined
    if (modelUsage) {
      for (const [model, mu] of Object.entries(modelUsage)) {
        perModel[model] = {
          costUsd: typeof mu.costUSD === 'number' ? mu.costUSD : null,
          tokens: {
            input: mu.inputTokens ?? 0,
            output: mu.outputTokens ?? 0,
            cacheRead: mu.cacheReadInputTokens ?? 0,
            cacheWrite: mu.cacheCreationInputTokens ?? 0,
          },
        }
      }
    }
    // Delegated workers carry a real input/output/cache split, so unlike
    // workflow agents they can be priced into perModel — which is what implementCostUsd
    // sums for the headline figure, so their spend reaches the budget ceiling.
    if (childAgents.length && models.subagentModel) {
      const tokens = emptyTokens()
      for (const agent of childAgents) {
        tokens.input += agent.tokens.input
        tokens.output += agent.tokens.output
        tokens.cacheRead += agent.tokens.cacheRead
        tokens.cacheWrite += agent.tokens.cacheWrite
      }
      perModel[models.subagentModel] = { costUsd: estimateCostUsd(models.subagentModel, tokens), tokens }
    }
    for (const [key, agent] of agents) {
      if (key !== 'orchestrator') agent.done = finished.has(key)
    }
    const list = [...agents.values()]
    // '\uffff' keeps agents that never spoke at the end, in spawn order.
    list.sort((a, b) => (a.id === 'orchestrator' ? -1 : b.id === 'orchestrator' ? 1 : (a.firstTs ?? '\uffff').localeCompare(b.firstTs ?? '\uffff')))
    // A delegated worker sits under whoever launched it; one nobody claims
    // stays at the end of the list.
    const byParent = new Map<string, AgentMetric[]>()
    const orphans: AgentMetric[] = []
    for (const child of childAgents) {
      const parent = childParents.get(child.id.replace(/^child:/, ''))
      child.parentId = parent
      if (parent && agents.has(parent)) byParent.set(parent, [...(byParent.get(parent) ?? []), child])
      else orphans.push(child)
    }
    const nested = list.flatMap((agent) => [agent, ...(byParent.get(agent.id) ?? [])])
    // Workflow agents carry only a scalar token count, so they cannot join
    // perModel — that stays priced off the stream and the CLI's own figures.
    return { agents: [...nested, ...workflowAgents, ...orphans], perModel }
  }

  private logRunMetrics(
    loopId: string,
    runId: string,
    role: string,
    costUsd: number | null,
    res: Record<string, unknown> | null,
    metrics: RunMetrics,
  ): void {
    const duration = typeof res?.duration_ms === 'number' ? `${Math.round((res.duration_ms as number) / 60_000)}m` : '?'
    const turns = typeof res?.num_turns === 'number' ? res.num_turns : '?'
    this.log(loopId, runId, 'metric', `▤ ${role} metrics: ${costUsd !== null ? `$${costUsd.toFixed(2)} equiv` : 'cost n/a'} · ${turns} turns · ${duration}`)
    for (const agent of metrics.agents) {
      const t = agent.tokens
      const indent = agent.id === 'orchestrator' ? '  ' : agent.parentId && agent.parentId !== 'orchestrator' ? '        ↳ ' : '    ↳ '
      this.log(
        loopId,
        runId,
        'metric',
        `${indent}${agent.label} (${agent.model ?? '?'}): ${agent.messages} msgs · in ${formatTokens(t.input)} · out ${formatTokens(t.output)} · cache r/w ${formatTokens(t.cacheRead)}/${formatTokens(t.cacheWrite)}`,
      )
    }
    for (const [model, mu] of Object.entries(metrics.perModel)) {
      this.log(
        loopId,
        runId,
        'metric',
        `  ${model}: ${mu.costUsd !== null ? `$${mu.costUsd.toFixed(2)}` : '$?'} · in ${formatTokens(mu.tokens.input)} · out ${formatTokens(mu.tokens.output)}`,
      )
    }
  }

  // ---------------------------------------------------------------- critique

  private verdictFilePath(workspaceDir: string, runId: string): string {
    return path.join(runsDir(workspaceDir), `${runId}.verdict.txt`)
  }

  private async executeCritique(loop: LoopRecord, run: RunRecord): Promise<void> {
    const models = loop.models
    this.log(
      loop.id,
      run.id,
      'system',
      `● Round ${run.round} — critique (${run.harness} ${models.criticModel}, effort ${models.criticEffort}, fresh eyes)`,
    )
    const plan = critiquePlan({
      models,
      prompt: run.prompt,
      claudeHome: cliHome('claude'),
      codexHome: cliHome('codex'),
      outFile: this.verdictFilePath(loop.workspaceDir, run.id),
    })
    const spawned = this.spawnDetached(loop, run, plan.bin, plan.args, subscriptionEnv(plan.env))
    if (!spawned) return
    this.ledger.patchRun(run.id, { model: models.criticModel })
    const gate: LogGate = { suppress: false }
    const parser = this.makeCritiqueParser(loop, run, gate)
    await this.driveRun(loop, run, spawned.meta, CRITIQUE_TIMEOUT_MS, CRITIQUE_TIMEOUT_MS, parser, gate, spawned.own)
  }

  private makeCritiqueParser(loop: LoopRecord, run: RunRecord, gate: LogGate): StreamParser {
    const models = loop.models
    const plog = (kind: string, text: string): void => {
      if (!gate.suppress) this.log(loop.id, run.id, kind, text)
    }
    let lastAgentMessage = ''
    const tokens = emptyTokens()
    let sawUsage = false
    let failure: string | null = null
    const startedAtMs = this.readMeta(loop.workspaceDir, run.id)?.startedAtMs ?? Date.now()

    /** Push the running critic totals into the ledger so cost shows mid-run. */
    const flushCritic = (): void => {
      this.ledger.patchRun(run.id, {
        inputTokens: tokens.input + tokens.cacheRead + tokens.cacheWrite,
        outputTokens: tokens.output,
        costUsd: estimateCostUsd(models.criticModel, tokens),
        metrics: {
          agents: [
            {
              id: 'critic',
              label: 'critic (fresh eyes)',
              model: models.criticModel,
              messages: 1,
              tokens: { ...tokens },
              firstTs: new Date(startedAtMs).toISOString(),
              lastTs: new Date().toISOString(),
            },
          ],
          perModel: {},
        },
      })
      this.broadcast(loop.id)
    }

    // Claude and Codex stream different JSON shapes; each translator feeds the
    // same state above, so everything downstream of here is harness-agnostic.
    const onClaudeLine = (line: string): void => {
      const t = translateClaudeLine(line)
      if (!t) return
      if (t.init) {
        plog('system', `claude session ${t.init.sessionId?.slice(0, 8) ?? '?'} · model ${t.init.model ?? '?'}`)
        return
      }
      if (t.usage) {
        sawUsage = true
        tokens.input += t.usage.usage.input_tokens ?? 0
        tokens.output += t.usage.usage.output_tokens ?? 0
        tokens.cacheRead += t.usage.usage.cache_read_input_tokens ?? 0
        tokens.cacheWrite += t.usage.usage.cache_creation_input_tokens ?? 0
        flushCritic()
      }
      for (const event of t.events) plog(event.kind, `[critic] ${event.text}`)
      if (t.summary !== undefined) lastAgentMessage = t.summary
      if (t.result) {
        // The final result text is the critic's verdict; it also carries the
        // authoritative usage totals, which replace the per-message tally.
        if (t.result.text?.trim()) lastAgentMessage = t.result.text
        const usage = t.result.usage
        if (usage) {
          sawUsage = true
          tokens.input = usage.input_tokens ?? tokens.input
          tokens.output = usage.output_tokens ?? tokens.output
          tokens.cacheRead = usage.cache_read_input_tokens ?? tokens.cacheRead
          tokens.cacheWrite = usage.cache_creation_input_tokens ?? tokens.cacheWrite
        }
        if (t.result.subtype !== 'success' && t.result.isError) {
          failure = t.result.text !== null ? trunc(t.result.text, 400) : `claude critique ${t.result.subtype ?? 'failed'}`
          plog('error', failure)
        }
      }
    }

    const onCodexLine = (line: string): void => {
      const t = translateCodexLine(line)
      if (!t) return
      if (t.threadStarted !== undefined) {
        plog('system', `codex thread ${t.threadStarted?.slice(0, 8) ?? '?'}`)
      }
      for (const event of t.events) plog(event.kind, `[critic] ${event.text}`)
      if (t.summary !== undefined) lastAgentMessage = t.summary
      if (t.turn?.usage) {
        sawUsage = true
        const turn = codexTokens(t.turn.usage)
        tokens.input += turn.input
        tokens.cacheRead += turn.cacheRead
        tokens.cacheWrite += turn.cacheWrite
        tokens.output += turn.output
        flushCritic()
      }
      if (t.error) {
        failure = t.error
        plog('error', failure)
      }
    }

    const onLine = run.harness === 'claude' ? onClaudeLine : onCodexLine

    const finalize = async (exit: ExitInfo): Promise<void> => {
      let verdictText = lastAgentMessage
      if (run.harness === 'codex') {
        // codex writes its final message to the -o file; claude streams it in
        // the result event, which onClaudeLine already captured.
        try {
          verdictText = fs.readFileSync(this.verdictFilePath(loop.workspaceDir, run.id), 'utf8') || lastAgentMessage
          fs.unlinkSync(this.verdictFilePath(loop.workspaceDir, run.id))
        } catch {
          /* fall back to streamed message */
        }
      }
      let verdict = parseVerdict(verdictText)
      if (!verdict) {
        verdict = readVerdictArtifact(loop.workspaceDir, run.round, Date.parse(loop.createdAt))
        if (verdict) this.log(loop.id, run.id, 'system', `Final message had no parseable verdict — recovered it from critique/round-${run.round}/verdict.json.`)
      }
      const durationMs = Date.now() - startedAtMs
      const criticAgent: AgentMetric = {
        id: 'critic',
        label: 'critic (fresh eyes)',
        model: models.criticModel,
        messages: 1,
        tokens,
        firstTs: new Date(startedAtMs).toISOString(),
        lastTs: new Date().toISOString(),
      }
      const criticCost = sawUsage ? estimateCostUsd(models.criticModel, tokens) : null
      this.ledger.patchRun(run.id, {
        metrics: { agents: [criticAgent], perModel: sawUsage ? { [models.criticModel]: { costUsd: criticCost, tokens } } : {} },
        inputTokens: sawUsage ? tokens.input + tokens.cacheRead + tokens.cacheWrite : null,
        outputTokens: sawUsage ? tokens.output : null,
        costUsd: criticCost,
        durationMs,
        summary: verdictText ? verdictText.slice(0, 4000) : null,
        verdict,
        finishedAt: new Date().toISOString(),
      })
      this.accumulateCost(loop.id, criticCost)
      this.log(
        loop.id,
        run.id,
        'metric',
        `▤ critique metrics: ${criticCost != null ? `$${criticCost.toFixed(2)} equiv (table est) · ` : ''}in ${formatTokens(tokens.input + tokens.cacheRead)} · out ${formatTokens(tokens.output)} · ${Math.round(durationMs / 60_000)}m`,
      )

      const stopReason = this.stopRequested.has(loop.id) ? 'user' : exit.timedOut ? 'timeout' : null
      if (stopReason) {
        this.ledger.patchRun(run.id, { status: 'cancelled', error: stopReason === 'user' ? 'Stopped by user.' : 'Timed out.' })
        this.finishLoop(loop.id, 'stopped', stopReason === 'user' ? 'Stopped by user.' : 'Critique run timed out.')
        return
      }
      if (failure || exit.spawnError || (exit.code !== 0 && exit.code !== null) || !verdict) {
        const attempts = this.ledger.runsForLoop(loop.id).filter((r) => r.role === 'critique' && r.round === run.round).length
        const errText = exit.spawnError ?? failure ?? (verdict ? `${run.harness} exited ${exit.code}` : `no parseable verdict (exit ${exit.code})`)
        this.ledger.patchRun(run.id, { status: 'failed', error: errText })
        if (attempts < MAX_CRITIQUE_ATTEMPTS) {
          this.log(loop.id, run.id, 'system', `Critique failed (${errText}) — retrying with a fresh critic.`)
          this.ledger.createRun({
            loopId: loop.id,
            round: run.round,
            role: 'critique',
            harness: loop.models.criticHarness,
            prompt: buildCriticPrompt(loop.prompt, run.round, this.referenceDir(loop.id), engineGateRules()),
          })
          this.broadcast(loop.id)
          void this.executeNext(loop.id)
          return
        }
        this.finishLoop(loop.id, 'failed', `Critique failed twice: ${errText}`)
        return
      }

      this.ledger.patchRun(run.id, { status: 'succeeded' })
      const evidence = scanCritiqueArtifacts(loop.workspaceDir).find((a) => a.round === run.round)
      if (evidence && (evidence.shots.length > 0 || evidence.refs.length > 0)) {
        this.log(
          loop.id,
          run.id,
          'shot',
          `▦ evidence saved: ${evidence.shots.length} shots · ${evidence.refs.length} refs · ${evidence.videos.length} videos${evidence.pairs ? ` · ${evidence.pairs.length} pairs` : evidence.pairsMd ? ' · pairs.md' : ''} → critique/round-${run.round}/`,
        )
        for (const file of [...evidence.shots, ...evidence.refs].slice(0, 10)) this.log(loop.id, run.id, 'shot', `  ${file}`)
      }
      this.log(loop.id, run.id, 'verdict', `★ score ${verdict.score.toFixed(2)}/1.00 ${verdict.pass ? '— PASS' : '— not there yet'} · ${trunc(verdict.summary, 300)}`)
      for (const finding of verdict.findings.slice(0, 12)) this.log(loop.id, run.id, 'verdict', `  · [${finding.severity}] ${trunc(finding.text, 240)}`)
      if (verdict.findings.length > 12) this.log(loop.id, run.id, 'verdict', `  · …and ${verdict.findings.length - 12} more findings`)

      if (verdict.pass) {
        this.finishLoop(loop.id, 'passed', `Critic passed the build with score ${verdict.score.toFixed(2)} after round ${run.round}.`)
        return
      }
      if (run.round >= loop.maxRounds) {
        this.finishLoop(loop.id, 'exhausted', `Max rounds (${loop.maxRounds}) reached. Best score: ${this.bestScore(loop.id).toFixed(2)}.`)
        return
      }
      if (this.overBudget(loop.id)) return

      const nextRound = run.round + 1
      this.ledger.patchLoop(loop.id, { round: nextRound })
      this.ledger.createRun({
        loopId: loop.id,
        round: nextRound,
        role: 'implement',
        harness: harnessFor(loop.models.orchestratorModel),
        prompt: buildImplementPrompt(loop.models, loop.prompt, nextRound, verdict, this.referenceDir(loop.id)),
      })
      this.log(loop.id, null, 'system', `Verdict fed forward — round ${nextRound} queued.`)
      this.broadcast(loop.id)
      void this.executeNext(loop.id)
    }

    return { onLine, onStderr: (text) => plog('stderr', trunc(text, 400)), finalize }
  }

  // ---------------------------------------------------------------- helpers

  private accumulateCost(loopId: string, costUsd: number | null): void {
    if (!costUsd) return
    const loop = this.ledger.getLoop(loopId)
    if (loop) this.ledger.patchLoop(loopId, { totalCostUsd: loop.totalCostUsd + costUsd })
  }

  private overBudget(loopId: string): boolean {
    const loop = this.ledger.getLoop(loopId)
    if (!loop?.budgetUsd || loop.totalCostUsd < loop.budgetUsd) return false
    this.finishLoop(loopId, 'stopped', `Budget ceiling hit: $${loop.totalCostUsd.toFixed(2)} of $${loop.budgetUsd.toFixed(2)} (equivalent API cost).`)
    return true
  }

  private bestScore(loopId: string): number {
    return this.ledger.runsForLoop(loopId).reduce((best, r) => (r.verdict && r.verdict.score > best ? r.verdict.score : best), 0)
  }
}
