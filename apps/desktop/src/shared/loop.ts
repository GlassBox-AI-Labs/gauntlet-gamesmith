import type { HarnessKind } from './harness'

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
  /**
   * Workflow agents run in a separate runtime, so their numbers come off disk
   * rather than out of the message stream. They report one scalar token count
   * instead of the input/output/cache split, so `tokens` stays zero for them
   * and `totalTokens` carries the figure.
   */
  source?: 'stream' | 'workflow'
  phase?: string
  state?: string
  totalTokens?: number
  toolCalls?: number
  durationMs?: number
  note?: string
  /** Priced from the real token split in the agent's own transcript. */
  costUsd?: number | null
  /** Which agent definition the workflow script asked for, e.g. 'implementer'. */
  agentType?: string
  /** The task this agent was actually given, truncated for display. */
  prompt?: string
}

export interface RunMetrics {
  agents: AgentMetric[]
  perModel: Record<string, { costUsd: number | null; tokens: TokenTotals }>
}

export interface LoopModels {
  orchestratorModel: string
  orchestratorEffort: string
  /** null = the orchestrator implements by itself, with no subagents. */
  subagentModel: string | null
  subagentEffort: string
  /** Id of the critic preset picked on the run form. */
  criticId: string
  criticHarness: HarnessKind
  criticModel: string
  criticEffort: string
}

export interface RunRecord {
  id: string
  loopId: string
  round: number
  role: RunRole
  harness: HarnessKind
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
  title: string
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
  orchestratorModel: string
  orchestratorEffort: string
  /** null = no implementer subagents; the orchestrator does the work itself. */
  subagentModel: string | null
  subagentEffort: string
  criticId: string
}

export interface StartLoopResult {
  ok: boolean
  loopId?: string
  error?: string
}

export interface RunTransferResult {
  ok: boolean
  canceled?: boolean
  filePath?: string
  snapshot?: LoopSnapshot
  snapshots?: LoopSnapshot[]
  error?: string
}

export interface PlayState {
  running: boolean
  url: string | null
  error: string | null
}

export interface PairComparison {
  shot: string
  ref: string
  winner: 'shot' | 'ref' | 'tie'
  why: string
}

export interface CritiqueRound {
  round: number
  runId: string
  status: RunStatus
  verdict: Verdict | null
  thoughts: string[]
  shots: string[]
  refs: string[]
  videos: string[]
  pairs: PairComparison[] | null
  pairsMd: string | null
}

export interface LoopApi {
  list(): Promise<LoopSnapshot[]>
  get(loopId: string): Promise<LoopSnapshot | null>
  rename(loopId: string, title: string): Promise<LoopRecord | null>
  critique(loopId: string): Promise<CritiqueRound[]>
  mediaBase(): Promise<string | null>
  playStart(loopId: string): Promise<PlayState>
  playStop(loopId: string): Promise<void>
  playState(loopId: string): Promise<PlayState>
  onPlayState(listener: (state: PlayState & { loopId: string }) => void): () => void
  start(input: StartLoopInput): Promise<StartLoopResult>
  resume(loopId: string): Promise<StartLoopResult>
  stop(loopId: string): Promise<void>
  active(): Promise<LoopSnapshot | null>
  log(loopId: string, limit?: number): Promise<LoopLogLine[]>
  report(loopId: string): Promise<string>
  exportRun(loopId: string): Promise<RunTransferResult>
  importRun(): Promise<RunTransferResult>
  pickWorkspace(): Promise<string | null>
  defaultWorkspace(): Promise<string>
  onUpdate(listener: (snapshot: LoopSnapshot) => void): () => void
  onLog(listener: (line: LoopLogLine) => void): () => void
}
