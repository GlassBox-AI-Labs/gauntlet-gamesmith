import type { AgentMetric, AttemptMetrics, TokenTotals, Verdict, VerdictFinding } from './build'
import { redactLogText } from './redact-log'

const VERDICT_SEVERITIES = new Set(['critical', 'major', 'minor'])
const MAX_SUMMARY_LENGTH = 4_000
const MAX_FINDINGS = 100
const MAX_FINDING_LENGTH = 2_000
const VERDICT_TARGET = /^(?:game|asset:[a-z0-9][a-z0-9-]{0,249})$/
const MAX_AGENTS = 512
const MAX_MODELS = 128
// Historical CLI streams can carry a bounded terminal-style suffix such as
// `[1m]`. It is part of the persisted label now, so retain it rather than
// making the entire attempt unreadable (DATA-002).
const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:/+\[\]-]{0,255}$/
const LEGACY_MODEL_NAMES = new Set(['<synthetic>'])
const REDACTED_MODEL = '[REDACTED]'
const CHILD_OFFSET_KEY = /^[a-z0-9-]{1,64}\.(?:claude|codex)\.jsonl$/
const WORKFLOW_OFFSET_KEY = /^wf_[A-Za-z0-9_-]{1,128}\/(?:journal|agent-[A-Za-z0-9_-]{1,128})\.jsonl$/
const MAX_PROJECTION_OFFSETS = 1_000

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = new Set(allowed)
  return Object.keys(value).every((key) => keys.has(key))
}

function finiteNonNegative(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

function nonNegativeCounter(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}

function optionalString(value: unknown, maxLength: number): string | null | undefined {
  if (value === undefined) return undefined
  if (value === null) return null
  return typeof value === 'string' && value.length <= maxLength ? value : undefined
}

/** Model names are identifiers, but provider-token strings fit that grammar. */
export function normalizePersistedModel(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256) return null
  if (value === REDACTED_MODEL || /^\[REDACTED\]#\d+$/.test(value)) return value
  if (!MODEL_NAME.test(value) && !LEGACY_MODEL_NAMES.has(value)) return null
  return redactLogText(value) === value ? value : REDACTED_MODEL
}

function normalizeOffsets(value: unknown, keyPattern: RegExp): Record<string, number> | null {
  if (!isRecord(value)) return null
  const entries = Object.entries(value)
  if (entries.length > MAX_PROJECTION_OFFSETS) return null
  for (const [key, offset] of entries) {
    if (!keyPattern.test(key) || nonNegativeCounter(offset) === null) return null
  }
  entries.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
  return Object.fromEntries(entries) as Record<string, number>
}

function normalizeIdentities(value: unknown, keyPattern: RegExp): Record<string, { dev: number; ino: number }> | null {
  if (!isRecord(value)) return null
  const entries = Object.entries(value)
  if (entries.length > MAX_PROJECTION_OFFSETS) return null
  for (const [key, identity] of entries) {
    if (
      !keyPattern.test(key)
      || !isRecord(identity)
      || !hasOnlyKeys(identity, ['dev', 'ino'])
      || nonNegativeCounter(identity.dev) === null
      || nonNegativeCounter(identity.ino) === null
      || identity.dev === 0
      || identity.ino === 0
    ) return null
  }
  entries.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
  return Object.fromEntries(entries) as Record<string, { dev: number; ino: number }>
}

function normalizeProjection(value: unknown): NonNullable<AttemptMetrics['projection']> | null {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    'loggedOutLines',
    'loggedErrLines',
    'childOffsets',
    'childIdentities',
    'workflowOffsets',
    'workflowIdentities',
  ])) return null
  const loggedOutLines = nonNegativeCounter(value.loggedOutLines)
  const loggedErrLines = nonNegativeCounter(value.loggedErrLines)
  const childOffsets = normalizeOffsets(value.childOffsets, CHILD_OFFSET_KEY)
  const workflowOffsets = normalizeOffsets(value.workflowOffsets, WORKFLOW_OFFSET_KEY)
  if (loggedOutLines === null || loggedErrLines === null || !childOffsets || !workflowOffsets) return null
  const childIdentities = value.childIdentities === undefined ? undefined : normalizeIdentities(value.childIdentities, CHILD_OFFSET_KEY)
  const workflowIdentities = value.workflowIdentities === undefined ? undefined : normalizeIdentities(value.workflowIdentities, WORKFLOW_OFFSET_KEY)
  if (value.childIdentities !== undefined && !childIdentities) return null
  if (value.workflowIdentities !== undefined && !workflowIdentities) return null
  if (childIdentities && Object.keys(childIdentities).some((key) => !Object.hasOwn(childOffsets, key))) return null
  if (workflowIdentities && Object.keys(workflowIdentities).some((key) => !Object.hasOwn(workflowOffsets, key))) return null
  return {
    loggedOutLines,
    loggedErrLines,
    childOffsets,
    ...(childIdentities ? { childIdentities } : {}),
    workflowOffsets,
    ...(workflowIdentities ? { workflowIdentities } : {}),
  }
}

/** Dates persisted by the app always use Date#toISOString's canonical form. */
export function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false
  const milliseconds = Date.parse(value)
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value
}

/** Strict machine-readable critic verdict. Invalid or coercible values fail closed. */
export function normalizeVerdict(value: unknown): Verdict | null {
  if (!isRecord(value) || !hasOnlyKeys(value, ['score', 'pass', 'summary', 'findings'])) return null
  if (typeof value.score !== 'number' || !Number.isFinite(value.score) || value.score < 0 || value.score > 1) return null
  if (typeof value.pass !== 'boolean') return null
  if (typeof value.summary !== 'string' || value.summary.length > MAX_SUMMARY_LENGTH) return null
  if (!Array.isArray(value.findings) || value.findings.length > MAX_FINDINGS) return null

  const findings: VerdictFinding[] = []
  for (const candidate of value.findings) {
    if (!isRecord(candidate) || !hasOnlyKeys(candidate, ['severity', 'text', 'target'])) return null
    if (typeof candidate.severity !== 'string' || !VERDICT_SEVERITIES.has(candidate.severity)) return null
    if (typeof candidate.text !== 'string' || candidate.text.length === 0 || candidate.text.length > MAX_FINDING_LENGTH) return null
    if (candidate.target !== undefined && (typeof candidate.target !== 'string' || !VERDICT_TARGET.test(candidate.target))) return null
    findings.push({
      severity: candidate.severity,
      text: redactLogText(candidate.text),
      ...(typeof candidate.target === 'string' ? { target: candidate.target } : {}),
    })
  }
  return { score: value.score, pass: value.pass, summary: redactLogText(value.summary), findings }
}

function normalizeTokens(value: unknown): TokenTotals | null {
  if (!isRecord(value) || !hasOnlyKeys(value, ['input', 'output', 'cacheRead', 'cacheWrite'])) return null
  const input = nonNegativeCounter(value.input)
  const output = nonNegativeCounter(value.output)
  // cacheRead/cacheWrite were additive fields, so old rows safely default to zero.
  const cacheRead = value.cacheRead === undefined ? 0 : nonNegativeCounter(value.cacheRead)
  const cacheWrite = value.cacheWrite === undefined ? 0 : nonNegativeCounter(value.cacheWrite)
  if (input === null || output === null || cacheRead === null || cacheWrite === null) return null
  return { input, output, cacheRead, cacheWrite }
}

function normalizeAgent(value: unknown): AgentMetric | null {
  if (!isRecord(value)) return null
  if (
    !hasOnlyKeys(value, [
      'id',
      'label',
      'model',
      'messages',
      'tokens',
      'firstTs',
      'lastTs',
      'done',
      'source',
      'phase',
      'state',
      'totalTokens',
      'toolCalls',
      'durationMs',
      'note',
      'costUsd',
      'agentType',
      'parentId',
      'prompt',
      'lastTool',
    ])
  ) return null
  if (typeof value.id !== 'string' || value.id.length === 0 || value.id.length > 256) return null
  if (typeof value.label !== 'string' || value.label.length > 1_000) return null
  const model = value.model === null ? null : normalizePersistedModel(value.model)
  if (value.model !== null && model === null) return null
  const messages = nonNegativeCounter(value.messages)
  const tokens = normalizeTokens(value.tokens)
  const firstTs = optionalString(value.firstTs, 128)
  const lastTs = optionalString(value.lastTs, 128)
  if (
    messages === null ||
    !tokens ||
    firstTs === undefined ||
    lastTs === undefined ||
    (firstTs !== null && !isIsoTimestamp(firstTs)) ||
    (lastTs !== null && !isIsoTimestamp(lastTs))
  ) return null

  const optionalNumbers = ['totalTokens', 'toolCalls', 'durationMs'] as const
  for (const key of optionalNumbers) {
    if (value[key] !== undefined && nonNegativeCounter(value[key]) === null) return null
  }
  if (value.done !== undefined && typeof value.done !== 'boolean') return null
  if (value.source !== undefined && value.source !== 'stream' && value.source !== 'workflow') return null
  for (const key of ['phase', 'state', 'note', 'agentType', 'parentId', 'prompt', 'lastTool'] as const) {
    if (value[key] !== undefined && (typeof value[key] !== 'string' || value[key].length > 8_000)) return null
  }
  if (value.costUsd !== undefined && value.costUsd !== null && finiteNonNegative(value.costUsd) === null) return null

  const agent: AgentMetric = {
    id: redactLogText(value.id),
    label: redactLogText(value.label),
    model,
    messages,
    tokens,
    firstTs,
    lastTs,
  }
  if (value.done !== undefined) agent.done = value.done as boolean
  if (value.source !== undefined) agent.source = value.source as 'stream' | 'workflow'
  for (const key of optionalNumbers) if (value[key] !== undefined) agent[key] = value[key] as number
  for (const key of ['phase', 'state', 'note', 'agentType', 'parentId', 'prompt', 'lastTool'] as const) {
    if (value[key] !== undefined) agent[key] = redactLogText(value[key] as string)
  }
  if (value.costUsd !== undefined) agent.costUsd = value.costUsd as number | null
  return agent
}

/** Canonical decoder for metrics persisted by older and current attempts. */
export function normalizeAttemptMetrics(value: unknown): AttemptMetrics | null {
  if (!isRecord(value) || !hasOnlyKeys(value, ['agents', 'perModel', 'projection'])) return null
  if (!Array.isArray(value.agents) || value.agents.length > MAX_AGENTS || !isRecord(value.perModel)) return null
  const agents = value.agents.map(normalizeAgent)
  if (agents.some((agent) => agent === null)) return null
  const entries = Object.entries(value.perModel)
  if (entries.length > MAX_MODELS) return null
  const perModel: AttemptMetrics['perModel'] = {}
  for (const [model, candidate] of entries) {
    const safeModel = normalizePersistedModel(model)
    if (!safeModel || !isRecord(candidate) || !hasOnlyKeys(candidate, ['costUsd', 'tokens'])) return null
    const tokens = normalizeTokens(candidate.tokens)
    if (!tokens || (candidate.costUsd !== null && finiteNonNegative(candidate.costUsd) === null)) return null
    let key = safeModel
    for (let suffix = 2; Object.hasOwn(perModel, key); suffix += 1) key = `${safeModel}#${suffix}`
    perModel[key] = { costUsd: candidate.costUsd as number | null, tokens }
  }
  const projection = value.projection === undefined ? undefined : normalizeProjection(value.projection)
  if (value.projection !== undefined && projection === null) return null
  return projection ? { agents: agents as AgentMetric[], perModel, projection } : { agents: agents as AgentMetric[], perModel }
}
