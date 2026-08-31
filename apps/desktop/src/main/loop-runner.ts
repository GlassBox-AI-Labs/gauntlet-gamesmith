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
import { describeModels, isUltracode, resolveModels } from '../shared/models'
import { cliHome, runsDir, subscriptionEnv } from './harness-env'
import type { Ledger } from './ledger'
import { estimateCostUsd } from './pricing'
import { buildReport, scanCritiqueArtifacts } from './report'

const IMPLEMENT_TIMEOUT_MS = 150 * 60_000
const CRITIQUE_TIMEOUT_MS = 60 * 60_000
const MAX_CRITIQUE_ATTEMPTS = 2

function implementerAgentMd(models: LoopModels): string {
  return `---
name: implementer
description: Builds and polishes one assigned slice of the game to AAA quality. Use for ALL substantial implementation work.
model: ${models.subagentModel ?? models.orchestratorModel}
effort: ${models.subagentEffort}
---
You are an elite AAA game engineer. You receive one specific slice of the game (rendering, weapons, physics, audio, HUD, level design, ...). Implement it to the highest visual and technical quality, verify it actually runs, and report exactly what you changed and how to verify it.
`
}

function orchestrationSuffix(models: LoopModels): string {
  if (!models.subagentModel) {
    return 'Working rules: you implement this yourself — do NOT delegate to subagents. Verify the game actually builds and runs before you finish.'
  }
  // A workflow agent picks its model as: model the script names → the agent
  // file's frontmatter → CLAUDE_CODE_SUBAGENT_MODEL → the session model. The env
  // var (set on the spawn) pins the model either way, but effort only binds
  // through the agent file, so the script has to name the agent type to get it.
  const workflowRule = isUltracode(models)
    ? ` When you orchestrate through a workflow, pass \`{agentType: 'implementer'}\` on every \`agent()\` call so each one runs ${models.subagentModel} at ${models.subagentEffort} effort rather than inheriting yours.`
    : ''
  return `Orchestration rules: you are the orchestrator. Delegate ALL substantial implementation work to parallel \`implementer\` subagents (defined in .claude/agents/implementer.md — they run ${models.subagentModel} at ${models.subagentEffort} effort), one per workstream, and integrate their results.${workflowRule} Verify the game actually builds and runs before you finish.`
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

function buildImplementPrompt(models: LoopModels, userPrompt: string, round: number, verdict: Verdict | null): string {
  if (round <= 1 || !verdict) return `${userPrompt}\n\n${orchestrationSuffix(models)}`
  const findings = verdict.findings.map((f) => `- [${f.severity}] ${f.text}`).join('\n')
  return [
    userPrompt,
    '---',
    `A harsh external critic (fresh eyes, a different model) reviewed round ${round - 1}. Score: ${verdict.score.toFixed(2)}/1.00.`,
    `Critic summary: ${verdict.summary}`,
    'Findings you MUST fix this round:',
    findings || '- (no itemized findings — raise overall quality)',
    '---',
    'Fix every finding above, then keep raising quality toward the bar.',
    orchestrationSuffix(models),
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
3. Actually look at the running result whenever possible (serve it, screenshot it with any tooling available). Save every screenshot you capture of this project into ./${evidenceDir}/shots/. ALSO record a short gameplay video (~15-30s of actual play — e.g. Playwright's recordVideo on the served page while simulating input) and save it as ./${evidenceDir}/video/gameplay.webm. Judge visuals, gameplay, performance, completeness, polish.
4. Compare side by side. Copy the specific reference stills you compare against into ./${evidenceDir}/refs/. For each comparison pair, judge purely on what is in frame — as if you did not know which image is which — and record every pair TWICE: human-readable notes in ./${evidenceDir}/pairs.md, and machine-readable ./${evidenceDir}/pairs.json — a JSON array of {"shot": "shots/<file>", "ref": "refs/<file>", "winner": "shot"|"ref"|"tie", "why": "<one specific sentence>"}. Be specific about every place this project falls short: textures, lighting, models, animation, physics, audio, UI, game feel.
5. Score 0.00-1.00 where 1.00 = indistinguishable from the AAA reference and 0.90 = you are genuinely wowed. Anything unfinished, ugly, or broken must score low. Do not be polite. Do not grade on effort.

End your reply with EXACTLY one fenced JSON block and nothing after it:

\`\`\`json
{"score": 0.0, "pass": false, "summary": "<=60 words>", "findings": [{"severity": "critical|major|minor", "text": "one specific, fixable shortfall"}]}
\`\`\`

"pass" may only be true if score >= 0.90 and you would genuinely mistake screenshots of this game for the AAA reference.`
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

interface ExitInfo {
  code: number | null // null = exit code unknown (re-attached process)
  timedOut: boolean
  spawnError: string | null
}

interface StreamParser {
  onLine(line: string): void
  onStderr(text: string): void
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
    try {
      fs.mkdirSync(workspaceDir, { recursive: true })
    } catch (error) {
      return { ok: false, error: `Cannot create workspace: ${error instanceof Error ? error.message : String(error)}` }
    }

    const models = resolveModels(input, input.criticId)
    const loop = this.ledger.createLoop({ prompt, workspaceDir, maxRounds, budgetUsd, models })
    this.log(loop.id, null, 'system', `Loop started — workspace ${workspaceDir}, max ${maxRounds} rounds${budgetUsd ? `, budget $${budgetUsd}` : ''}.`)
    this.log(
      loop.id,
      null,
      'system',
      describeModels(models),
    )
    this.ledger.createRun({ loopId: loop.id, round: 1, role: 'implement', harness: 'claude', prompt: buildImplementPrompt(models, prompt, 1, null) })
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
          const timeout = active.role === 'implement' ? IMPLEMENT_TIMEOUT_MS : CRITIQUE_TIMEOUT_MS
          void this.driveRun(loop, active, meta, timeout, parser, gate, null)
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
        harness: 'claude',
        prompt: buildImplementPrompt(loop.models, loop.prompt, nextRound, last.verdict),
      })
      this.log(loopId, null, 'system', `Loop resumed by user — starting round ${nextRound}.`)
    } else {
      this.ledger.createRun({ loopId, round: 1, role: 'implement', harness: 'claude', prompt: buildImplementPrompt(loop.models, loop.prompt, 1, null) })
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
    timeoutMs: number,
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

    const remaining = timeoutMs - (Date.now() - meta.startedAtMs)
    const timer =
      remaining <= 0
        ? ((att.timedOut = true), this.interruptPid(meta.pid), null)
        : setTimeout(() => {
            att.timedOut = true
            this.log(loop.id, run.id, 'error', `Run exceeded ${Math.round(timeoutMs / 60_000)} min — interrupting.`)
            this.interruptPid(meta.pid)
          }, remaining)

    await new Promise<void>((resolve) => {
      const interval = setInterval(() => {
        pump()
        const dead = own ? own.exited : !this.pidAlive(meta.pid)
        if (dead) {
          clearInterval(interval)
          resolve()
        }
      }, 400)
    })
    if (timer) clearTimeout(timer)
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
    if (models.subagentModel) {
      const agentDir = path.join(loop.workspaceDir, '.claude', 'agents')
      fs.mkdirSync(agentDir, { recursive: true })
      fs.writeFileSync(path.join(agentDir, 'implementer.md'), implementerAgentMd(models))
    }

    const priorSessionId = this.lastImplementSessionId(loop.id, run.id)
    const isResume = run.prompt.startsWith(RESUME_PREFIX) && (priorSessionId != null || this.hasClaudeSession(loop.workspaceDir))
    const prompt = isResume
      ? 'The app running you was restarted and your previous session was interrupted. Continue exactly where you left off. First audit what already landed on disk; do NOT redo completed work — dispatch implementer subagents only for the remaining gaps, telling each one to read the existing code in its slice before writing. Same rules apply.'
      : run.prompt.startsWith(RESUME_PREFIX)
        ? run.prompt.slice(RESUME_PREFIX.length)
        : run.prompt

    this.log(
      loop.id,
      run.id,
      'system',
      `● Round ${run.round} — implement (claude ${models.orchestratorModel}, effort ${models.orchestratorEffort})${isResume ? ' — continuing interrupted session' : ''}`,
    )
    const args = [
      ...(isResume ? (priorSessionId ? ['--resume', priorSessionId] : ['--continue']) : []),
      '-p',
      prompt,
      '--output-format',
      'stream-json',
      '--verbose',
      '--forward-subagent-text',
      '--dangerously-skip-permissions',
      '--model',
      models.orchestratorModel,
      '--effort',
      models.orchestratorEffort,
    ]
    const spawned = this.spawnDetached(
      loop,
      run,
      'claude',
      args,
      subscriptionEnv({
        CLAUDE_CONFIG_DIR: cliHome('claude'),
        // Binds the subagent model on both delegation paths: it is what a
        // workflow agent falls back to when the script names no model.
        ...(models.subagentModel ? { CLAUDE_CODE_SUBAGENT_MODEL: models.subagentModel } : {}),
      }),
    )
    if (!spawned) return
    const gate: LogGate = { suppress: false }
    const parser = this.makeImplementParser(loop, run, gate)
    await this.driveRun(loop, run, spawned.meta, IMPLEMENT_TIMEOUT_MS, parser, gate, spawned.own)
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

    // Live token + cost visibility: persist running totals every ~15s so the
    // ledger, dashboard, and report show tokens and estimated cost mid-run.
    const flushTokens = (): void => {
      if (Date.now() - lastTokenFlush < 15_000) return
      lastTokenFlush = Date.now()
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
      this.ledger.patchRun(run.id, {
        inputTokens: input,
        outputTokens: output,
        costUsd: liveCostEstimate,
        metrics: this.buildImplementMetrics(loop.models, agentLabels, msgUsage, null, finishedAgents),
      })
      this.broadcast(loop.id)
    }

    const onLine = (line: string): void => {
      if (!line.trim()) return
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
        const sessionId = (obj.session_id as string | undefined) ?? null
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

    const finalize = (exit: ExitInfo): void => {
      const metrics = this.buildImplementMetrics(loop.models, agentLabels, msgUsage, result, finishedAgents)
      const res = result as Record<string, unknown> | null
      const usage = (res?.usage as Record<string, number> | undefined) ?? undefined
      const finishedAt = new Date().toISOString()
      // Prefer the CLI's own figure (costBasis 'cli'); fall back to the live table estimate.
      const costUsd = typeof res?.total_cost_usd === 'number' ? (res.total_cost_usd as number) : liveCostEstimate

      this.ledger.patchRun(run.id, {
        metrics,
        costUsd,
        inputTokens: usage
          ? (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0)
          : undefined,
        outputTokens: usage?.output_tokens ?? undefined,
        numTurns: typeof res?.num_turns === 'number' ? (res.num_turns as number) : null,
        durationMs: typeof res?.duration_ms === 'number' ? (res.duration_ms as number) : Date.now() - (this.readMeta(loop.workspaceDir, run.id)?.startedAtMs ?? Date.now()),
        sessionId: (res?.session_id as string | undefined) ?? null,
        summary: typeof res?.result === 'string' ? (res.result as string).slice(0, 4000) : null,
        finishedAt,
      })
      this.logRunMetrics(loop.id, run.id, 'implement', costUsd, res, metrics)
      this.accumulateCost(loop.id, costUsd)

      const stopReason = this.stopRequested.has(loop.id) ? 'user' : exit.timedOut ? 'timeout' : null
      if (stopReason) {
        this.ledger.patchRun(run.id, { status: 'cancelled', error: stopReason === 'user' ? 'Stopped by user.' : 'Timed out.' })
        this.finishLoop(loop.id, 'stopped', stopReason === 'user' ? 'Stopped by user.' : 'Implement run timed out.')
        return
      }
      const succeeded = res !== null && res.is_error !== true && (exit.code === 0 || exit.code === null)
      if (!succeeded) {
        const errText =
          exit.spawnError ??
          (typeof res?.result === 'string' ? trunc(res.result as string, 400) : `claude exited ${exit.code}${res ? ` (${res.subtype})` : ' without a result'}`)
        const rateLimited = /rate.?limit|usage limit|out of extra usage/i.test(errText)
        this.ledger.patchRun(run.id, { status: 'failed', error: errText })
        this.finishLoop(
          loop.id,
          'stopped',
          rateLimited
            ? `Rate limited — wait for the window to reset, then start a new run in the same workspace. (${errText})`
            : `Implement run failed: ${errText}`,
        )
        return
      }
      this.ledger.patchRun(run.id, { status: 'succeeded' })
      if (this.overBudget(loop.id)) return
      this.ledger.createRun({ loopId: loop.id, round: run.round, role: 'critique', harness: loop.models.criticHarness, prompt: buildCriticPrompt(loop.prompt, run.round) })
      this.broadcast(loop.id)
      void this.executeNext(loop.id)
    }

    return { onLine, onStderr: (text) => plog('stderr', trunc(text, 400)), finalize }
  }

  private buildImplementMetrics(
    models: LoopModels,
    agentLabels: Map<string, { label: string; model: string | null }>,
    msgUsage: Map<string, { agentKey: string; model: string | null; usage: Record<string, number>; ts: string }>,
    result: Record<string, unknown> | null,
    finished: Set<string> = new Set(),
  ): RunMetrics {
    const agents = new Map<string, AgentMetric>()
    const ensure = (key: string): AgentMetric => {
      let agent = agents.get(key)
      if (!agent) {
        const reg = agentLabels.get(key)
        agent = {
          id: key,
          label: key === 'orchestrator' ? 'orchestrator' : (reg?.label ?? `subagent ${key.slice(-6)}`),
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
    for (const [key, agent] of agents) {
      if (key !== 'orchestrator') agent.done = finished.has(key)
    }
    const list = [...agents.values()]
    list.sort((a, b) => (a.id === 'orchestrator' ? -1 : b.id === 'orchestrator' ? 1 : (a.firstTs ?? '').localeCompare(b.firstTs ?? '')))
    return { agents: list, perModel }
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
    const spawned =
      run.harness === 'claude'
        ? this.spawnDetached(
            loop,
            run,
            'claude',
            [
              '-p',
              run.prompt,
              '--output-format',
              'stream-json',
              '--verbose',
              '--dangerously-skip-permissions',
              '--model',
              models.criticModel,
              '--effort',
              models.criticEffort,
            ],
            subscriptionEnv({ CLAUDE_CONFIG_DIR: cliHome('claude') }),
          )
        : this.spawnDetached(
            loop,
            run,
            'codex',
            [
              'exec',
              '--json',
              '--skip-git-repo-check',
              // code_mode fail-closes all command execution when its host binary is
              // missing (verified live) — the classic shell path works everywhere.
              '--disable',
              'code_mode',
              '-s',
              'workspace-write',
              '-c',
              'sandbox_workspace_write.network_access=true',
              '-c',
              'tools.web_search=true',
              '-c',
              'model_reasoning_summary=detailed',
              '-m',
              models.criticModel,
              '-c',
              `model_reasoning_effort=${models.criticEffort}`,
              '-o',
              this.verdictFilePath(loop.workspaceDir, run.id),
              run.prompt,
            ],
            subscriptionEnv({ CODEX_HOME: cliHome('codex') }),
          )
    if (!spawned) return
    this.ledger.patchRun(run.id, { model: models.criticModel })
    const gate: LogGate = { suppress: false }
    const parser = this.makeCritiqueParser(loop, run, gate)
    await this.driveRun(loop, run, spawned.meta, CRITIQUE_TIMEOUT_MS, parser, gate, spawned.own)
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
          tokens.input += usage.input_tokens ?? 0
          tokens.cacheRead += usage.cached_input_tokens ?? 0
          tokens.cacheWrite += usage.cache_write_input_tokens ?? 0
          tokens.output += usage.output_tokens ?? 0
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
        harness: 'claude',
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
