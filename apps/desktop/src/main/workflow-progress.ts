import fs from 'node:fs'
import path from 'node:path'
import { readExactFileDescriptor } from './bounded-fd'
import { workflowAgentMetricId } from '../shared/agent-id'
import type { AgentMetric } from '../shared/build'
import { safeWorkflowRuntimePath } from './workflow-path'

/**
 * When the orchestrator runs at ultracode effort it delegates through the
 * Workflow tool, whose agents live in a separate runtime — they never appear in
 * the session's message stream as Agent/Task tool calls, so the stream parser
 * cannot see them. The runtime does write each run to disk, though, one JSON
 * file per workflow, updated while the run is still going. Reading those files
 * is the only way to show what the fan-out is actually doing.
 */

const MAX_WORKFLOW_RUNS = 128
const MAX_WORKFLOW_AGENTS = 512
const MAX_DIRECTORY_ENTRIES = 1_024
const MAX_ATTEMPT_FILE_BYTES = 1024 * 1024
const MAX_TOTAL_READ_BYTES = 2 * 1024 * 1024
const MAX_TOTAL_AGENTS = 512
const MAX_TEXT_LENGTH = 1_000
const MAX_DATE_MS = 8_640_000_000_000_000

export interface WorkflowRunSummary {
  runId: string
  name: string
  status: string
  agentCount: number
  totalTokens: number
  totalToolCalls: number
}

export interface WorkflowProgress {
  runs: WorkflowRunSummary[]
  agents: AgentMetric[]
  totalTokens: number
  /** Present when bounded projection intentionally omitted remaining evidence. */
  warning?: string
}

/**
 * The runtime keys its directory by the session id, alongside that session's
 * own transcript: <config>/projects/<workspace-slug>/<session-id>/workflows/.
 */
export function workflowDir(claudeHome: string, workspaceDir: string, sessionId: string): string {
  return safeWorkflowRuntimePath(claudeHome, workspaceDir, sessionId, ['workflows'])
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0
}

function timestamp(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MAX_DATE_MS ? value : undefined
}

function iso(value: unknown): string | null {
  const ms = timestamp(value)
  return ms === undefined ? null : new Date(ms).toISOString()
}

function text(value: unknown, max = MAX_TEXT_LENGTH): string | undefined {
  return typeof value === 'string' && value.length <= max ? value : undefined
}

function identifier(value: unknown): string | undefined {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value) ? value : undefined
}

function trim(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string' || !value) return undefined
  const flat = value.replace(/\s+/g, ' ').trim()
  if (!flat) return undefined
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

/**
 * Read every workflow this session has launched. Returns an empty result when
 * the directory does not exist, which is the normal case for a run whose
 * orchestrator never reached for a workflow.
 */
export function readWorkflowProgress(dir: string, sinceMs = 0): WorkflowProgress {
  const files: string[] = []
  let directory: fs.Dir | null = null
  try {
    const root = fs.lstatSync(dir)
    if (!root.isDirectory() || root.isSymbolicLink()) return { runs: [], agents: [], totalTokens: 0 }
    directory = fs.opendirSync(dir)
    for (let seen = 0; seen < MAX_DIRECTORY_ENTRIES; seen += 1) {
      const entry = directory.readSync()
      if (!entry || files.length >= MAX_WORKFLOW_RUNS) break
      if (entry.isFile() && !entry.isSymbolicLink() && /^wf_[a-zA-Z0-9_-]{1,128}\.json$/.test(entry.name)) files.push(entry.name)
    }
  } catch {
    return { runs: [], agents: [], totalTokens: 0 }
  } finally {
    directory?.closeSync()
  }

  const runs: WorkflowRunSummary[] = []
  const agents: AgentMetric[] = []
  let totalTokens = 0
  let remainingBytes = MAX_TOTAL_READ_BYTES
  let remainingAgents = MAX_TOTAL_AGENTS
  let warning: string | undefined

  for (const file of files.sort()) {
    let run: Record<string, unknown>
    let descriptor: number | null = null
    try {
      // The runtime rewrites this file mid-run, so a read can land on a partial
      // write. A failed parse just means "try again on the next poll".
      descriptor = fs.openSync(path.join(dir, file), fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0))
      const stat = fs.fstatSync(descriptor)
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_ATTEMPT_FILE_BYTES) continue
      if ((stat.birthtimeMs || stat.mtimeMs) < sinceMs) continue
      if (stat.size > remainingBytes) {
        warning = `Workflow progress projection reached its ${MAX_TOTAL_READ_BYTES}-byte aggregate read limit; remaining summaries were omitted this poll.`
        continue
      }
      remainingBytes -= stat.size
      const parsed: unknown = JSON.parse(
        readExactFileDescriptor(descriptor, stat.size, MAX_ATTEMPT_FILE_BYTES, `Workflow progress ${file}`).toString('utf8'),
      )
      if (!isRecord(parsed)) continue
      run = parsed
    } catch {
      continue
    } finally {
      if (descriptor !== null) fs.closeSync(descriptor)
    }
    const runId = file.slice(0, -'.json'.length)
    const name = text(run.workflowName) ?? runId
    const attemptTokens = count(run.totalTokens)
    runs.push({
      runId,
      name,
      status: text(run.status, 128) ?? 'unknown',
      agentCount: count(run.agentCount),
      totalTokens: attemptTokens,
      totalToolCalls: count(run.totalToolCalls),
    })
    totalTokens = Math.min(Number.MAX_SAFE_INTEGER, totalTokens + attemptTokens)

    const allProgress = Array.isArray(run.workflowProgress) ? run.workflowProgress : []
    const workflowProgress = allProgress.slice(0, Math.min(MAX_WORKFLOW_AGENTS, remainingAgents))
    if (allProgress.length > workflowProgress.length) {
      warning = `Workflow progress projection reached its ${MAX_TOTAL_AGENTS}-agent aggregate limit; remaining agents were omitted this poll.`
    }
    for (const [progressIndex, rawEntry] of workflowProgress.entries()) {
      remainingAgents -= 1
      if (!isRecord(rawEntry)) continue
      const entry = rawEntry
      if (entry.type !== 'workflow_agent') continue
      const startedAt = timestamp(entry.startedAt) ?? timestamp(entry.queuedAt)
      const durationMs = count(entry.durationMs)
      const entryIndex = count(entry.index)
      const entryId = identifier(entry.agentId) ?? String(entryIndex || progressIndex)
      const state = text(entry.state, 128)
      const defaultModel = run.defaultModel === null ? null : (text(run.defaultModel, 256) ?? null)
      agents.push({
        id: workflowAgentMetricId(runId, entryId),
        label: text(entry.label) ?? `agent ${identifier(entry.agentId) ?? (entryIndex || progressIndex + 1)}`,
        model: entry.model === null ? null : (text(entry.model, 256) ?? defaultModel),
        messages: 0,
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        firstTs: iso(startedAt),
        lastTs: iso(timestamp(entry.lastProgressAt) ?? (startedAt === undefined ? undefined : Math.min(MAX_DATE_MS, startedAt + durationMs))),
        done: state === 'done',
        source: 'workflow',
        phase: text(entry.phaseTitle) ?? name,
        state,
        totalTokens: count(entry.tokens),
        toolCalls: count(entry.toolCalls),
        durationMs,
        note: trim(entry.lastToolSummary ?? entry.resultPreview, 160),
      })
    }
  }

  agents.sort((a, b) => {
    const left = a.firstTs ?? ''
    const right = b.firstTs ?? ''
    return left < right ? -1 : left > right ? 1 : 0
  })
  return { runs, agents, totalTokens, ...(warning ? { warning } : {}) }
}
