import type { TokenTotals } from './loop'

/** Portable, bounded working memory. It is agent-authored evidence, never requirements. */
export interface LeadNotebook {
  plan: string
  decisions: string
  experiments: string
  verification: string
  nextSteps: string
}

export const LEAD_NOTEBOOK_FIELDS = ['plan', 'decisions', 'experiments', 'verification', 'nextSteps'] as const
export const LEAD_NOTEBOOK_LABELS: Record<keyof LeadNotebook, string> = {
  plan: 'Current plan', decisions: 'Decisions', experiments: 'Tried and learned',
  verification: 'Verification', nextSteps: 'Remaining work',
}

export interface LeadDispatch {
  runId: string
  round: number
  mode: 'new' | 'continued' | 'recovered'
  fromRunId: string | null
  resumeId: string | null
  reason: string
  usageBaseline: TokenTotals | null
}

export interface LeadCheckpoint {
  runId: string
  round: number
  createdAt: string
  notebook: LeadNotebook | null
  report: string | null
  warning: string | null
}

export interface LeadState {
  enabled: boolean
  dispatch: LeadDispatch | null
  /** Newest first; older checkpoints remain in the complete event history. */
  checkpoints: LeadCheckpoint[]
  latestNotebook: LeadCheckpoint | null
  totalCheckpoints: number
  checkpointOffset: number
}

export function parseLeadNotebook(value: unknown): LeadNotebook {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid lead notebook.')
  const record = value as Record<string, unknown>
  const result = {} as LeadNotebook
  for (const key of LEAD_NOTEBOOK_FIELDS) {
    const text = record[key]
    if (typeof text !== 'string' || text.length > 4000) throw new Error(`Invalid lead notebook field: ${key}.`)
    result[key] = text
  }
  return result
}

export function extractLeadNotebook(response: string, runId: string): LeadNotebook | null {
  const start = response.lastIndexOf('<lead-notebook>')
  if (start === -1) return null
  const end = response.indexOf('</lead-notebook>', start)
  if (end === -1 || end - start > 30000) throw new Error('Incomplete or oversized lead notebook.')
  const value: unknown = JSON.parse(response.slice(start + '<lead-notebook>'.length, end))
  if (!value || typeof value !== 'object' || (value as Record<string, unknown>).attemptId !== runId) {
    throw new Error('Lead notebook belongs to a different attempt.')
  }
  return parseLeadNotebook(value)
}

/** Only an explicit CLI session lookup rejection permits automatic fresh-session recovery. */
export function isMissingLeadSession(text: string): boolean {
  return /(?:no (?:conversation|session|thread) (?:found|exists)(?: with| for| matching)?|(?:conversation|session|thread)(?: with (?:id )?[^\n]{1,140})? (?:not found|does not exist)|failed to (?:find|load|resume) (?:session|thread)[^\n]{0,140}(?:not found|no such file))/i.test(text)
}

export function parseLeadUsage(value: unknown): TokenTotals {
  if (!value || typeof value !== 'object') throw new Error('Invalid lead usage baseline.')
  const record = value as Record<string, unknown>, tokens = {} as TokenTotals
  for (const key of ['input', 'output', 'cacheRead', 'cacheWrite'] as const) {
    const n = record[key]
    if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0) throw new Error('Invalid lead usage baseline.')
    tokens[key] = n
  }
  return tokens
}
