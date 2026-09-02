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
  StartLoopInput,
  StartLoopResult,
  TokenTotals,
  Verdict,
} from '../shared/loop'
import { RESUME_PREFIX } from '../shared/loop'
import { describeModels, harnessFor, isCrossHarness, isUltracode, resolveModels } from '../shared/models'
import { agentsDir, childrenActive, readChildAgents } from './child-agents'
import { codexTokens, readCodexUsage } from './codex-usage'
import { delegationRules, implementerAgentMd } from './delegation'
import { engineContract, engineGateRules, scaffoldEngine, type ScaffoldResult } from './engine-stack'
import { critiquePlan, implementPlan } from './harness-plans'
import { cliHome, runsDir, subscriptionEnv } from './harness-env'
import type { Ledger } from './ledger'
import { estimateCostUsd } from './pricing'
import { buildReport, scanCritiqueArtifacts } from './report'
import { captureRoundRevision } from './round-revision'
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
/** No write to a delegated worker's stream for this long counts as finished. */
const CHILD_QUIET_MS = 2 * 60_000
const MAX_CRITIQUE_ATTEMPTS = 2

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
 * build it out of. It is repeated on every round rather than only the first,
 * because by round seven the critic is pushing hard on lighting and game feel
 * and the architecture is exactly what gets quietly traded away to fix
 * findings.
 */
function buildImplementPrompt(models: LoopModels, userPrompt: string, round: number, verdict: Verdict | null): string {
  if (round <= 1 || !verdict) return `${userPrompt}\n\n${engineContract()}\n\n${delegationRules(models)}`
  const findings = verdict.findings.map((f) => `- [${f.severity}] ${f.text}`).join('\n')
  return [
    userPrompt,
    '---',
    `A harsh external critic (fresh eyes, a different model) reviewed round ${round - 1}. Score: ${verdict.score.toFixed(2)}/1.00.`,
    `Critic summary: ${verdict.summary}`,
    'Findings you MUST fix this round:',
    findings || '- (no itemized findings — raise overall quality)',
    '---',
    'Fix every finding above, then keep raising quality toward the bar. Never fix a finding by weakening the engine contract below — if one genuinely conflicts with it, say so in your report and fix the rest.',
    engineContract(),
    delegationRules(models),
  ].join('\n\n')
}

function buildCriticPrompt(userPrompt: string, round: number): string {
  const evidenceDir = `critique/round-${round}`
  return `You are a brutally harsh AAA game quality critic with fresh eyes. You did not build this project and you have no attachment to it. Judge the project in the current working directory against this bar:

<goal>
${userPrompt}
</goal>

Protocol:
1. Research the real AAA reference named in the goal FIRST. Web search is enabled and the workspace has network access: query for official screenshots and gameplay footage, consult YouTube gameplay videos and analyses (transcripts, stills, thumbnails), and download the best reference stills into ./reference — then VIEW the images you downloaded. Do not judge from memory.
   Real gameplay in motion: yt-dlp and ffmpeg are installed. Find one good YouTube gameplay video of the AAA reference and pull a ~30s slice (e.g. \`yt-dlp --download-sections "*60-90" -f "bv*[height<=1080]" -o reference/aaa-gameplay.%(ext)s "<url>"\`), then extract ~10 frames at 1s intervals with \`ffmpeg -i reference/aaa-gameplay.* -vf fps=1 ./${evidenceDir}/refs/motion/aaa-%02d.png\` and VIEW them. Later, extract frames from your own gameplay recording the same way (into ./${evidenceDir}/shots/motion/) and compare motion-to-motion: mid-action chaos, trails, feedback timing — not just posed stills. If yt-dlp fails on one video, try another; do not burn more than a few minutes on it.
2. Inspect the project. Install dependencies and build/run it if needed. You may write to the workspace to install, build, serve, or capture screenshots — but do NOT modify project source files and do NOT fix anything yourself.
3. Actually look at the running result whenever possible (serve it, screenshot it with any tooling available). Save every screenshot you capture of this project into ./${evidenceDir}/shots/. ALSO record a short gameplay video (~15-30s of actual play — e.g. Playwright's recordVideo on the served page while simulating input) and save it as ./${evidenceDir}/video/gameplay.webm. Judge visuals, gameplay, performance, completeness, polish. You run inside a macOS sandbox: use Playwright's bundled browsers (\`chromium.launch({ headless: true })\`, \`recordVideo\` on the context). Never pass \`channel: 'chrome'\` / \`'msedge'\` and never launch an installed browser app — the sandbox blocks it from registering with macOS, so it aborts on launch and files a crash report.
4. Compare side by side. Copy the specific reference stills you compare against into ./${evidenceDir}/refs/. For each comparison pair, judge purely on what is in frame — as if you did not know which image is which — and record every pair TWICE: human-readable notes in ./${evidenceDir}/pairs.md, and machine-readable ./${evidenceDir}/pairs.json — a JSON array of {"shot": "shots/<file>", "ref": "refs/<file>", "winner": "shot"|"ref"|"tie", "why": "<one specific sentence>"}. Be specific about every place this project falls short: textures, lighting, models, animation, physics, audio, UI, game feel.
5. Score 0.00-1.00 where 1.00 = indistinguishable from the AAA reference and 0.90 = you are genuinely wowed. Anything unfinished, ugly, or broken must score low. Do not be polite. Do not grade on effort.
6. ${engineGateRules()}

End your reply with EXACTLY one fenced JSON block and nothing after it:

\`\`\`json
{"score": 0.0, "pass": false, "summary": "<=60 words>", "findings": [{"severity": "critical|major|minor", "text": "one specific, fixable shortfall"}]}
\`\`\`

"pass" may only be true if score >= 0.90 AND \`node tools/engine-gate.mjs\` exited 0 AND you would genuinely mistake screenshots of this game for the AAA reference.`
}

/** On-disk record of a detached run process; lets the app die and re-attach. */
interface ProcMeta {
  pid: number
  outPath: string
  errPath: string
  startedAtMs: number
  loggedOutLines: number
  loggedErrLines: number
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

  constructor(
    private ledger: Ledger,
    private send: (channel: string, payload: unknown) => void,
  ) {}

  snapshot(): LoopSnapshot | null {
    const loop = this.ledger.runningLoop() ?? this.ledger.latestLoop()
    if (!loop) return null
    return { loop, runs: this.ledger.runsForLoop(loop.id) }
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

    const models = resolveModels(input, input)
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
    this.ledger.createRun({
      loopId: loop.id,
      round: 1,
      role: 'implement',
      harness: harnessFor(models.orchestratorModel),
      prompt: buildImplementPrompt(models, prompt, 1, null),
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
          const parser = active.role === 'implement' ? this.makeImplementParser(loop, active, gate) : this.makeCritiqueParser(loop, active, gate)
          const idle = active.role === 'implement' ? IMPLEMENT_IDLE_MS : CRITIQUE_TIMEOUT_MS
          const cap = active.role === 'implement' ? IMPLEMENT_HARD_CAP_MS : CRITIQUE_TIMEOUT_MS
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
    } else if (last?.role === 'implement' && last.round >= loop.maxRounds) {
      this.finishLoop(loopId, 'exhausted', `Max rounds (${loop.maxRounds}) reached after round ${last.round} — no critique, since no round is left for it to gate.`)
      return { ok: true }
    } else if (last?.role === 'implement') {
      this.ledger.createRun({ loopId, round: last.round, role: 'critique', harness: loop.models.criticHarness, prompt: buildCriticPrompt(loop.prompt, last.round) })
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
        prompt: buildImplementPrompt(loop.models, loop.prompt, nextRound, last.verdict),
      })
      this.log(loopId, null, 'system', `Loop resumed by user — starting round ${nextRound}.`)
    } else {
      this.ledger.createRun({
        loopId,
        round: 1,
        role: 'implement',
        harness: harnessFor(loop.models.orchestratorModel),
        prompt: buildImplementPrompt(loop.models, loop.prompt, 1, null),
      })
      this.log(loopId, null, 'system', 'Loop resumed by user — starting round 1.')
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

  private log(loopId: string, runId: string | null, kind: string, text: string): void {
    const line: LoopLogLine = { loopId, runId, ts: new Date().toISOString(), kind, text: text.slice(0, 4000) }
    this.ledger.appendEvent(line)
    this.send('loop:log', line)
  }

  private broadcast(loopId: string): void {
    const loop = this.ledger.getLoop(loopId)
    if (!loop) return
    const runs = this.ledger.runsForLoop(loopId)
    this.send('loop:update', { loop, runs })
    try {
      fs.writeFileSync(path.join(loop.workspaceDir, 'gauntlet-report.md'), buildReport(loop, runs, scanCritiqueArtifacts(loop.workspaceDir)))
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
      if (run.role === 'implement') await this.executeImplement(loop, run)
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
      if (Date.now() - lastMetaWrite > 1_000) {
        lastMetaWrite = Date.now()
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
    await parser.finalize({ code: own ? own.code : null, timedOut: att.timedOut, spawnError: own?.spawnError ?? null })
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

  // ---------------------------------------------------------------- implement

  private async executeImplement(loop: LoopRecord, run: RunRecord): Promise<void> {
    const models = loop.models
    const harness = harnessFor(models.orchestratorModel)
    const agentMd = implementerAgentMd(models)
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
    }
    if (announced) this.log(loop.id, run.id, 'system', '✓ delegated workers finished.')
  }

  private makeImplementParser(loop: LoopRecord, run: RunRecord, gate: LogGate): StreamParser {
    const plog = (kind: string, text: string): void => {
      if (!gate.suppress) this.log(loop.id, run.id, kind, text)
    }
    const agentLabels = new Map<string, { label: string; model: string | null }>()
    const finishedAgents = new Set<string>()
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
        metrics: this.buildImplementMetrics(loop.models, agentLabels, msgUsage, null, finishedAgents, workflowAgents, childAgents),
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
        const content = Array.isArray(message.content) ? (message.content as Record<string, unknown>[]) : []
        for (const block of content) {
          if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
            plog(parentId ? 'agent' : 'claude', `[${who}] ${trunc(block.text, 400)}`)
          } else if (block.type === 'tool_use') {
            const name = block.name as string
            const input = block.input as Record<string, unknown> | undefined
            if ((name === 'Agent' || name === 'Task') && block.id) {
              const label = trunc((input?.description as string | undefined) ?? (input?.subagent_type as string | undefined) ?? 'subagent', 30)
              const model = (input?.model as string | undefined) ?? null
              agentLabels.set(block.id as string, { label, model })
              plog('spawn', `[${who}] ⇉ spawns "${label}"${model ? ` (${model})` : ''}`)
            } else {
              plog('tool', `[${who}] → ${name} ${input ? trunc(JSON.stringify(input), 160) : ''}`)
            }
          }
        }
        return
      }
      if (type === 'user') {
        const message = obj.message as Record<string, unknown> | undefined
        const content = Array.isArray(message?.content) ? (message?.content as Record<string, unknown>[]) : []
        for (const block of content) {
          if (block.type !== 'tool_result') continue
          const toolUseId = block.tool_use_id as string | undefined
          if (toolUseId && agentLabels.has(toolUseId) && !finishedAgents.has(toolUseId)) {
            finishedAgents.add(toolUseId)
            plog('spawn', `⇊ subagent "${agentLabels.get(toolUseId)!.label}" finished`)
          }
          if (block.is_error) {
            plog('error', `[${who}] ✗ tool error: ${trunc(JSON.stringify(block.content ?? ''), 300)}`)
          }
        }
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
        const metrics = this.buildImplementMetrics(loop.models, agentLabels, msgUsage, result, finishedAgents, workflowAgents, childAgents)
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
      let obj: Record<string, unknown>
      try {
        obj = JSON.parse(line) as Record<string, unknown>
      } catch {
        return
      }
      const type = obj.type as string
      if (type === 'thread.started') {
        threadId = (obj.thread_id as string | undefined) ?? null
        this.ledger.patchRun(run.id, { sessionId: threadId })
        plog('system', `codex thread ${threadId?.slice(0, 8) ?? '?'}`)
      } else if (type === 'item.completed' || type === 'item.updated') {
        const item = obj.item as Record<string, unknown> | undefined
        if (!item || type !== 'item.completed') return
        if (item.type === 'agent_message' && typeof item.text === 'string') {
          lastAgentMessage = item.text
          plog('codex', trunc(item.text, 400))
        } else if (item.type === 'reasoning' && typeof item.text === 'string' && item.text.trim()) {
          plog('thought', `𝜓 ${trunc(item.text, 500)}`)
        } else if (item.type === 'command_execution' && typeof item.command === 'string') {
          plog('cmd', `$ ${trunc(item.command, 200)}`)
        } else if (item.type === 'file_change') {
          plog('cmd', `✎ ${trunc(JSON.stringify(item.changes ?? ''), 160)}`)
        } else if (item.type === 'SubAgentActivity' || item.type === 'collab_tool_call') {
          plog('spawn', `⇉ worker ${trunc(JSON.stringify(item.agent_path ?? item.kind ?? ''), 120)}`)
        } else if (item.type === 'error') {
          plog('error', trunc(String(item.message ?? 'codex error'), 300))
        }
      } else if (type === 'turn.completed') {
        const turn = codexTokens(obj.usage as Record<string, number> | undefined)
        tokens.input += turn.input
        tokens.output += turn.output
        tokens.cacheRead += turn.cacheRead
        tokens.cacheWrite += turn.cacheWrite
        turns += 1
        flush(true)
      } else if (type === 'turn.failed') {
        failure = String((obj.error as Record<string, unknown> | undefined)?.message ?? 'codex turn failed')
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
    this.ledger.createRun({ loopId: loop.id, round: run.round, role: 'critique', harness: loop.models.criticHarness, prompt: buildCriticPrompt(loop.prompt, run.round) })
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
          model: key === 'orchestrator' ? models.orchestratorModel : (reg?.model ?? models.subagentModel ?? models.orchestratorModel),
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
    list.sort((a, b) => (a.id === 'orchestrator' ? -1 : b.id === 'orchestrator' ? 1 : (a.firstTs ?? '').localeCompare(b.firstTs ?? '')))
    // Workflow agents carry only a scalar token count, so they cannot join
    // perModel — that stays priced off the stream and the CLI's own figures.
    return { agents: [...list, ...workflowAgents, ...childAgents], perModel }
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
      const indent = agent.id === 'orchestrator' ? '  ' : '    ↳ '
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

    // Claude and Codex stream different JSON shapes; each reader feeds the same
    // state above, so everything downstream of here is harness-agnostic.
    const onClaudeLine = (line: string): void => {
      if (!line.trim()) return
      let obj: Record<string, unknown>
      try {
        obj = JSON.parse(line) as Record<string, unknown>
      } catch {
        return
      }
      const type = obj.type as string
      if (type === 'system' && obj.subtype === 'init') {
        plog('system', `claude session ${(obj.session_id as string | undefined)?.slice(0, 8) ?? '?'} · model ${(obj.model as string | undefined) ?? '?'}`)
        return
      }
      if (type === 'assistant') {
        const message = obj.message as Record<string, unknown> | undefined
        if (!message) return
        const usage = message.usage as Record<string, number> | undefined
        if (usage) {
          sawUsage = true
          tokens.input += usage.input_tokens ?? 0
          tokens.output += usage.output_tokens ?? 0
          tokens.cacheRead += usage.cache_read_input_tokens ?? 0
          tokens.cacheWrite += usage.cache_creation_input_tokens ?? 0
          flushCritic()
        }
        const content = Array.isArray(message.content) ? (message.content as Record<string, unknown>[]) : []
        for (const block of content) {
          if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
            lastAgentMessage = block.text
            plog('claude', `[critic] ${trunc(block.text, 400)}`)
          } else if (block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking.trim()) {
            plog('thought', `[critic] 𝜓 ${trunc(block.thinking, 500)}`)
          } else if (block.type === 'tool_use') {
            const name = block.name as string
            const input = block.input as Record<string, unknown> | undefined
            if (name === 'WebSearch') plog('search', `[critic] ⌕ ${trunc(String(input?.query ?? ''), 200)}`)
            else if (name === 'Bash') plog('cmd', `[critic] $ ${trunc(String(input?.command ?? ''), 200)}`)
            else plog('tool', `[critic] → ${name} ${input ? trunc(JSON.stringify(input), 160) : ''}`)
          }
        }
        return
      }
      if (type === 'user') {
        const message = obj.message as Record<string, unknown> | undefined
        const content = Array.isArray(message?.content) ? (message?.content as Record<string, unknown>[]) : []
        for (const block of content) {
          if (block.type === 'tool_result' && block.is_error) {
            plog('error', `[critic] ✗ tool error: ${trunc(JSON.stringify(block.content ?? ''), 300)}`)
          }
        }
        return
      }
      if (type === 'result') {
        // The final result text is the critic's verdict; it also carries the
        // authoritative usage totals, which replace the per-message tally.
        if (typeof obj.result === 'string' && obj.result.trim()) lastAgentMessage = obj.result
        const usage = obj.usage as Record<string, number> | undefined
        if (usage) {
          sawUsage = true
          tokens.input = usage.input_tokens ?? tokens.input
          tokens.output = usage.output_tokens ?? tokens.output
          tokens.cacheRead = usage.cache_read_input_tokens ?? tokens.cacheRead
          tokens.cacheWrite = usage.cache_creation_input_tokens ?? tokens.cacheWrite
        }
        if (obj.subtype !== 'success' && obj.is_error === true) {
          failure = typeof obj.result === 'string' ? trunc(obj.result, 400) : `claude critique ${String(obj.subtype ?? 'failed')}`
          plog('error', failure)
        }
      }
    }

    const onCodexLine = (line: string): void => {
      if (!line.trim()) return
      let obj: Record<string, unknown>
      try {
        obj = JSON.parse(line) as Record<string, unknown>
      } catch {
        return
      }
      const type = obj.type as string
      if (type === 'thread.started') {
        plog('system', `codex thread ${(obj.thread_id as string | undefined)?.slice(0, 8) ?? '?'}`)
      } else if (type === 'item.completed' || type === 'item.updated') {
        const item = obj.item as Record<string, unknown> | undefined
        if (!item) return
        if (item.type === 'agent_message' && typeof item.text === 'string' && type === 'item.completed') {
          lastAgentMessage = item.text
          plog('codex', `[critic] ${trunc(item.text, 400)}`)
        } else if (item.type === 'reasoning' && typeof item.text === 'string' && type === 'item.completed' && item.text.trim()) {
          plog('thought', `[critic] 𝜓 ${trunc(item.text, 500)}`)
        } else if (item.type === 'command_execution' && typeof item.command === 'string' && type === 'item.completed') {
          plog('cmd', `[critic] $ ${trunc(item.command, 200)}`)
        } else if (item.type === 'web_search' && type === 'item.completed') {
          plog('search', `[critic] ⌕ ${trunc(String(item.query ?? ''), 200)}`)
        } else if (item.type === 'file_change' && type === 'item.completed') {
          plog('cmd', `[critic] ✎ file change: ${trunc(JSON.stringify(item.changes ?? ''), 160)}`)
        } else if (item.type === 'error') {
          plog('error', `[critic] ${trunc(String(item.message ?? 'codex error'), 300)}`)
        }
      } else if (type === 'turn.completed') {
        const usage = obj.usage as Record<string, number> | undefined
        if (usage) {
          sawUsage = true
          const turn = codexTokens(usage)
          tokens.input += turn.input
          tokens.cacheRead += turn.cacheRead
          tokens.cacheWrite += turn.cacheWrite
          tokens.output += turn.output
          flushCritic()
        }
      } else if (type === 'turn.failed') {
        const error = obj.error as Record<string, unknown> | undefined
        failure = String(error?.message ?? 'codex turn failed')
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
      const verdict = parseVerdict(verdictText)
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
          this.ledger.createRun({ loopId: loop.id, round: run.round, role: 'critique', harness: loop.models.criticHarness, prompt: buildCriticPrompt(loop.prompt, run.round) })
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
        prompt: buildImplementPrompt(loop.models, loop.prompt, nextRound, verdict),
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
