export type RunRole = 'implement' | 'critique'

/** Prefix on a requeued run's prompt marking it as a resume of an interrupted attempt. */
export const RESUME_PREFIX = '[[gauntlet:resume]]\n'
export type RunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted'
export type LoopStatus = 'running' | 'passed' | 'exhausted' | 'stopped' | 'failed'

export interface VerdictFinding {
  severity: string
  text: string
}

export interface Verdict {
  score: number
  pass: boolean
  summary: string
  findings: VerdictFinding[]
}

export interface TokenTotals {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

export interface AgentMetric {
  id: string
  label: string
  model: string | null
  messages: number
  tokens: TokenTotals
  firstTs: string | null
  lastTs: string | null
  done?: boolean
}

export interface RunMetrics {
  agents: AgentMetric[]
  perModel: Record<string, { costUsd: number | null; tokens: TokenTotals }>
}

export interface LoopModels {
  orchestratorModel: string
  orchestratorEffort: string
  subagentModel: string
  subagentEffort: string
  criticModel: string
  criticEffort: string
}

export interface RunRecord {
  id: string
  loopId: string
  round: number
  role: RunRole
  harness: 'claude' | 'codex'
  status: RunStatus
  prompt: string
  model: string | null
  summary: string | null
  verdict: Verdict | null
  metrics: RunMetrics | null
  costUsd: number | null
  inputTokens: number | null
  outputTokens: number | null
  numTurns: number | null
  durationMs: number | null
  sessionId: string | null
  error: string | null
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
}

export interface LoopRecord {
  id: string
  prompt: string
  workspaceDir: string
  maxRounds: number
  budgetUsd: number | null
  models: LoopModels
  status: LoopStatus
  round: number
  totalCostUsd: number
  stopReason: string | null
  createdAt: string
  updatedAt: string
}

export interface LoopSnapshot {
  loop: LoopRecord
  runs: RunRecord[]
}

export interface LoopLogLine {
  loopId: string
  runId: string | null
  ts: string
  kind: string
  text: string
}

export interface StartLoopInput {
  prompt: string
  workspaceDir: string
  maxRounds: number
  budgetUsd: number | null
}

export interface StartLoopResult {
  ok: boolean
  loopId?: string
  error?: string
}

export interface LoopApi {
  start(input: StartLoopInput): Promise<StartLoopResult>
  stop(loopId: string): Promise<void>
  active(): Promise<LoopSnapshot | null>
  log(loopId: string, limit?: number): Promise<LoopLogLine[]>
  report(loopId: string): Promise<string>
  pickWorkspace(): Promise<string | null>
  defaultWorkspace(): Promise<string>
  onUpdate(listener: (snapshot: LoopSnapshot) => void): () => void
  onLog(listener: (line: LoopLogLine) => void): () => void
}
