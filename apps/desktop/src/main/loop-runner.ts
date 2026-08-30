import { spawn, type ChildProcessByStdio } from 'node:child_process'
import type { Readable } from 'node:stream'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
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
import { cliHome, subscriptionEnv } from './harness-env'
import type { Ledger } from './ledger'
import { buildReport } from './report'

export const LOOP_MODELS: LoopModels = {
  orchestratorModel: 'claude-fable-5',
  orchestratorEffort: 'high',
  subagentModel: 'opus',
  subagentEffort: 'medium',
  criticModel: 'gpt-5.6-sol',
  criticEffort: 'medium',
}

const IMPLEMENT_TIMEOUT_MS = 150 * 60_000
const CRITIQUE_TIMEOUT_MS = 60 * 60_000
const MAX_CRITIQUE_ATTEMPTS = 2

const IMPLEMENTER_AGENT_MD = `---
name: implementer
description: Builds and polishes one assigned slice of the game to AAA quality. Use for ALL substantial implementation work.
model: ${LOOP_MODELS.subagentModel}
effort: ${LOOP_MODELS.subagentEffort}
---
You are an elite AAA game engineer. You receive one specific slice of the game (rendering, weapons, physics, audio, HUD, level design, ...). Implement it to the highest visual and technical quality, verify it actually runs, and report exactly what you changed and how to verify it.
`

const ORCHESTRATION_SUFFIX = `Orchestration rules: you are the orchestrator. Delegate ALL substantial implementation work to parallel \`implementer\` subagents (defined in .claude/agents/implementer.md — they run ${LOOP_MODELS.subagentModel} at ${LOOP_MODELS.subagentEffort} effort), one per workstream, and integrate their results. Verify the game actually builds and runs before you finish. ultracode`

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

function buildImplementPrompt(userPrompt: string, round: number, verdict: Verdict | null): string {
  if (round <= 1 || !verdict) return `${userPrompt}\n\n${ORCHESTRATION_SUFFIX}`
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
    ORCHESTRATION_SUFFIX,
  ].join('\n\n')
}

function buildCriticPrompt(userPrompt: string): string {
  return `You are a brutally harsh AAA game quality critic with fresh eyes. You did not build this project and you have no attachment to it. Judge the project in the current working directory against this bar:

<goal>
${userPrompt}
</goal>

Protocol:
1. Research the real AAA reference named in the goal FIRST. Web search is enabled and the workspace has network access: query for official screenshots and gameplay footage, consult YouTube gameplay videos and analyses (transcripts, stills, thumbnails), and download the best reference stills into ./reference — then VIEW the images you downloaded. Do not judge from memory.
2. Inspect the project. Install dependencies and build/run it if needed. You may write to the workspace to install, build, serve, or capture screenshots — but do NOT modify project source files and do NOT fix anything yourself.
3. Actually look at the running result whenever possible (serve it, screenshot it with any tooling available). Judge visuals, gameplay, performance, completeness, polish.
4. Compare side by side: your captured screenshots of this project against the reference stills you downloaded in step 1. Be specific about every place it falls short: textures, lighting, models, animation, physics, audio, UI, game feel.
5. Score 0.00-1.00 where 1.00 = indistinguishable from the AAA reference and 0.90 = you are genuinely wowed. Anything unfinished, ugly, or broken must score low. Do not be polite. Do not grade on effort.

End your reply with EXACTLY one fenced JSON block and nothing after it:

\`\`\`json
{"score": 0.0, "pass": false, "summary": "<=60 words>", "findings": [{"severity": "critical|major|minor", "text": "one specific, fixable shortfall"}]}
\`\`\`

"pass" may only be true if score >= 0.90 and you would genuinely mistake screenshots of this game for the AAA reference.`
}

interface ActiveRun {
  loopId: string
  runId: string
  child: ChildProcessByStdio<null, Readable, Readable>
  timer: NodeJS.Timeout
  timedOut: boolean
}

export class LoopRunner {
  private current: ActiveRun | null = null
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

    const loop = this.ledger.createLoop({ prompt, workspaceDir, maxRounds, budgetUsd, models: LOOP_MODELS })
    this.log(loop.id, null, 'system', `Loop started — workspace ${workspaceDir}, max ${maxRounds} rounds${budgetUsd ? `, budget $${budgetUsd}` : ''}.`)
    this.log(
      loop.id,
      null,
      'system',
      `Implementer: ${LOOP_MODELS.orchestratorModel} (${LOOP_MODELS.orchestratorEffort}) orchestrating ${LOOP_MODELS.subagentModel} (${LOOP_MODELS.subagentEffort}) subagents · Critic: codex ${LOOP_MODELS.criticModel} (${LOOP_MODELS.criticEffort}), fresh eyes every round.`,
    )
    this.ledger.createRun({ loopId: loop.id, round: 1, role: 'implement', harness: 'claude', prompt: buildImplementPrompt(prompt, 1, null) })
    this.broadcast(loop.id)
    void this.executeNext(loop.id)
    return { ok: true, loopId: loop.id }
  }

  stop(loopId: string): void {
    this.stopRequested.add(loopId)
    if (this.current?.loopId === loopId) {
      this.log(loopId, this.current.runId, 'system', 'Stop requested — interrupting current run (SIGINT).')
      this.interrupt(this.current)
      return
    }
    this.finishLoop(loopId, 'stopped', 'Stopped by user.')
  }

  shutdown(): void {
    if (this.current) this.current.child.kill('SIGINT')
  }

  private interrupt(active: ActiveRun): void {
    active.child.kill('SIGINT')
    setTimeout(() => {
      if (this.current === active) active.child.kill('SIGTERM')
    }, 10_000).unref()
    setTimeout(() => {
      if (this.current === active) active.child.kill('SIGKILL')
    }, 15_000).unref()
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
      fs.writeFileSync(path.join(loop.workspaceDir, 'gauntlet-report.md'), buildReport(loop, runs))
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

  private spawnRun(
    loop: LoopRecord,
    run: RunRecord,
    command: string,
    args: string[],
    env: Record<string, string>,
    timeoutMs: number,
  ): ActiveRun {
    const child = spawn(command, args, { cwd: loop.workspaceDir, env, stdio: ['ignore', 'pipe', 'pipe'] })
    const active: ActiveRun = {
      loopId: loop.id,
      runId: run.id,
      child,
      timedOut: false,
      timer: setTimeout(() => {
        active.timedOut = true
        this.log(loop.id, run.id, 'error', `Run exceeded ${Math.round(timeoutMs / 60_000)} min — interrupting.`)
        this.interrupt(active)
      }, timeoutMs),
    }
    this.current = active
    this.ledger.patchRun(run.id, { status: 'running', startedAt: new Date().toISOString() })
    this.broadcast(loop.id)
    return active
  }

  private async waitForExit(active: ActiveRun): Promise<{ code: number | null; spawnError: string | null }> {
    return new Promise((resolve) => {
      let spawnError: string | null = null
      active.child.on('error', (error) => {
        spawnError = error.message
      })
      active.child.on('close', (code) => {
        clearTimeout(active.timer)
        this.current = null
        resolve({ code, spawnError })
      })
    })
  }

  // ---------------------------------------------------------------- implement

  private async executeImplement(loop: LoopRecord, run: RunRecord): Promise<void> {
    const agentDir = path.join(loop.workspaceDir, '.claude', 'agents')
    fs.mkdirSync(agentDir, { recursive: true })
    fs.writeFileSync(path.join(agentDir, 'implementer.md'), IMPLEMENTER_AGENT_MD)

    this.log(loop.id, run.id, 'system', `● Round ${run.round} — implement (claude ${LOOP_MODELS.orchestratorModel}, effort ${LOOP_MODELS.orchestratorEffort})`)
    const args = [
      '-p',
      run.prompt,
      '--output-format',
      'stream-json',
      '--verbose',
      '--forward-subagent-text',
      '--dangerously-skip-permissions',
      '--model',
      LOOP_MODELS.orchestratorModel,
      '--effort',
      LOOP_MODELS.orchestratorEffort,
    ]
    const active = this.spawnRun(loop, run, 'claude', args, subscriptionEnv({ CLAUDE_CONFIG_DIR: cliHome('claude') }), IMPLEMENT_TIMEOUT_MS)

    // Per-agent accounting: forwarded subagent messages carry parent_tool_use_id.
    // Usage repeats on every event for the same message id, so dedupe by id.
    const agentLabels = new Map<string, { label: string; model: string | null }>()
    const msgUsage = new Map<string, { agentKey: string; model: string | null; usage: Record<string, number>; ts: string }>()
    let result: Record<string, unknown> | null = null
    let fallbackId = 0

    const rl = readline.createInterface({ input: active.child.stdout })
    rl.on('line', (line) => {
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
      const sub = parentId ? '↳ ' : ''

      if (type === 'system' && obj.subtype === 'init') {
        const model = obj.model as string | undefined
        if (model) this.ledger.patchRun(run.id, { model })
        this.log(loop.id, run.id, 'system', `session ${(obj.session_id as string | undefined)?.slice(0, 8) ?? '?'} · model ${model ?? '?'}`)
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
        }
        const content = Array.isArray(message.content) ? (message.content as Record<string, unknown>[]) : []
        for (const block of content) {
          if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
            this.log(loop.id, run.id, parentId ? 'agent' : 'claude', `${sub}${trunc(block.text, 400)}`)
          } else if (block.type === 'tool_use') {
            const name = block.name as string
            const input = block.input as Record<string, unknown> | undefined
            if ((name === 'Agent' || name === 'Task') && block.id) {
              const label = (input?.description as string | undefined) ?? (input?.subagent_type as string | undefined) ?? 'subagent'
              const model = (input?.model as string | undefined) ?? null
              agentLabels.set(block.id as string, { label, model })
              this.log(loop.id, run.id, 'spawn', `⇉ subagent "${label}"${model ? ` (${model})` : ''}`)
            } else {
              this.log(loop.id, run.id, 'tool', `${sub}→ ${name} ${input ? trunc(JSON.stringify(input), 160) : ''}`)
            }
          }
        }
        return
      }
      if (type === 'user') {
        const message = obj.message as Record<string, unknown> | undefined
        const content = Array.isArray(message?.content) ? (message?.content as Record<string, unknown>[]) : []
        for (const block of content) {
          if (block.type === 'tool_result' && block.is_error) {
            this.log(loop.id, run.id, 'error', `${sub}✗ tool error: ${trunc(JSON.stringify(block.content ?? ''), 300)}`)
          }
        }
        return
      }
      if (type === 'result') {
        result = obj
      }
    })
    active.child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trim()
      if (text) this.log(loop.id, run.id, 'stderr', trunc(text, 400))
    })

    const { code, spawnError } = await this.waitForExit(active)
    rl.close()

    const metrics = this.buildImplementMetrics(agentLabels, msgUsage, result)
    const res = result as Record<string, unknown> | null
    const usage = (res?.usage as Record<string, number> | undefined) ?? undefined
    const finishedAt = new Date().toISOString()
    const costUsd = typeof res?.total_cost_usd === 'number' ? (res.total_cost_usd as number) : null

    this.ledger.patchRun(run.id, {
      metrics,
      costUsd,
      inputTokens: usage ? (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) : null,
      outputTokens: usage?.output_tokens ?? null,
      numTurns: typeof res?.num_turns === 'number' ? (res.num_turns as number) : null,
      durationMs: typeof res?.duration_ms === 'number' ? (res.duration_ms as number) : null,
      sessionId: (res?.session_id as string | undefined) ?? null,
      summary: typeof res?.result === 'string' ? (res.result as string).slice(0, 4000) : null,
      finishedAt,
    })
    this.logRunMetrics(loop.id, run.id, 'implement', costUsd, res, metrics)
    this.accumulateCost(loop.id, costUsd)

    const stopReason = this.stopRequested.has(loop.id) ? 'user' : active.timedOut ? 'timeout' : null
    if (stopReason) {
      this.ledger.patchRun(run.id, { status: 'cancelled', error: stopReason === 'user' ? 'Stopped by user.' : 'Timed out.' })
      this.finishLoop(loop.id, 'stopped', stopReason === 'user' ? 'Stopped by user.' : 'Implement run timed out.')
      return
    }
    const succeeded = code === 0 && res !== null && res.is_error !== true
    if (!succeeded) {
      const errText = spawnError ?? (typeof res?.result === 'string' ? trunc(res.result as string, 400) : `claude exited ${code}${res ? ` (${res.subtype})` : ' without a result'}`)
      const rateLimited = /rate.?limit|usage limit|out of extra usage/i.test(errText)
      this.ledger.patchRun(run.id, { status: 'failed', error: errText })
      this.finishLoop(loop.id, 'stopped', rateLimited ? `Rate limited — wait for the window to reset, then start a new run in the same workspace. (${errText})` : `Implement run failed: ${errText}`)
      return
    }
    this.ledger.patchRun(run.id, { status: 'succeeded' })
    if (this.overBudget(loop.id)) return
    this.ledger.createRun({ loopId: loop.id, round: run.round, role: 'critique', harness: 'codex', prompt: buildCriticPrompt(loop.prompt) })
    this.broadcast(loop.id)
    void this.executeNext(loop.id)
  }

  private buildImplementMetrics(
    agentLabels: Map<string, { label: string; model: string | null }>,
    msgUsage: Map<string, { agentKey: string; model: string | null; usage: Record<string, number>; ts: string }>,
    result: Record<string, unknown> | null,
  ): RunMetrics {
    const agents = new Map<string, AgentMetric>()
    const ensure = (key: string): AgentMetric => {
      let agent = agents.get(key)
      if (!agent) {
        const reg = agentLabels.get(key)
        agent = {
          id: key,
          label: key === 'orchestrator' ? 'orchestrator' : (reg?.label ?? `subagent ${key.slice(-6)}`),
          model: key === 'orchestrator' ? LOOP_MODELS.orchestratorModel : (reg?.model ?? LOOP_MODELS.subagentModel),
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

  private async executeCritique(loop: LoopRecord, run: RunRecord): Promise<void> {
    this.log(loop.id, run.id, 'system', `● Round ${run.round} — critique (codex ${LOOP_MODELS.criticModel}, effort ${LOOP_MODELS.criticEffort}, fresh eyes)`)
    const lastMessageFile = path.join(os.tmpdir(), `gauntlet-verdict-${run.id}.txt`)
    const args = [
      'exec',
      '--json',
      '--skip-git-repo-check',
      '-s',
      'workspace-write',
      '-c',
      'sandbox_workspace_write.network_access=true',
      '-c',
      'tools.web_search=true',
      '-m',
      LOOP_MODELS.criticModel,
      '-c',
      `model_reasoning_effort=${LOOP_MODELS.criticEffort}`,
      '-o',
      lastMessageFile,
      run.prompt,
    ]
    const active = this.spawnRun(loop, run, 'codex', args, subscriptionEnv({ CODEX_HOME: cliHome('codex') }), CRITIQUE_TIMEOUT_MS)
    this.ledger.patchRun(run.id, { model: LOOP_MODELS.criticModel })

    let lastAgentMessage = ''
    const tokens = emptyTokens()
    let sawUsage = false
    let failure: string | null = null
    const startedAt = Date.now()

    const rl = readline.createInterface({ input: active.child.stdout })
    rl.on('line', (line) => {
      if (!line.trim()) return
      let obj: Record<string, unknown>
      try {
        obj = JSON.parse(line) as Record<string, unknown>
      } catch {
        return
      }
      const type = obj.type as string
      if (type === 'thread.started') {
        this.log(loop.id, run.id, 'system', `codex thread ${(obj.thread_id as string | undefined)?.slice(0, 8) ?? '?'}`)
      } else if (type === 'item.completed' || type === 'item.updated') {
        const item = obj.item as Record<string, unknown> | undefined
        if (!item) return
        if (item.type === 'agent_message' && typeof item.text === 'string' && type === 'item.completed') {
          lastAgentMessage = item.text
          this.log(loop.id, run.id, 'codex', trunc(item.text, 400))
        } else if (item.type === 'command_execution' && typeof item.command === 'string' && type === 'item.completed') {
          this.log(loop.id, run.id, 'cmd', `$ ${trunc(item.command, 200)}`)
        } else if (item.type === 'web_search' && type === 'item.completed') {
          this.log(loop.id, run.id, 'search', `⌕ ${trunc(String(item.query ?? ''), 200)}`)
        } else if (item.type === 'file_change' && type === 'item.completed') {
          this.log(loop.id, run.id, 'cmd', `✎ file change: ${trunc(JSON.stringify(item.changes ?? ''), 160)}`)
        } else if (item.type === 'error') {
          this.log(loop.id, run.id, 'error', trunc(String(item.message ?? 'codex error'), 300))
        }
      } else if (type === 'turn.completed') {
        const usage = obj.usage as Record<string, number> | undefined
        if (usage) {
          sawUsage = true
          tokens.input += usage.input_tokens ?? 0
          tokens.cacheRead += usage.cached_input_tokens ?? 0
          tokens.cacheWrite += usage.cache_write_input_tokens ?? 0
          tokens.output += usage.output_tokens ?? 0
        }
      } else if (type === 'turn.failed') {
        const error = obj.error as Record<string, unknown> | undefined
        failure = String(error?.message ?? 'codex turn failed')
        this.log(loop.id, run.id, 'error', failure)
      }
    })
    active.child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trim()
      if (text) this.log(loop.id, run.id, 'stderr', trunc(text, 400))
    })

    const { code, spawnError } = await this.waitForExit(active)
    rl.close()

    let verdictText = lastAgentMessage
    try {
      verdictText = fs.readFileSync(lastMessageFile, 'utf8') || lastAgentMessage
      fs.unlinkSync(lastMessageFile)
    } catch {
      /* fall back to streamed message */
    }
    const verdict = parseVerdict(verdictText)
    const durationMs = Date.now() - startedAt
    const criticAgent: AgentMetric = {
      id: 'critic',
      label: 'critic (fresh eyes)',
      model: LOOP_MODELS.criticModel,
      messages: 1,
      tokens,
      firstTs: new Date(startedAt).toISOString(),
      lastTs: new Date().toISOString(),
    }
    this.ledger.patchRun(run.id, {
      metrics: { agents: [criticAgent], perModel: sawUsage ? { [LOOP_MODELS.criticModel]: { costUsd: null, tokens } } : {} },
      inputTokens: sawUsage ? tokens.input + tokens.cacheRead : null,
      outputTokens: sawUsage ? tokens.output : null,
      durationMs,
      summary: verdictText ? verdictText.slice(0, 4000) : null,
      verdict,
      finishedAt: new Date().toISOString(),
    })
    this.log(
      loop.id,
      run.id,
      'metric',
      `▤ critique metrics: in ${formatTokens(tokens.input + tokens.cacheRead)} · out ${formatTokens(tokens.output)} · ${Math.round(durationMs / 60_000)}m (subscription — not in $ total)`,
    )

    const stopReason = this.stopRequested.has(loop.id) ? 'user' : active.timedOut ? 'timeout' : null
    if (stopReason) {
      this.ledger.patchRun(run.id, { status: 'cancelled', error: stopReason === 'user' ? 'Stopped by user.' : 'Timed out.' })
      this.finishLoop(loop.id, 'stopped', stopReason === 'user' ? 'Stopped by user.' : 'Critique run timed out.')
      return
    }
    if (failure || spawnError || code !== 0 || !verdict) {
      const attempts = this.ledger.runsForLoop(loop.id).filter((r) => r.role === 'critique' && r.round === run.round).length
      const errText = spawnError ?? failure ?? (verdict ? `codex exited ${code}` : `no parseable verdict (exit ${code})`)
      this.ledger.patchRun(run.id, { status: 'failed', error: errText })
      if (attempts < MAX_CRITIQUE_ATTEMPTS) {
        this.log(loop.id, run.id, 'system', `Critique failed (${errText}) — retrying with a fresh critic.`)
        this.ledger.createRun({ loopId: loop.id, round: run.round, role: 'critique', harness: 'codex', prompt: buildCriticPrompt(loop.prompt) })
        this.broadcast(loop.id)
        void this.executeNext(loop.id)
        return
      }
      this.finishLoop(loop.id, 'failed', `Critique failed twice: ${errText}`)
      return
    }

    this.ledger.patchRun(run.id, { status: 'succeeded' })
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
      prompt: buildImplementPrompt(loop.prompt, nextRound, verdict),
    })
    this.log(loop.id, null, 'system', `Verdict fed forward — round ${nextRound} queued.`)
    this.broadcast(loop.id)
    void this.executeNext(loop.id)
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
    return this.ledger
      .runsForLoop(loopId)
      .reduce((best, r) => (r.verdict && r.verdict.score > best ? r.verdict.score : best), 0)
  }
}
