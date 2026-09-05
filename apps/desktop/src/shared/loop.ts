import type { HarnessKind } from './harness'
import type { DeleteRunsResult } from './reports'
import type { OperationResult } from './result'

export type RunRole = 'reference' | 'assets' | 'implement' | 'critique'

/** Prefix on a requeued run's prompt marking it as a resume of an interrupted attempt. */
export const RESUME_PREFIX = '[[gauntlet:resume]]\n'

export function stripResumeMarker(prompt: string): string {
  return prompt.startsWith(RESUME_PREFIX) ? prompt.slice(RESUME_PREFIX.length) : prompt
}

export function markResumePrompt(prompt: string): string {
  return RESUME_PREFIX + stripResumeMarker(prompt)
}

/** The heading a run's execution prompt is logged (and backfilled) under. */
export function runPromptLabel(run: { role: RunRole; round: number }): string {
  if (run.role === 'reference') return 'Reference Study execution prompt'
  if (run.role === 'assets') return 'Asset Build execution prompt'
  return `Round ${run.round} ${run.role === 'implement' ? 'implementer' : 'critic'} execution prompt`
}
export type RunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted'
export type LoopStatus = 'running' | 'passed' | 'exhausted' | 'stopped' | 'failed'

export interface VerdictFinding {
  severity: string
  text: string
  /**
   * `asset:<name>` sends this finding back through the asset pipeline for that
   * one model; anything else (including absent) is the implementer's to fix.
   * Absent on every verdict written before the asset phase existed, which is
   * why it is optional rather than defaulted at the type level.
   */
  target?: string
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
  /** Durable transcript cursors committed atomically with projected events. */
  projection?: {
    loggedOutLines: number
    loggedErrLines: number
    childOffsets: Record<string, number>
    childIdentities?: Record<string, { dev: number; ino: number }>
    workflowOffsets: Record<string, number>
    workflowIdentities?: Record<string, { dev: number; ino: number }>
  }
}

/**
 * Who builds, who judges, and on which CLI.
 *
 * Every role stores its harness alongside its model. It used to be inferred
 * from the model name — anything starting with `gpt-` meant codex — but a
 * harness can host another harness's models (OpenCode offers both Claude and
 * GPT ids), so the name cannot carry that meaning. The critic has stored its
 * harness this way from the start; the other roles now match it.
 *
 * `normalizeModels` fills the harness in for rows written before this change.
 */
export interface LoopModels {
  orchestratorHarness: HarnessKind
  orchestratorModel: string
  orchestratorEffort: string
  /** null = the orchestrator implements by itself, with no subagents. */
  subagentHarness: HarnessKind | null
  subagentModel: string | null
  subagentEffort: string
  criticHarness: HarnessKind
  criticModel: string
  criticEffort: string
  /**
   * false = no Reference Study at all: the loop starts at implement round 1
   * and every later phase judges against the operator's brief instead of a
   * frozen pack. Distinct from a null researchModel, which only turns off the
   * fan-out inside a Reference Study that still runs.
   */
  referenceStudy: boolean
  /** null = no deep-research fan-out; the reference agent sweeps by itself. */
  researchHarness: HarnessKind | null
  researchModel: string | null
  researchEffort: string
  /** null = no asset phase; implement rounds build their own models, as before. */
  assetHarness: HarnessKind | null
  assetModel: string | null
  assetEffort: string
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
  /** Requested reasoning effort for this run, when the harness supports it. */
  effort: string | null
  /** Exact CLI version reported when this run was launched. */
  cliVersion: string | null
  /** Identifier for the price table used to compute equivalent API cost. */
  priceTableVersion: string | null
  /** Where the persisted cost figure came from (stream total, usage log, or estimate). */
  costSource: string | null
  /** SHA-256 of the exact prompt passed to the harness for this attempt. */
  promptSha256: string | null
  /** Non-secret label for the isolated harness profile used by this attempt. */
  accountLabel: string | null
  /** Machine attribution captured when this attempt was launched. */
  machineLabel: string | null
  /** Authentication policy used by the harness; never contains credential material. */
  authMode: 'subscription' | 'api_key' | null
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
  /** Exact canonical root identity captured before this workspace became executable. */
  workspaceIdentity?: { dev: number; ino: number } | null
  maxRounds: number
  budgetUsd: number | null
  models: LoopModels
  status: LoopStatus
  round: number
  totalCostUsd: number
  stopReason: string | null
  /** Local creation provenance; never granted by existing-folder execution consent. */
  playTrusted: boolean
  /** Explicit local consent for existing-folder Play/Resume; does not grant private raw access. */
  executionTrusted?: boolean
  createdAt: string
  updatedAt: string
}

export interface LoopSnapshot {
  loop: LoopRecord
  runs: RunRecord[]
  /** Total canonical attempts, including rows omitted from this IPC page. */
  totalRuns?: number
  /** Number of newer canonical attempts preceding this newest-first page. */
  runOffset?: number
  /** True when older attempts or oversized structured fields were omitted. */
  hasMoreRuns?: boolean
  /** True when a loaded attempt had an oversized prompt, verdict, or metrics projection. */
  detailTruncated?: boolean
  projectionWarning?: string | null
  aggregate?: {
    costUsd: number
    inputTokens: number
    outputTokens: number
  }
}

export interface LoopListPage {
  snapshots: LoopSnapshot[]
  total: number
  offset: number
  hasMore: boolean
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
  'raw-stream': 'system',
  error: 'error',
  stderr: 'error',
  system: 'system',
  trust: 'system',
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
  /** null = skip the Asset Build phase; implement rounds sculpt their own models. */
  assetModel: string | null
  assetEffort: string
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
  warning?: string
  snapshot?: LoopSnapshot
  snapshots?: LoopSnapshot[]
  totalSnapshots?: number
  hasMoreSnapshots?: boolean
  error?: string
}

export type RawStreamKind = 'stdout' | 'stderr' | 'agent'

export interface RawStreamInput {
  runId: string
  stream: RawStreamKind
  /** Required for `agent`; it is the stable id from that run's AgentMetric. */
  agentId?: string
}

export interface ReadRawStreamInput extends RawStreamInput {
  /** Byte cursor returned by the previous chunk; zero starts a new read. */
  offset: number
  /** File identity returned by the previous chunk prevents mixed-file reads. */
  identity?: string
}

export interface RawStreamChunk {
  contentBase64: string
  nextOffset: number
  totalBytes: number
  complete: boolean
  identity: string
}

export interface PlayState {
  running: boolean
  url: string | null
  error: string | null
  /** null plays the live workspace; a number plays that saved round build. */
  round: number | null
}

export interface PlayStateEvent extends PlayState {
  loopId: string
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
  /** True when safety limits kept this renderer projection to a bounded subset. */
  truncated: boolean
}

export interface ReferencePack {
  /** Workspace-relative directory owned by this loop, e.g. reference/<loop-id>. */
  root: string
  ready: boolean
  issues: string[]
  /** Safety/display truncation that does not invalidate the required pack. */
  warnings?: string[]
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
  /** Isolated object shots — the best source a sculptor can crop from. */
  objects: string[]
  /** cast.md — the prose list of things worth sculpting. */
  castMd: string | null
  /** How many well-formed cast entries the manifest carries. */
  castCount: number
}

export interface ReferenceStudy {
  runId: string
  status: RunStatus
  /** Exact bounded canonical prompt for the Reference Study attempt. */
  prompt: string
  logs: LoopLogLine[]
  pack: ReferencePack
}

export interface LoopApi {
  list(offset?: number): Promise<LoopListPage>
  get(loopId: string, offset?: number): Promise<LoopSnapshot | null>
  rename(loopId: string, title: string): Promise<OperationResult<LoopRecord>>
  critique(loopId: string): Promise<OperationResult<CritiqueRound[]>>
  reference(loopId: string, runId?: string): Promise<ReferenceStudy | null>
  mediaBase(): Promise<OperationResult<string>>
  playStart(loopId: string, round?: number | null): Promise<PlayState>
  playStop(loopId: string): Promise<void>
  playState(loopId: string): Promise<PlayState>
  onPlayState(listener: (state: PlayStateEvent) => void): () => void
  start(input: StartLoopInput): Promise<StartLoopResult>
  trust(loopId: string): Promise<OperationResult<LoopRecord | null>>
  resume(loopId: string): Promise<StartLoopResult>
  stop(loopId: string): Promise<OperationResult<void>>
  active(): Promise<LoopSnapshot | null>
  log(loopId: string, limit?: number): Promise<LoopLogLine[]>
  prompt(loopId: string, role: RunRole, round: number): Promise<OperationResult<{ runId: string; prompt: string }>>
  readStream(input: ReadRawStreamInput): Promise<OperationResult<RawStreamChunk>>
  report(loopId: string): Promise<OperationResult<string>>
  exportRun(loopId: string): Promise<RunTransferResult>
  importRun(): Promise<RunTransferResult>
  /** Forget these runs. `deleteFiles` also removes their project folders from disk. */
  deleteRuns(loopIds: string[], deleteFiles: boolean): Promise<DeleteRunsResult>
  pickWorkspace(): Promise<string | null>
  defaultWorkspace(): Promise<string>
  onUpdate(listener: (snapshot: LoopSnapshot) => void): () => void
  onLog(listener: (line: LoopLogLine) => void): () => void
}
