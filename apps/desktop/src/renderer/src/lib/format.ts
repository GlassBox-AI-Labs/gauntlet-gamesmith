export function fmtTokens(n: number | null | undefined): string {
  if (n == null) return '—'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

/** Stopwatch style, for a single attempt: `04:12`, or `01:04:12` past an hour. */
export function fmtDuration(ms: number | null | undefined): string {
  if (ms == null) return '—'
  const totalSec = Math.round(ms / 1000)
  const pad = (n: number): string => String(n).padStart(2, '0')
  const h = Math.floor(totalSec / 3600)
  const mmss = `${pad(Math.floor(totalSec / 60) % 60)}:${pad(totalSec % 60)}`
  return h > 0 ? `${pad(h)}:${mmss}` : mmss
}

/** Spoken style, for long spans that are read rather than watched: `3h07m`. */
export function fmtSpan(ms: number | null | undefined): string {
  if (ms == null) return '—'
  const totalSec = Math.round(ms / 1000)
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor(totalSec / 60) % 60
  if (h > 0) return `${h}h${String(m).padStart(2, '0')}m`
  return m > 0 ? `${m}m${String(totalSec % 60).padStart(2, '0')}s` : `${totalSec}s`
}

export function fmtUsd(value: number | null | undefined): string {
  return value == null ? '—' : `$${value.toFixed(2)}`
}
