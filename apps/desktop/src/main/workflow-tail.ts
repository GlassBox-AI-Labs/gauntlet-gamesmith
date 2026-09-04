import fs from 'node:fs'
import path from 'node:path'
import { readExactFileDescriptor } from './bounded-fd'
import { workflowAgentMetricId } from '../shared/agent-id'
import type { AgentMetric, TokenTotals } from '../shared/loop'
import { estimateCostUsd } from './pricing'
import { normalizeStreamUsage, translateClaudeLine, type StreamEvent } from './streams/claude-stream'
import { safeWorkflowRuntimePath } from './workflow-path'

const MAX_WORKFLOW_RUNS = 128
const MAX_WORKFLOW_AGENTS = 256
const MAX_DIRECTORY_ENTRIES = 1_024
const MAX_READ_BYTES_PER_POLL = 1024 * 1024
const MAX_PARTIAL_LINE_BYTES = 1024 * 1024
const MAX_META_BYTES = 64 * 1024
const MAX_POLL_ENTRIES = 2_048
const MAX_POLL_READ_BYTES = 2 * 1024 * 1024
const MAX_TOTAL_WORKFLOW_AGENTS = 511
const MAX_PROJECTION_OFFSETS = 1_000
const MAX_RETAINED_USAGE_IDS = 32_768
const MAX_RETAINED_TOOL_IDS = 32_768
const MAX_RETAINED_PROMPT_CHARS = 4_000
const MAX_RETAINED_NOTE_CHARS = 300
const WORKFLOW_AGENT_ID = /^[a-zA-Z0-9_-]{1,128}$/

interface PollBudget {
  entries: number
  bytes: number
  exhausted: boolean
}

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
  /** Tool blocks recur in cumulative assistant messages; their ids do not. */
  toolIds: Set<string>
  toolCalls: number
  lastTool: string | null
  lastText: string | null
  result: string | null
  firstTs: string | null
  lastTs: string | null
  done: boolean
  spawnLogged: boolean
  doneLogged: boolean
}

export interface WorkflowLogEvent extends StreamEvent {
  agentId: string
}

export interface WorkflowPollResult {
  agents: AgentMetric[]
  events: WorkflowLogEvent[]
}

function emptyTokens(): TokenTotals {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
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
  private identities = new Map<string, { dev: number; ino: number }>()
  private partials = new Map<string, Buffer>()
  private pollEvents: WorkflowLogEvent[] = []
  private reportedErrors = new Set<string>()
  private retainedUsageIds = 0
  private retainedToolIds = 0
  private readonly dir: string
  private readonly ownerRoot: string

  /** @param dir `<session>/subagents/workflows` */
  constructor(
    dir: string,
    initialOffsets: Record<string, number> = {},
    ownerRoot = dir,
    initialIdentities: Record<string, { dev: number; ino: number }> = {},
  ) {
    const absoluteDir = path.resolve(dir)
    try {
      if (fs.lstatSync(absoluteDir).isSymbolicLink()) throw new Error('workflow transcript root must not be a symbolic link')
      this.dir = fs.realpathSync(absoluteDir)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      this.dir = absoluteDir
    }
    const absoluteOwner = path.resolve(ownerRoot)
    try {
      if (fs.lstatSync(absoluteOwner).isSymbolicLink()) throw new Error('workflow owner root must not be a symbolic link')
      this.ownerRoot = fs.realpathSync(absoluteOwner)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      this.ownerRoot = absoluteOwner
    }
    for (const [file, offset] of Object.entries(initialOffsets)) {
      const absolute = path.join(this.dir, file)
      const identity = initialIdentities[file]
      if (identity && Number.isSafeInteger(identity.dev) && identity.dev > 0 && Number.isSafeInteger(identity.ino) && identity.ino > 0) {
        this.identities.set(absolute, identity)
      } else if (offset > 0) {
        throw new Error(`Workflow transcript ${file} has a restored nonzero offset without its original file identity.`)
      }
      this.offsets.set(absolute, offset)
    }
  }

  /** Checkpoint only complete newline boundaries for crash-safe reattachment. */
  snapshot(): Record<string, number> {
    return Object.fromEntries(
      [...this.offsets].map(([file, offset]) => [
        path.relative(this.dir, file),
        Math.max(0, offset - (this.partials.get(file)?.length ?? 0)),
      ]),
    )
  }

  identitySnapshot(): Record<string, { dev: number; ino: number }> {
    return Object.fromEntries(
      [...this.identities]
        .filter(([file]) => this.offsets.has(file))
        .map(([file, identity]) => [path.relative(this.dir, file), identity] as const)
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0),
    )
  }

  /** Read whatever has been appended since the last call. */
  poll(): AgentMetric[] {
    return this.pollWithEvents().agents
  }

  /** Metrics plus the exact newly observed events for durable live logging. */
  pollWithEvents(): WorkflowPollResult {
    this.pollEvents = []
    const budget: PollBudget = { entries: MAX_POLL_ENTRIES, bytes: MAX_POLL_READ_BYTES, exhausted: false }
    const runIds: string[] = []
    let directory: fs.Dir | null = null
    let canonicalRoot: string
    try {
      const root = fs.lstatSync(this.dir)
      if (!root.isDirectory() || root.isSymbolicLink()) throw new Error('workflow transcript root is not a real directory')
      canonicalRoot = fs.realpathSync(this.dir)
      const rootRelative = path.relative(this.ownerRoot, canonicalRoot)
      const canonicalStat = fs.lstatSync(canonicalRoot)
      if (
        rootRelative.startsWith('..')
        || path.isAbsolute(rootRelative)
        || canonicalStat.dev !== root.dev
        || canonicalStat.ino !== root.ino
      ) throw new Error('workflow transcript root escapes its owner or changed during inspection')
      directory = fs.opendirSync(canonicalRoot)
      let exhausted = false
      for (let seen = 0; seen < MAX_DIRECTORY_ENTRIES; seen += 1) {
        if (budget.entries <= 0) {
          budget.exhausted = true
          break
        }
        const entry = directory.readSync()
        if (!entry) {
          exhausted = true
          break
        }
        budget.entries -= 1
        if (/^wf_[a-zA-Z0-9_-]{1,128}$/.test(entry.name)) {
          if (entry.isDirectory() && !entry.isSymbolicLink()) runIds.push(entry.name)
          else this.reportError(`unsafe-run:${entry.name}`, 'workflow-tail', `inspect workflow run ${entry.name}`, new Error('entry is not a regular directory'))
        }
        if (runIds.length >= MAX_WORKFLOW_RUNS) break
      }
      if (!exhausted) this.reportError('directory-limit', 'workflow-tail', 'scan all workflow transcripts', new Error(`inventory reached its ${MAX_WORKFLOW_RUNS}-run/${MAX_DIRECTORY_ENTRIES}-entry safety limit`))
      this.reportedErrors.delete('directory')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.reportError('directory', 'workflow-tail', 'scan workflow transcripts', error)
      return { agents: [], events: this.pollEvents }
    } finally {
      directory?.closeSync()
    }
    for (const runId of runIds.sort()) {
      if (budget.exhausted) break
      const runDir = path.join(canonicalRoot!, runId)
      try {
        const stat = fs.lstatSync(runDir)
        const canonical = fs.realpathSync(runDir)
        const canonicalStat = fs.lstatSync(canonical)
        const relative = path.relative(canonicalRoot!, canonical)
        if (
          !stat.isDirectory()
          || stat.isSymbolicLink()
          || relative.startsWith('..')
          || path.isAbsolute(relative)
          || canonicalStat.dev !== stat.dev
          || canonicalStat.ino !== stat.ino
        ) {
          throw new Error('workflow run directory escapes the transcript root or is a symbolic link')
        }
      } catch (error) {
        this.reportError(`unsafe-run-path:${runId}`, `workflow:${runId}`, `open workflow run ${runId}`, error)
        continue
      }
      this.readJournal(runDir, runId, budget)
      const files: string[] = []
      let runDirectory: fs.Dir | null = null
      try {
        runDirectory = fs.opendirSync(runDir)
        let exhausted = false
        for (let seen = 0; seen < MAX_DIRECTORY_ENTRIES; seen += 1) {
          if (budget.entries <= 0) {
            budget.exhausted = true
            break
          }
          const entry = runDirectory.readSync()
          if (!entry) {
            exhausted = true
            break
          }
          budget.entries -= 1
          if (/^agent-[a-zA-Z0-9_-]{1,128}\.jsonl$/.test(entry.name)) {
            if (entry.isFile() && !entry.isSymbolicLink()) files.push(entry.name)
            else this.reportError(`unsafe-agent:${runId}:${entry.name}`, `workflow:${runId}`, `inspect ${entry.name}`, new Error('entry is not a regular transcript'))
          }
          if (files.length >= MAX_WORKFLOW_AGENTS) break
        }
        if (!exhausted) this.reportError(`run-directory-limit:${runId}`, `workflow:${runId}`, 'scan all workflow agent transcripts', new Error(`inventory reached its ${MAX_WORKFLOW_AGENTS}-agent/${MAX_DIRECTORY_ENTRIES}-entry safety limit`))
        this.reportedErrors.delete(`run-directory:${runId}`)
      } catch (error) {
        this.reportError(`run-directory:${runId}`, `workflow:${runId}`, 'scan workflow run transcripts', error)
        continue
      } finally {
        runDirectory?.closeSync()
      }
      for (const file of files.sort()) {
        if (budget.exhausted) break
        this.readAgent(path.join(runDir, file), runDir, runId, file.slice(6, -6), budget)
      }
    }
    if (budget.exhausted) {
      this.reportError(
        'aggregate-poll-limit',
        'workflow-tail',
        'project every workflow transcript in one poll',
        new Error(`aggregate ${MAX_POLL_ENTRIES}-entry/${MAX_POLL_READ_BYTES}-byte poll limit reached; remaining evidence will be read incrementally`),
      )
    }
    return { agents: this.toMetrics(), events: this.pollEvents }
  }

  /** Read new whole lines from a file, remembering where we stopped. */
  private readLines(file: string, budget: PollBudget): string[] {
    if (!this.offsets.has(file) && this.offsets.size >= MAX_PROJECTION_OFFSETS) {
      this.reportError(
        'aggregate-offset-limit',
        'workflow-tail',
        'checkpoint every workflow transcript',
        new Error(`aggregate ${MAX_PROJECTION_OFFSETS}-stream checkpoint limit reached; remaining raw evidence stays on disk`),
      )
      return []
    }
    let inspected: fs.Stats
    try {
      inspected = fs.lstatSync(file)
      if (!inspected.isFile() || inspected.isSymbolicLink() || inspected.nlink !== 1) throw new Error('transcript is not a singly linked regular file')
      this.reportedErrors.delete(`stat:${file}`)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.reportError(`stat:${file}`, 'workflow-tail', `inspect ${path.basename(file)}`, error)
      return []
    }
    const offset = this.offsets.get(file) ?? 0
    const priorIdentity = this.identities.get(file)
    if (priorIdentity && (priorIdentity.dev !== inspected.dev || priorIdentity.ino !== inspected.ino)) {
      throw new Error(`Workflow transcript ${path.basename(file)} changed identity after it was admitted; refusing replacement evidence.`)
    }
    if (!priorIdentity) this.identities.set(file, { dev: inspected.dev, ino: inspected.ino })
    if (inspected.size < offset) {
      throw new Error(`Workflow transcript ${path.basename(file)} shrank after ${offset} bytes were observed; refusing incomplete or replacement evidence.`)
    }
    if (inspected.size === offset) return []
    if (budget.bytes <= 0) {
      budget.exhausted = true
      return []
    }

    let fd: number | null = null
    try {
      fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0))
      const opened = fs.fstatSync(fd)
      if (
        !opened.isFile()
        || opened.nlink !== 1
        || opened.dev !== inspected.dev
        || opened.ino !== inspected.ino
        || opened.size < inspected.size
      ) throw new Error('transcript changed identity or shrank while it was being inspected')
      this.reportedErrors.delete(`read:${file}`)
    } catch (error) {
      if (fd !== null) fs.closeSync(fd)
      if (error instanceof Error && /changed identity|shrank/.test(error.message)) throw error
      this.reportError(`read:${file}`, 'workflow-tail', `read ${path.basename(file)}`, error)
      return []
    }
    try {
      const buf = Buffer.allocUnsafe(Math.min(MAX_READ_BYTES_PER_POLL, inspected.size - offset, budget.bytes))
      const read = fs.readSync(fd, buf, 0, buf.length, offset)
      budget.bytes -= read
      if (budget.bytes <= 0 && inspected.size > offset + read) budget.exhausted = true
      this.offsets.set(file, offset + read)
      // Split on the byte, not the string: a read can land mid-character, and
      // decoding the tail early would corrupt it.
      const combined = Buffer.concat([this.partials.get(file) ?? Buffer.alloc(0), buf.subarray(0, read)])
      const lastNewline = combined.lastIndexOf(0x0a)
      if (lastNewline < 0) {
        if (combined.length > MAX_PARTIAL_LINE_BYTES) {
          this.partials.set(file, combined.subarray(-MAX_PARTIAL_LINE_BYTES))
          this.reportError(`partial-limit:${file}`, 'workflow-tail', `project ${path.basename(file)}`, new Error('unterminated event exceeded the 1 MiB projection limit; raw evidence remains on disk'))
        } else {
          this.partials.set(file, combined)
        }
        return []
      }
      this.partials.set(file, combined.subarray(lastNewline + 1))
      return combined.subarray(0, lastNewline).toString('utf8').split('\n').filter((line) => {
        if (Buffer.byteLength(line, 'utf8') <= MAX_PARTIAL_LINE_BYTES) return true
        this.reportError(`line-limit:${file}`, 'workflow-tail', `project ${path.basename(file)}`, new Error('event exceeded the 1 MiB projection limit; raw evidence remains on disk'))
        return false
      })
    } finally {
      fs.closeSync(fd)
    }
  }

  private ensure(agentId: string, runId: string, runDir: string, budget: PollBudget): AgentAccumulator | null {
    const key = `${runId}:${agentId}`
    let agent = this.agents.get(key)
    if (!agent) {
      if (this.agents.size >= MAX_TOTAL_WORKFLOW_AGENTS) {
        this.reportError(
          'aggregate-agent-limit',
          'workflow-tail',
          'retain every workflow agent projection',
          new Error(`aggregate ${MAX_TOTAL_WORKFLOW_AGENTS}-agent persistence limit reached; remaining raw evidence stays on disk`),
        )
        return null
      }
      let agentType: string | null = null
      const metaPath = path.join(runDir, `agent-${agentId}.meta.json`)
      try {
        const descriptor = fs.openSync(metaPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0))
        try {
          const stat = fs.fstatSync(descriptor)
          if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_META_BYTES) throw new Error('metadata is not a bounded regular file')
          if (stat.size > budget.bytes) {
            budget.exhausted = true
            throw new Error('aggregate workflow poll byte limit reached before metadata read')
          }
          budget.bytes -= stat.size
          const parsed: unknown = JSON.parse(
            readExactFileDescriptor(descriptor, stat.size, MAX_META_BYTES, 'workflow agent metadata').toString('utf8'),
          )
          if (!isRecord(parsed)) throw new Error('metadata is not an object')
          if (typeof parsed.agentType === 'string' && parsed.agentType.length <= 128) agentType = parsed.agentType
        } finally {
          fs.closeSync(descriptor)
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.reportError(`meta:${metaPath}`, `wf:${runId}:${agentId}`, 'read workflow agent metadata', error)
      }
      agent = {
        agentId,
        runId,
        agentType,
        prompt: null,
        model: null,
        usageByMessage: new Map(),
        toolIds: new Set(),
        toolCalls: 0,
        lastTool: null,
        lastText: null,
        result: null,
        firstTs: null,
        lastTs: null,
        done: false,
        spawnLogged: false,
        doneLogged: false,
      }
      this.agents.set(key, agent)
    }
    return agent
  }

  private readJournal(runDir: string, runId: string, budget: PollBudget): void {
    for (const line of this.readLines(path.join(runDir, 'journal.jsonl'), budget)) {
      if (!line.trim()) continue
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch (error) {
        this.reportError(`journal:${runId}`, `workflow:${runId}`, 'parse workflow journal event', error)
        continue
      }
      if (!isRecord(parsed)) {
        this.pollEvents.push({
          agentId: `workflow:${runId}`,
          channel: 'system',
          kind: 'system',
          text: `unhandled malformed workflow journal event: ${trim(line, 160) ?? 'empty event'}`,
        })
        continue
      }
      const obj = parsed
      if (typeof obj.agentId !== 'string' || !WORKFLOW_AGENT_ID.test(obj.agentId)) {
        this.pollEvents.push({
          agentId: `workflow:${runId}`,
          channel: 'system',
          kind: 'system',
          text: `unhandled workflow journal event without an agent id or with an invalid one: ${trim(line, 160) ?? 'empty event'}`,
        })
        continue
      }
      const agent = this.ensure(obj.agentId, runId, runDir, budget)
      if (!agent) continue
      if (obj.type === 'started' && !agent.spawnLogged) {
        agent.spawnLogged = true
        this.pollEvents.push({
          agentId: this.logAgentId(agent),
          channel: 'tool',
          kind: 'spawn',
          text: `⇉ workflow agent "${agent.agentType ?? agent.agentId}" started`,
        })
      }
      if (obj.type === 'result') {
        agent.done = true
        if (typeof obj.result === 'string') agent.result = trim(obj.result, MAX_RETAINED_NOTE_CHARS) ?? null
        if (!agent.doneLogged) {
          agent.doneLogged = true
          this.pollEvents.push({
            agentId: this.logAgentId(agent),
            channel: 'tool',
            kind: 'spawn',
            text: `⇊ workflow agent "${agent.agentType ?? agent.agentId}" finished`,
          })
          if (typeof obj.result === 'string' && obj.result.trim()) {
            this.pollEvents.push({
              agentId: this.logAgentId(agent),
              channel: 'output',
              kind: 'agent',
              text: trim(obj.result, 400) ?? 'workflow agent finished',
            })
          }
        }
      } else if (obj.type !== 'started') {
        this.pollEvents.push({
          agentId: this.logAgentId(agent),
          channel: 'system',
          kind: 'system',
          text: `unhandled workflow journal event "${obj.type ?? 'unknown'}"`,
        })
      }
    }
  }

  private readAgent(file: string, runDir: string, runId: string, agentId: string, budget: PollBudget): void {
    const agent = this.ensure(agentId, runId, runDir, budget)
    if (!agent) return
    for (const line of this.readLines(file, budget)) {
      if (!line.trim()) continue
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch {
        for (const event of translateClaudeLine(line)?.events ?? []) {
          this.pollEvents.push({ ...event, agentId: this.logAgentId(agent) })
        }
        continue
      }
      if (!isRecord(parsed)) {
        for (const event of translateClaudeLine(line)?.events ?? []) {
          this.pollEvents.push({ ...event, agentId: this.logAgentId(agent) })
        }
        continue
      }
      const obj = parsed
      const parsedTimestamp = typeof obj.timestamp === 'string' ? Date.parse(obj.timestamp) : Number.NaN
      const ts = Number.isFinite(parsedTimestamp) ? new Date(parsedTimestamp).toISOString() : null
      if (ts) {
        if (!agent.firstTs || ts < agent.firstTs) agent.firstTs = ts
        if (!agent.lastTs || ts > agent.lastTs) agent.lastTs = ts
      }
      const message = isRecord(obj.message) ? obj.message : undefined
      if (obj.type === 'user' && agent.prompt === null && typeof message?.content === 'string') {
        const rawPrompt = message.content as string
        agent.prompt = rawPrompt.slice(0, MAX_RETAINED_PROMPT_CHARS)
        if (rawPrompt.length > MAX_RETAINED_PROMPT_CHARS) {
          this.reportError(
            `prompt-limit:${runId}:${agentId}`,
            this.logAgentId(agent),
            'retain the complete workflow prompt projection',
            new Error(`prompt exceeded ${MAX_RETAINED_PROMPT_CHARS} characters; the complete raw event stays on disk`),
          )
        }
        const chunks = Array.from({ length: Math.max(1, Math.ceil(agent.prompt.length / 3_600)) }, (_, index) =>
          agent.prompt!.slice(index * 3_600, (index + 1) * 3_600),
        )
        for (const [index, chunk] of chunks.entries()) {
          this.pollEvents.push({
            agentId: this.logAgentId(agent),
            channel: 'prompt',
            kind: 'prompt',
            text: `Workflow agent brief${chunks.length > 1 ? ` (${index + 1}/${chunks.length})` : ''}:\n${chunk}`,
          })
        }
      } else if (obj.type === 'assistant' && message) {
        if (typeof message.model === 'string') agent.model = message.model
        const id = typeof message.id === 'string' && message.id.length > 0 && message.id.length <= 256 ? message.id : null
        const usage = normalizeStreamUsage(message.usage)
        // The same message is rewritten as it streams; keep one copy per id.
        if (id && usage) {
          if (agent.usageByMessage.has(id)) agent.usageByMessage.set(id, usage)
          else if (this.retainedUsageIds < MAX_RETAINED_USAGE_IDS) {
            agent.usageByMessage.set(id, usage)
            this.retainedUsageIds += 1
          } else {
            this.reportError(
              'aggregate-usage-id-limit',
              'workflow-tail',
              'retain every workflow message usage id',
              new Error(`aggregate ${MAX_RETAINED_USAGE_IDS}-message accounting limit reached; remaining raw evidence stays on disk`),
            )
          }
        }
        const content = Array.isArray(message.content) ? message.content : []
        for (const [index, rawBlock] of content.entries()) {
          if (!isRecord(rawBlock)) continue
          const block = rawBlock
          if (block.type === 'tool_use') {
            const toolId = typeof block.id === 'string' && block.id.length > 0 && block.id.length <= 256
              ? block.id
              : `${id ?? 'no-message'}:${index}:${String(block.name ?? '').slice(0, 128)}`
            if (agent.toolIds.has(toolId)) continue
            if (this.retainedToolIds >= MAX_RETAINED_TOOL_IDS) {
              this.reportError(
                'aggregate-tool-id-limit',
                'workflow-tail',
                'retain every workflow tool id',
                new Error(`aggregate ${MAX_RETAINED_TOOL_IDS}-tool accounting limit reached; remaining raw evidence stays on disk`),
              )
              continue
            }
            agent.toolIds.add(toolId)
            this.retainedToolIds += 1
            agent.toolCalls = agent.toolIds.size
            const input = block.input as Record<string, unknown> | undefined
            const detail = input?.command ?? input?.file_path ?? input?.pattern ?? input?.query
            agent.lastTool = trim(`${String(block.name)}${detail ? ` ${trim(String(detail), 90)}` : ''}`, 160) ?? null
          }
          else if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
            agent.lastText = trim(block.text, MAX_RETAINED_NOTE_CHARS) ?? null
          }
        }
      }
      if (obj.type !== 'user' || Array.isArray(message?.content)) {
        for (const event of translateClaudeLine(line)?.events ?? []) {
          this.pollEvents.push({ ...event, agentId: this.logAgentId(agent) })
        }
      }
    }
  }

  private logAgentId(agent: AgentAccumulator): string {
    return workflowAgentMetricId(agent.runId, agent.agentId)
  }

  private reportError(key: string, agentId: string, action: string, error: unknown): void {
    if (this.reportedErrors.has(key)) return
    this.reportedErrors.add(key)
    this.pollEvents.push({
      agentId,
      channel: 'error',
      kind: 'error',
      text: `could not ${action}: ${error instanceof Error ? error.message : String(error)}`,
    })
  }

  private toMetrics(): AgentMetric[] {
    const list = [...this.agents.values()].sort((a, b) => {
      const left = a.firstTs ?? ''
      const right = b.firstTs ?? ''
      return left < right ? -1 : left > right ? 1 : 0
    })
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
        id: workflowAgentMetricId(agent.runId, agent.agentId),
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
  return safeWorkflowRuntimePath(claudeHome, workspaceDir, sessionId, ['subagents', 'workflows'])
}
