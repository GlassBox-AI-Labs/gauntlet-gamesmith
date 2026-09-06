import type { PhaseAttempt } from './build'

type TimedAttempt = Pick<PhaseAttempt, 'status' | 'startedAt' | 'finishedAt' | 'durationMs'>

function timestamp(value: string | null): number | null {
  if (!value) return null
  const parsed = new Date(value).getTime()
  return Number.isNaN(parsed) ? null : parsed
}

function elapsedFrom(origin: number, target: number | null): number | null {
  return target == null ? null : Math.max(0, target - origin)
}

/** Wall-clock time from build creation until this attempt began. */
export function elapsedToAttemptStartMs(buildCreatedAt: string, attempt: TimedAttempt): number | null {
  const origin = timestamp(buildCreatedAt)
  if (origin == null) return null

  const finished = timestamp(attempt.finishedAt)
  const started = timestamp(attempt.startedAt) ?? (finished != null && attempt.durationMs != null ? finished - attempt.durationMs : null)
  return elapsedFrom(origin, started)
}

/**
 * Wall-clock time from build creation through the furthest known point in an
 * attempt. Finished attempts use their finish timestamp; a live attempt uses
 * `nowMs`; older records can fall back to start + recorded duration.
 */
export function elapsedThroughAttemptMs(buildCreatedAt: string, attempt: TimedAttempt, nowMs = Date.now()): number | null {
  const origin = timestamp(buildCreatedAt)
  if (origin == null) return null

  const started = timestamp(attempt.startedAt)
  const finished = timestamp(attempt.finishedAt)
  const target =
    finished ??
    (attempt.status === 'running' && started != null
      ? nowMs
      : started != null && attempt.durationMs != null
        ? started + attempt.durationMs
        : started)

  return elapsedFrom(origin, target)
}

/**
 * How long an attempt has run. A live attempt has no recorded duration yet,
 * so count from its start time up to `nowMs`.
 */
export function runtimeMs(attempt: TimedAttempt, nowMs = Date.now()): number | null {
  if (attempt.durationMs != null) return attempt.durationMs
  if (attempt.status !== 'running') return null
  const started = timestamp(attempt.startedAt)
  return started == null ? null : Math.max(0, nowMs - started)
}
