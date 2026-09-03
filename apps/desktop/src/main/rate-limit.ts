const RATE_LIMIT_PATTERNS = [
  /\bHTTP\s*429\b|\btoo many requests\b/i,
  /\byou(?:'|’)ve hit your (?:session|weekly|usage) limit\b/i,
  /\b(?:usage|session|weekly) limit (?:reached|exceeded)\b/i,
  /\bout of extra usage\b/i,
  /\brate-limited\b/i,
  /\b(?:request|account|session|organization|workspace|you|we) (?:was |were |is |are )?rate[- ]limited\b/i,
  /\brate limit (?:reached|exceeded)\b/i,
  /\brate limit\b[^\n]{0,120}\b(?:retry|reset(?:s|ting)?)\b/i,
]
const MIN_RETRY_MS = 30_000
const MAX_RETRY_MS = 15 * 60_000
export const MAX_RATE_LIMIT_PAUSES = 8

export interface RateLimitPause {
  delayMs: number
  retryAtMs: number
}

export function isRateLimitError(error: string): boolean {
  return RATE_LIMIT_PATTERNS.some((pattern) => pattern.test(error))
}

/** Detect provider throttling and choose a visible, bounded exponential pause. */
export function rateLimitPause(error: string, priorPauses: number, nowMs = Date.now()): RateLimitPause | null {
  if (!isRateLimitError(error)) return null
  const retryAfter = /retry(?:\s+after|\s+in)?\s*[:=]?\s*(\d+)\s*(ms|milliseconds?|s|sec(?:onds?)?|m|min(?:utes?)?)/i.exec(error)
  const resetAt = /reset(?:s|ting)?(?:\s+at)?\s*[:=]?\s*(\d{4}-\d{2}-\d{2}T[^\s,)]+)/i.exec(error)
  let requestedMs: number | null = null
  if (retryAfter) {
    const amount = Number(retryAfter[1])
    const unit = retryAfter[2].toLowerCase()
    requestedMs = unit.startsWith('m') && unit !== 'ms' && !unit.startsWith('mill') ? amount * 60_000 : unit.startsWith('s') ? amount * 1_000 : amount
  } else if (resetAt) {
    const parsed = Date.parse(resetAt[1])
    if (Number.isFinite(parsed)) requestedMs = parsed - nowMs
  }
  const exponentialMs = MIN_RETRY_MS * 2 ** Math.min(Math.max(0, priorPauses), 5)
  const delayMs = Math.min(MAX_RETRY_MS, Math.max(MIN_RETRY_MS, requestedMs ?? exponentialMs))
  return { delayMs, retryAtMs: nowMs + delayMs }
}

export function retryAtFromError(error: string | null): number | null {
  const match = error ? /retry scheduled for (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)/i.exec(error) : null
  if (!match) return null
  const parsed = Date.parse(match[1])
  return Number.isFinite(parsed) ? parsed : null
}
