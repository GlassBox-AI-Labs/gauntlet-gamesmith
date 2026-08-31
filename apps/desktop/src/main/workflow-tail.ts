import fs from 'node:fs'
import path from 'node:path'
import type { AgentMetric, TokenTotals } from '../shared/loop'
import { estimateCostUsd } from './pricing'

/**
 * Live view of a workflow fan-out.
 *
 * The `wf_*.json` summary next to the session is only written when a workflow
 * ends, so it tells you nothing while the run is going. The runtime does write
 * a full transcript per agent as it works, under
 * `<session>/subagents/workflows/<runId>/`:
 *
 *   journal.jsonl            one `started` per agent, one `result` when it finishes
 *   agent-<id>.jsonl         the agent's whole conversation, appended live
 *   agent-<id>.meta.json     `{ agentType, spawnDepth }`
 *
 * Those transcripts are big — 54MB across nine agents on a single round — so
 * this reads each file once, from a remembered byte offset, and keeps only the
 * totals. It also carries the real `input/output/cache` usage split, which the
 * summary file flattens to one number, so per-agent cost is priceable here.
 */

interface AgentAccumulator {
  agentId: string
  runId: string
  agentType: string | null
  prompt: string | null
  model: string | null
  /** Keyed by message id: the runtime writes a message repeatedly as it streams. */
  usageByMessage: Map<string, Record<string, number>>
  toolCalls: number
  lastTool: string | null
  lastText: string | null
  result: string | null
  firstTs: string | null
  lastTs: string | null
  done: boolean
}

function emptyTokens(): TokenTotals {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
}

function trim(value: string | null | undefined, max: number): string | undefined {
  if (!value) return undefined
  const flat = value.replace(/\s+/g, ' ').trim()
  if (!flat) return undefined
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

/**
 * Every agent in a fan-out is handed the same preamble, so the first line that
 * differs between them is the line that says what this one was actually asked
 * to do. Falls back to the first non-empty line when they share nothing.
 */
export function deriveLabels(prompts: (string | null)[]): (string | null)[] {
  const split = prompts.map((p) => (p ? p.split('\n') : []))
  const real = split.filter((lines) => lines.length > 0)
  if (real.length === 0) return prompts.map(() => null)

  let common = 0
  if (real.length > 1) {
    const shortest = Math.min(...real.map((l) => l.length))
    while (common < shortest && real.every((lines) => lines[common] === real[0][common])) common += 1
  }
  return split.map((lines) => {
    if (lines.length === 0) return null
    const tail = lines.slice(common).find((l) => l.trim()) ?? lines.find((l) => l.trim())
    // Keep the first sentence; the rest of the line is usually instructions.
    // Colons are kept — they carry the subject ("W1: WORLD RENDERING").
    const sentence = tail?.split(/\.\s/)[0] ?? null
    return trim(sentence, 70) ?? null
  })
}

export class WorkflowTail {
  private agents = new Map<string, AgentAccumulator>()
  private offsets = new Map<string, number>()
  private partials = new Map<string, Buffer>()

  /** @param dir `<session>/subagents/workflows` */
  constructor(private readonly dir: string) {}

  /** Read whatever has been appended since the last call. */
  poll(): AgentMetric[] {
    let runIds: string[]
    try {
      runIds = fs.readdirSync(this.dir).filter((f) => f.startsWith('wf_'))
    } catch {
      return []
    }
    for (const runId of runIds) {
      const runDir = path.join(this.dir, runId)
      this.readJournal(runDir, runId)
      let files: string[]
      try {
        files = fs.readdirSync(runDir).filter((f) => f.startsWith('agent-') && f.endsWith('.jsonl'))
      } catch {
        continue
      }
      for (const file of files) this.readAgent(path.join(runDir, file), runDir, runId, file.slice(6, -6))
    }
    return this.toMetrics()
  }

  /** Read new whole lines from a file, remembering where we stopped. */
  private readLines(file: string): string[] {
    let size: number
    try {
      size = fs.statSync(file).size
    } catch {
      return []
    }
    const offset = this.offsets.get(file) ?? 0
    // A file that shrank was replaced; start over rather than read garbage.
    if (size < offset) {
      this.offsets.set(file, 0)
      this.partials.delete(file)
      return this.readLines(file)
    }
    if (size === offset) return []

    let fd: number
    try {
      fd = fs.openSync(file, 'r')
    } catch {
      return []
    }
    try {
      const buf = Buffer.allocUnsafe(size - offset)
      const read = fs.readSync(fd, buf, 0, size - offset, offset)
      this.offsets.set(file, offset + read)
      // Split on the byte, not the string: a read can land mid-character, and
      // decoding the tail early would corrupt it.
      const combined = Buffer.concat([this.partials.get(file) ?? Buffer.alloc(0), buf.subarray(0, read)])
      const lastNewline = combined.lastIndexOf(0x0a)
      if (lastNewline < 0) {
        this.partials.set(file, combined)
        return []
      }
      this.partials.set(file, combined.subarray(lastNewline + 1))
      return combined.subarray(0, lastNewline).toString('utf8').split('\n')
    } finally {
      fs.closeSync(fd)
    }
  }

  private ensure(agentId: string, runId: string, runDir: string): AgentAccumulator {
    let agent = this.agents.get(agentId)
    if (!agent) {
      let agentType: string | null = null
      try {
        agentType = (JSON.parse(fs.readFileSync(path.join(runDir, `agent-${agentId}.meta.json`), 'utf8')) as { agentType?: string })
          .agentType ?? null
      } catch {
        /* meta is written alongside the transcript; absent is fine */
      }
      agent = {
        agentId,
        runId,
        agentType,
        prompt: null,
        model: null,
        usageByMessage: new Map(),
        toolCalls: 0,
        lastTool: null,
        lastText: null,
        result: null,
        firstTs: null,
        lastTs: null,
        done: false,
      }
      this.agents.set(agentId, agent)
    }
    return agent
  }

  private readJournal(runDir: string, runId: string): void {
    for (const line of this.readLines(path.join(runDir, 'journal.jsonl'))) {
      if (!line.trim()) continue
      let obj: { type?: string; agentId?: string; result?: unknown }
      try {
        obj = JSON.parse(line)
      } catch {
        continue
      }
      if (!obj.agentId) continue
      const agent = this.ensure(obj.agentId, runId, runDir)
      if (obj.type === 'result') {
        agent.done = true
        if (typeof obj.result === 'string') agent.result = obj.result
      }
    }
  }

  private readAgent(file: string, runDir: string, runId: string, agentId: string): void {
    const agent = this.ensure(agentId, runId, runDir)
    for (const line of this.readLines(file)) {
      if (!line.trim()) continue
      let obj: Record<string, unknown>
      try {
        obj = JSON.parse(line) as Record<string, unknown>
      } catch {
        continue
      }
      const ts = typeof obj.timestamp === 'string' ? obj.timestamp : null
      if (ts) {
        if (!agent.firstTs || ts < agent.firstTs) agent.firstTs = ts
        if (!agent.lastTs || ts > agent.lastTs) agent.lastTs = ts
      }
      const message = obj.message as Record<string, unknown> | undefined
      if (obj.type === 'user' && agent.prompt === null && typeof message?.content === 'string') {
        agent.prompt = message.content as string
      } else if (obj.type === 'assistant' && message) {
        if (typeof message.model === 'string') agent.model = message.model
        const id = typeof message.id === 'string' ? message.id : null
        const usage = message.usage as Record<string, number> | undefined
        // The same message is rewritten as it streams; keep one copy per id.
        if (id && usage) agent.usageByMessage.set(id, usage)
        const content = Array.isArray(message.content) ? (message.content as Record<string, unknown>[]) : []
        for (const block of content) {
          if (block.type === 'tool_use') {
            agent.toolCalls += 1
            const input = block.input as Record<string, unknown> | undefined
            const detail = input?.command ?? input?.file_path ?? input?.pattern ?? input?.query
            agent.lastTool = `${String(block.name)}${detail ? ` ${trim(String(detail), 90)}` : ''}`
          }
          else if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) agent.lastText = block.text
        }
      }
    }
  }

  private toMetrics(): AgentMetric[] {
    const list = [...this.agents.values()].sort((a, b) => (a.firstTs ?? '').localeCompare(b.firstTs ?? ''))
    const labels = deriveLabels(list.map((a) => a.prompt))
    return list.map((agent, index) => {
      const tokens = emptyTokens()
      for (const usage of agent.usageByMessage.values()) {
        tokens.input += usage.input_tokens ?? 0
        tokens.output += usage.output_tokens ?? 0
        tokens.cacheRead += usage.cache_read_input_tokens ?? 0
        tokens.cacheWrite += usage.cache_creation_input_tokens ?? 0
      }
      const durationMs =
        agent.firstTs && agent.lastTs ? Math.max(0, new Date(agent.lastTs).getTime() - new Date(agent.firstTs).getTime()) : undefined
      return {
        id: `wf:${agent.runId}:${agent.agentId}`,
        label: labels[index] ?? `agent ${agent.agentId.slice(-6)}`,
        model: agent.model,
        messages: agent.usageByMessage.size,
        tokens,
        firstTs: agent.firstTs,
        lastTs: agent.lastTs,
        done: agent.done,
        source: 'workflow',
        state: agent.done ? 'done' : 'progress',
        totalTokens: tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite,
        toolCalls: agent.toolCalls,
        durationMs,
        costUsd: estimateCostUsd(agent.model, tokens),
        agentType: agent.agentType ?? undefined,
        prompt: trim(agent.prompt, 4000),
        lastTool: agent.lastTool ?? undefined,
        note: trim(agent.result ?? agent.lastText, 300),
      }
    })
  }
}

/** `<session>/subagents/workflows`, where the live transcripts are written. */
export function workflowTailDir(claudeHome: string, workspaceDir: string, sessionId: string): string {
  return path.join(claudeHome, 'projects', workspaceDir.replace(/[^a-zA-Z0-9-]/g, '-'), sessionId, 'subagents', 'workflows')
}
