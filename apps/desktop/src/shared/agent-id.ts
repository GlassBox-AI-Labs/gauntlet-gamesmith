const CHILD_AGENT_ID = /^child:([a-z0-9-]{1,64})$/
const WORKFLOW_AGENT_ID = /^wf:(wf_[a-zA-Z0-9_-]{1,128}):([a-zA-Z0-9_-]{1,128})$/
const CODEX_AGENT_ID = /^codex:([a-zA-Z0-9_-]{1,160})$/

export type ParsedAgentMetricId =
  | { kind: 'child'; slug: string }
  | { kind: 'workflow'; runId: string; agentId: string }
  | { kind: 'codex'; threadId: string }

/** Canonical parser for metric ids that map to a separately owned raw stream. */
export function parseAgentMetricId(value: unknown): ParsedAgentMetricId | null {
  if (typeof value !== 'string') return null
  const child = CHILD_AGENT_ID.exec(value)
  if (child) return { kind: 'child', slug: child[1] }
  const workflow = WORKFLOW_AGENT_ID.exec(value)
  if (workflow) return { kind: 'workflow', runId: workflow[1], agentId: workflow[2] }
  const codex = CODEX_AGENT_ID.exec(value)
  if (codex) return { kind: 'codex', threadId: codex[1] }
  return null
}

export function childAgentMetricId(slug: string): string {
  return `child:${slug}`
}

export function workflowAgentMetricId(runId: string, agentId: string): string {
  return `wf:${runId}:${agentId}`
}

export function codexAgentMetricId(threadId: string): string {
  return `codex:${threadId}`
}

/** Child tail events use the slug; native nested streams use their metric id. */
export function logAgentIdForMetric(metricId: string): string | null {
  const parsed = parseAgentMetricId(metricId)
  if (!parsed) return null
  return parsed.kind === 'child' ? parsed.slug : metricId
}
