import type { BuildListPage, BuildRecord, BuildSnapshot, PhaseAttempt } from '../shared/build'

export const IPC_BUILD_LIST_LIMIT = 100
export const IPC_SNAPSHOT_ATTEMPT_LIMIT = 200
export const IPC_SNAPSHOT_BYTE_LIMIT = 8 * 1024 * 1024
const PROMPT_LIMIT = 64 * 1024
const TEXT_LIMIT = 16 * 1024
const VERDICT_LIMIT = 256 * 1024
const METRICS_LIMIT = 512 * 1024

function bytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8')
}

function boundedText(value: string | null, limit: number): { value: string | null; truncated: boolean } {
  if (value == null || value.length <= limit) return { value, truncated: false }
  return { value: value.slice(0, limit), truncated: true }
}

function boundedAttempt(attempt: PhaseAttempt): { attempt: PhaseAttempt; truncated: boolean } {
  const prompt = boundedText(attempt.prompt, PROMPT_LIMIT)
  const summary = boundedText(attempt.summary, TEXT_LIMIT)
  const error = boundedText(attempt.error, TEXT_LIMIT)
  const verdict = attempt.verdict && bytes(attempt.verdict) <= VERDICT_LIMIT ? attempt.verdict : null
  const metrics = attempt.metrics && bytes(attempt.metrics) <= METRICS_LIMIT ? attempt.metrics : null
  return {
    attempt: { ...attempt, prompt: prompt.value ?? '', summary: summary.value, error: error.value, verdict, metrics },
    truncated: prompt.truncated || summary.truncated || error.truncated || (attempt.verdict != null && verdict == null) || (attempt.metrics != null && metrics == null),
  }
}

/** Bound every full snapshot before Electron structured-clones it to the renderer. */
export function boundedBuildSnapshot(snapshot: BuildSnapshot): BuildSnapshot {
  const totalAttempts = snapshot.totalAttempts ?? snapshot.attempts.length
  const attemptOffset = snapshot.attemptOffset ?? 0
  const recent = snapshot.attempts.slice(-IPC_SNAPSHOT_ATTEMPT_LIMIT)
  const kept: PhaseAttempt[] = []
  let projectedBytes = bytes(snapshot.build)
  let truncatedFields = false
  for (let index = recent.length - 1; index >= 0; index -= 1) {
    const projected = boundedAttempt(recent[index])
    const attemptBytes = bytes(projected.attempt)
    if (projectedBytes + attemptBytes > IPC_SNAPSHOT_BYTE_LIMIT) break
    kept.unshift(projected.attempt)
    projectedBytes += attemptBytes
    truncatedFields ||= projected.truncated
  }
  const omitted = Math.max(0, totalAttempts - attemptOffset - kept.length)
  const detailTruncated = truncatedFields || snapshot.detailTruncated === true
  const hasMoreAttempts = attemptOffset + kept.length < totalAttempts || detailTruncated
  const warnings = [
    omitted > 0 ? `${omitted} older attempt${omitted === 1 ? '' : 's'} were omitted from this page.` : null,
    detailTruncated ? 'Oversized prompt, verdict, or metrics fields were elided.' : null,
  ].filter((warning): warning is string => warning != null)
  return {
    build: snapshot.build,
    attempts: kept,
    totalAttempts,
    attemptOffset,
    aggregate: snapshot.aggregate,
    hasMoreAttempts,
    detailTruncated,
    projectionWarning: warnings.length > 0 ? warnings.join(' ') : null,
  }
}

/** History list rows carry no attempt payload; selection fetches one bounded detail snapshot. */
export function buildSummarySnapshot(build: BuildRecord, totalAttempts: number): BuildSnapshot {
  const prompt = boundedText(build.prompt, 1_024)
  return {
    build: { ...build, prompt: prompt.value ?? '' },
    attempts: [],
    totalAttempts,
    attemptOffset: 0,
    hasMoreAttempts: totalAttempts > 0 || prompt.truncated,
    detailTruncated: prompt.truncated,
    projectionWarning: totalAttempts > 0 || prompt.truncated ? 'Select this build to load its bounded attempt history.' : null,
  }
}

export function buildListPage(builds: BuildRecord[], total: number, offset: number, attemptCount: (buildId: string) => number): BuildListPage {
  return {
    snapshots: builds.map((build) => buildSummarySnapshot(build, attemptCount(build.id))),
    total,
    offset,
    hasMore: offset + builds.length < total,
  }
}
