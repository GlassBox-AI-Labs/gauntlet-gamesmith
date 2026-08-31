import fs from 'node:fs'
import path from 'node:path'
import type { AgentMetric } from '../shared/loop'

/**
 * When the orchestrator runs at ultracode effort it delegates through the
 * Workflow tool, whose agents live in a separate runtime — they never appear in
 * the session's message stream as Agent/Task tool calls, so the stream parser
 * cannot see them. The runtime does write each run to disk, though, one JSON
 * file per workflow, updated while the run is still going. Reading those files
 * is the only way to show what the fan-out is actually doing.
 */

/** Fields we rely on; the file carries more. */
interface WorkflowAgentEntry {
  type: string
  index?: number
  label?: string
  phaseTitle?: string
  agentId?: string
  model?: string | null
  state?: string
  startedAt?: number
  queuedAt?: number
  lastProgressAt?: number
  attempt?: number
  lastToolName?: string
  lastToolSummary?: string
  resultPreview?: string
  tokens?: number
  toolCalls?: number
  durationMs?: number
}

interface WorkflowRunFile {
  runId?: string
  workflowName?: string
  status?: string
  startTime?: number
  agentCount?: number
  totalTokens?: number
  totalToolCalls?: number
  defaultModel?: string | null
  workflowProgress?: WorkflowAgentEntry[]
}

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
}

/**
 * The runtime keys its directory by the session id, alongside that session's
 * own transcript: <config>/projects/<workspace-slug>/<session-id>/workflows/.
 */
export function workflowDir(claudeHome: string, workspaceDir: string, sessionId: string): string {
  return path.join(claudeHome, 'projects', workspaceDir.replace(/[^a-zA-Z0-9-]/g, '-'), sessionId, 'workflows')
}

function iso(ms: number | undefined): string | null {
  return typeof ms === 'number' && Number.isFinite(ms) ? new Date(ms).toISOString() : null
}

function trim(value: string | undefined, max: number): string | undefined {
  if (!value) return undefined
  const flat = value.replace(/\s+/g, ' ').trim()
  if (!flat) return undefined
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

/**
 * Read every workflow this session has launched. Returns an empty result when
 * the directory does not exist, which is the normal case for a run whose
 * orchestrator never reached for a workflow.
 */
export function readWorkflowProgress(dir: string): WorkflowProgress {
  let files: string[]
  try {
    files = fs.readdirSync(dir).filter((f) => f.startsWith('wf_') && f.endsWith('.json'))
  } catch {
    return { runs: [], agents: [], totalTokens: 0 }
  }

  const runs: WorkflowRunSummary[] = []
  const agents: AgentMetric[] = []
  let totalTokens = 0

  for (const file of files.sort()) {
    let run: WorkflowRunFile
    try {
      // The runtime rewrites this file mid-run, so a read can land on a partial
      // write. A failed parse just means "try again on the next poll".
      run = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')) as WorkflowRunFile
    } catch {
      continue
    }
    const runId = run.runId ?? file.replace(/\.json$/, '')
    const name = run.workflowName ?? runId
    runs.push({
      runId,
      name,
      status: run.status ?? 'unknown',
      agentCount: run.agentCount ?? 0,
      totalTokens: run.totalTokens ?? 0,
      totalToolCalls: run.totalToolCalls ?? 0,
    })
    totalTokens += run.totalTokens ?? 0

    for (const entry of run.workflowProgress ?? []) {
      if (entry.type !== 'workflow_agent') continue
      const startedAt = entry.startedAt ?? entry.queuedAt
      agents.push({
        id: `wf:${runId}:${entry.agentId ?? entry.index ?? agents.length}`,
        label: entry.label ?? `agent ${entry.index ?? '?'}`,
        model: entry.model ?? run.defaultModel ?? null,
        messages: 0,
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        firstTs: iso(startedAt),
        lastTs: iso(entry.lastProgressAt ?? (startedAt && entry.durationMs ? startedAt + entry.durationMs : undefined)),
        done: entry.state === 'done',
        source: 'workflow',
        phase: entry.phaseTitle ?? name,
        state: entry.state,
        totalTokens: entry.tokens ?? 0,
        toolCalls: entry.toolCalls ?? 0,
        durationMs: entry.durationMs,
        note: trim(entry.lastToolSummary ?? entry.resultPreview, 160),
      })
    }
  }

  agents.sort((a, b) => (a.firstTs ?? '').localeCompare(b.firstTs ?? ''))
  return { runs, agents, totalTokens }
}
