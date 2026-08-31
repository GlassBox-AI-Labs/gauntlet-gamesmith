import type { RunRecord } from './loop'

type TimedRun = Pick<RunRecord, 'status' | 'startedAt' | 'finishedAt' | 'durationMs'>

function timestamp(value: string | null): number | null {
  if (!value) return null
  const parsed = new Date(value).getTime()
  return Number.isNaN(parsed) ? null : parsed
}

function elapsedFrom(origin: number, target: number | null): number | null {
  return target == null ? null : Math.max(0, target - origin)
}

/** Wall-clock time from loop creation until this attempt began. */
export function elapsedToRunStartMs(loopCreatedAt: string, run: TimedRun): number | null {
  const origin = timestamp(loopCreatedAt)
  if (origin == null) return null

  const finished = timestamp(run.finishedAt)
  const started = timestamp(run.startedAt) ?? (finished != null && run.durationMs != null ? finished - run.durationMs : null)
  return elapsedFrom(origin, started)
}

/**
 * Wall-clock time from loop creation through the furthest known point in an
 * attempt. Finished attempts use their finish timestamp; a live attempt uses
 * `nowMs`; older records can fall back to start + recorded duration.
 */
export function elapsedThroughRunMs(loopCreatedAt: string, run: TimedRun, nowMs = Date.now()): number | null {
  const origin = timestamp(loopCreatedAt)
  if (origin == null) return null

  const started = timestamp(run.startedAt)
  const finished = timestamp(run.finishedAt)
  const target =
    finished ??
    (run.status === 'running' && started != null
      ? nowMs
      : started != null && run.durationMs != null
        ? started + run.durationMs
        : started)

  return elapsedFrom(origin, target)
}

/**
 * How long an attempt has run. A live attempt has no recorded duration yet,
 * so count from its start time up to `nowMs`.
 */
export function runtimeMs(run: TimedRun, nowMs = Date.now()): number | null {
  if (run.durationMs != null) return run.durationMs
  if (run.status !== 'running') return null
  const started = timestamp(run.startedAt)
  return started == null ? null : Math.max(0, nowMs - started)
}
