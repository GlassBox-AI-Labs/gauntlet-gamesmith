import type { TokenTotals } from '../shared/loop'

export const PRICE_TABLE_VERSION = '2026-08-31'

// USD per MTok, list prices as of PRICE_TABLE_VERSION.
// claude cacheWrite is priced at the 1h TTL (2x input — what subscription
// Claude Code uses); gpt-5.6 cache writes bill at 1.25x input and cached input
// at 10% of it. Sol's rate is the 2026-08-22 cut, promotional through at least
// 2026-11-21 — revisit the table then.
const PRICES: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  'claude-fable-5': { input: 10, output: 50, cacheRead: 1, cacheWrite: 20 },
  'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 10 },
  'claude-sonnet-5': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 6 },
  'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 2 },
  'gpt-5.6-sol': { input: 4, output: 20, cacheRead: 0.4, cacheWrite: 5 },
  'gpt-5.6-terra': { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 2.5 },
  'gpt-5.6-luna': { input: 0.2, output: 1.2, cacheRead: 0.02, cacheWrite: 0.25 },
}

export function estimateCostUsd(model: string | null | undefined, tokens: TokenTotals): number | null {
  if (!model) return null
  const key = Object.keys(PRICES).find((k) => model === k || model.startsWith(k) || model.includes(k))
  if (!key) return null
  const p = PRICES[key]
  return (
    (tokens.input * p.input + tokens.output * p.output + tokens.cacheRead * p.cacheRead + tokens.cacheWrite * p.cacheWrite) /
    1_000_000
  )
}
