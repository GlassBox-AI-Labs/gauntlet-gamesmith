import type { TokenTotals } from '../shared/loop'
import { canonicalModelId, MODEL_IDS } from '../shared/models'

export const PRICE_TABLE_VERSION = '2026-09-02'

// USD per MTok, list prices as of PRICE_TABLE_VERSION.
// claude cacheWrite is priced at the 1h TTL (2x input — what subscription
// Claude Code uses); gpt cache writes bill at 1.25x input and cached input at
// 10% of it, which gpt-6-astra follows too. Sol's rate is the 2026-08-22 cut,
// promotional through at least 2026-11-21 — revisit the table then.
//
// Cache reads are 10% of input on every model here EXCEPT Fable 5.1, which
// Anthropic prices at 2.5% ($0.25/MTok against a $10 input) — the one place a
// uniform multiplier would overcharge by 4x.
//
// Order matters. `estimateCostUsd` falls back to a prefix match, and
// `claude-fable-5-1` starts with `claude-fable-5`, so the longer key has to be
// found first or 5.1 silently bills at 5's cache-read rate.
const PRICES: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  [MODEL_IDS.claudeFable51]: { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 20 },
  [MODEL_IDS.claudeFable]: { input: 10, output: 50, cacheRead: 1, cacheWrite: 20 },
  [MODEL_IDS.claudeOpus]: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 10 },
  // $2/$10 was announced as introductory through 2026-08-31; Anthropic has
  // since made it the standard price and cancelled the rise to $3/$15.
  [MODEL_IDS.claudeSonnet]: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 4 },
  [MODEL_IDS.claudeHaiku]: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 2 },
  [MODEL_IDS.codexAstra]: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
  [MODEL_IDS.codexSol]: { input: 4, output: 20, cacheRead: 0.4, cacheWrite: 5 },
  [MODEL_IDS.codexTerra]: { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 2.5 },
  [MODEL_IDS.codexLuna]: { input: 0.2, output: 1.2, cacheRead: 0.02, cacheWrite: 0.25 },
}

export function estimateCostUsd(model: string | null | undefined, tokens: TokenTotals): number | null {
  if (!model) return null
  const key = canonicalModelId(model)
  if (!key) return null
  const p = PRICES[key]
  if (!p) return null
  return (
    (tokens.input * p.input + tokens.output * p.output + tokens.cacheRead * p.cacheRead + tokens.cacheWrite * p.cacheWrite) /
    1_000_000
  )
}
