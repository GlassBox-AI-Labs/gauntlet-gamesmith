import type { HarnessKind } from './harness'
import type { DeleteBuildsResult } from './reports'
import type { OperationResult } from './result'

export type PhaseRole = 'reference' | 'assets' | 'implement' | 'critique'

/** Prefix on a requeued attempt's prompt marking it as a resume of an interrupted attempt. */
export const RESUME_PREFIX = '[[gauntlet:resume]]\n'

export function stripResumeMarker(prompt: string): string {
  return prompt.startsWith(RESUME_PREFIX) ? prompt.slice(RESUME_PREFIX.length) : prompt
}

export function markResumePrompt(prompt: string): string {
  return RESUME_PREFIX + stripResumeMarker(prompt)
}

/** The heading an attempt's execution prompt is logged (and backfilled) under. */
export function attemptPromptLabel(attempt: { role: PhaseRole; round: number }): string {
  if (attempt.role === 'reference') return 'Reference Study execution prompt'
  if (attempt.role === 'assets') return 'Asset Build execution prompt'
  return `Round ${attempt.round} ${attempt.role === 'implement' ? 'implementer' : 'critic'} execution prompt`
}
export type AttemptStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted'
export type BuildStatus = 'running' | 'passed' | 'exhausted' | 'stopped' | 'failed'

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
   * ran that command — a dispatcher on a claude → codex attempt, the orchestrator
   * itself on a codex → claude one. The list nests rows under their owner.
   */
  parentId?: string
  /** The task this agent was actually given, truncated for display. */
  prompt?: string
  /** Most recent tool call, for the live feed. */
  lastTool?: string
}

export interface AttemptMetrics {
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

export type ReferenceMode = 'web' | 'files' | 'skip'

export interface BuildModels {
  /** Missing in older histories means the original web Reference Study. */
  referenceMode?: ReferenceMode
  orchestratorModel: string
  orchestratorEffort: string
  /** null = the orchestrator implements by itself, with no subagents. */
  subagentModel: string | null
  subagentEffort: string
  criticModel: string
  criticEffort: string
  /** null = no deep-research fan-out; the reference agent sweeps by itself. */
  researchModel: string | null
  researchEffort: string
  /** null = no asset phase; implement rounds build their own models, as before. */
  assetModel: string | null
  assetEffort: string
}

export interface PhaseAttempt {
  id: string
  buildId: string
  round: number
  role: PhaseRole
  harness: HarnessKind
  status: AttemptStatus
  prompt: string
  model: string | null
  /** Requested reasoning effort for this attempt, when the harness supports it. */
  effort: string | null
  /** Exact CLI version reported when this attempt was launched. */
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
  metrics: AttemptMetrics | null
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

export interface BuildRecord {
  id: string
  title: string
  prompt: string
  workspaceDir: string
  /** Exact canonical root identity captured before this workspace became executable. */
  workspaceIdentity?: { dev: number; ino: number } | null
  maxRounds: number
  budgetUsd: number | null
  models: BuildModels
  status: BuildStatus
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

export interface BuildSnapshot {
  build: BuildRecord
  attempts: PhaseAttempt[]
  /** Total canonical attempts, including rows omitted from this IPC page. */
  totalAttempts?: number
  /** Number of newer canonical attempts preceding this newest-first page. */
  attemptOffset?: number
  /** True when older attempts or oversized structured fields were omitted. */
  hasMoreAttempts?: boolean
  /** True when a loaded attempt had an oversized prompt, verdict, or metrics projection. */
  detailTruncated?: boolean
  projectionWarning?: string | null
  aggregate?: {
    costUsd: number
    inputTokens: number
    outputTokens: number
  }
}

export interface BuildListPage {
  snapshots: BuildSnapshot[]
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

export interface BuildLogLine {
  buildId: string
  attemptId: string | null
  ts: string
  kind: string
  text: string
  /** Absent = the build's primary agent; otherwise the delegated child's slug. */
  agentId?: string
  /**
   * Denormalized from the attempt at write time (reference attempts log round 0) so
   * the UI filter strip is a pure predicate over lines, with no builds join.
   */
  round?: number
  role?: PhaseRole
  channel?: LogChannel
}

export interface StartBuildInput {
  referenceMode?: ReferenceMode
  /** Opaque IDs for bounded, main-process attachment snapshots. */
  attachmentIds?: string[]
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

export interface StartBuildResult {
  ok: boolean
  buildId?: string
  error?: string
}

export interface BuildTransferResult {
  ok: boolean
  canceled?: boolean
  filePath?: string
  warning?: string
  snapshot?: BuildSnapshot
  snapshots?: BuildSnapshot[]
  totalSnapshots?: number
  hasMoreSnapshots?: boolean
  error?: string
}

export type RawStreamKind = 'stdout' | 'stderr' | 'agent'

export interface RawStreamInput {
  attemptId: string
  stream: RawStreamKind
  /** Required for `agent`; it is the stable id from that attempt's AgentMetric. */
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
  buildId: string
}

export interface PairComparison {
  shot: string
  ref: string
  winner: 'shot' | 'ref' | 'tie'
  why: string
}

export interface CritiqueRound {
  round: number
  attemptId: string
  status: AttemptStatus
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
  /** Workspace-relative directory owned by this build, e.g. reference/<build-id>. */
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
  attemptId: string
  status: AttemptStatus
  /** Exact bounded canonical prompt for the Reference Study attempt. */
  prompt: string
  logs: BuildLogLine[]
  pack: ReferencePack
}

export interface BuildApi {
  list(offset?: number): Promise<BuildListPage>
  get(buildId: string, offset?: number): Promise<BuildSnapshot | null>
  rename(buildId: string, title: string): Promise<OperationResult<BuildRecord>>
  critique(buildId: string): Promise<OperationResult<CritiqueRound[]>>
  reference(buildId: string, attemptId?: string): Promise<ReferenceStudy | null>
  mediaBase(): Promise<OperationResult<string>>
  playStart(buildId: string, round?: number | null): Promise<PlayState>
  playStop(buildId: string): Promise<void>
  playState(buildId: string): Promise<PlayState>
  onPlayState(listener: (state: PlayStateEvent) => void): () => void
  start(input: StartBuildInput): Promise<StartBuildResult>
  trust(buildId: string): Promise<OperationResult<BuildRecord | null>>
  resume(buildId: string): Promise<StartBuildResult>
  stop(buildId: string): Promise<OperationResult<void>>
  active(): Promise<BuildSnapshot | null>
  log(buildId: string, limit?: number): Promise<BuildLogLine[]>
  prompt(buildId: string, role: PhaseRole, round: number): Promise<OperationResult<{ attemptId: string; prompt: string }>>
  readStream(input: ReadRawStreamInput): Promise<OperationResult<RawStreamChunk>>
  report(buildId: string): Promise<OperationResult<string>>
  exportBuild(buildId: string): Promise<BuildTransferResult>
  importBuild(): Promise<BuildTransferResult>
  /** Forget these builds. `deleteFiles` also removes their project folders from disk. */
  deleteBuilds(buildIds: string[], deleteFiles: boolean): Promise<DeleteBuildsResult>
  pickWorkspace(): Promise<string | null>
  defaultWorkspace(): Promise<string>
  onUpdate(listener: (snapshot: BuildSnapshot) => void): () => void
  onLog(listener: (line: BuildLogLine) => void): () => void
}
