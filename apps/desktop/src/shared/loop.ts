import type { HarnessKind } from './harness'

export type RunRole = 'reference' | 'implement' | 'critique'

/** Prefix on a requeued run's prompt marking it as a resume of an interrupted attempt. */
export const RESUME_PREFIX = '[[gauntlet:resume]]\n'

/** The heading a run's execution prompt is logged (and backfilled) under. */
export function runPromptLabel(run: { role: RunRole; round: number }): string {
  if (run.role === 'reference') return 'Reference Study execution prompt'
  return `Round ${run.round} ${run.role === 'implement' ? 'implementer' : 'critic'} execution prompt`
}
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
  /**
   * The agent that launched this one, when it is not the orchestrator. A
   * delegated worker is started by a shell command, so its owner is whoever
   * ran that command — a dispatcher on a claude → codex run, the orchestrator
   * itself on a codex → claude one. The list nests rows under their owner.
   */
  parentId?: string
  /** The task this agent was actually given, truncated for display. */
  prompt?: string
  /** Most recent tool call, for the live feed. */
  lastTool?: string
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
  criticHarness: HarnessKind
  criticModel: string
  criticEffort: string
  /** null = no deep-research fan-out; the reference agent sweeps by itself. */
  researchModel: string | null
  researchEffort: string
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
  /** Immutable Git commit for the playable source produced by an implement attempt. */
  revision: string | null
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

export type LogChannel = 'prompt' | 'thought' | 'tool' | 'output' | 'search' | 'media' | 'usage' | 'error' | 'system'

const KIND_CHANNEL: Record<string, LogChannel> = {
  prompt: 'prompt',
  thought: 'thought',
  tool: 'tool',
  cmd: 'tool',
  spawn: 'tool',
  claude: 'output',
  codex: 'output',
  agent: 'output',
  verdict: 'output',
  search: 'search',
  shot: 'media',
  metric: 'usage',
  error: 'error',
  stderr: 'error',
  system: 'system',
  done: 'system',
}

/** Rows written before the channel column existed derive theirs from the legacy kind. */
export function channelForKind(kind: string): LogChannel {
  return KIND_CHANNEL[kind] ?? 'system'
}

export interface LoopLogLine {
  loopId: string
  runId: string | null
  ts: string
  kind: string
  text: string
  /** Absent = the run's primary agent; otherwise the delegated child's slug. */
  agentId?: string
  /**
   * Denormalized from the run at write time (reference runs log round 0) so
   * the UI filter strip is a pure predicate over lines, with no runs join.
   */
  round?: number
  role?: RunRole
  channel?: LogChannel
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
  criticModel: string
  criticEffort: string
  /** null = the Reference Study runs its deep-research sweep without fan-out. */
  researchModel: string | null
  researchEffort: string
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
  /** null plays the live workspace; a number plays that saved round build. */
  round: number | null
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

export interface ReferencePack {
  /** Workspace-relative directory owned by this loop, e.g. reference/<loop-id>. */
  root: string
  ready: boolean
  issues: string[]
  images: string[]
  motion: string[]
  videos: string[]
  /** Ordered first-play screenshots (title → menu → intro → Level 1). */
  journey: string[]
  readme: string | null
  manifest: string | null
  /** journey.md — the documented main menu → intro → Level 1 walkthrough. */
  journeyMd: string | null
  /** story.md — premise, characters, progression, and captured dialog. */
  storyMd: string | null
  /** research.md — distilled deep-research sweep: streams, Reddit, reviews, wikis. */
  researchMd: string | null
}

export interface ReferenceStudy {
  runId: string
  status: RunStatus
  logs: LoopLogLine[]
  pack: ReferencePack
}

export interface LoopApi {
  list(): Promise<LoopSnapshot[]>
  get(loopId: string): Promise<LoopSnapshot | null>
  rename(loopId: string, title: string): Promise<LoopRecord | null>
  critique(loopId: string): Promise<CritiqueRound[]>
  reference(loopId: string, runId: string): Promise<ReferenceStudy | null>
  mediaBase(): Promise<string | null>
  playStart(loopId: string, round?: number | null): Promise<PlayState>
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
