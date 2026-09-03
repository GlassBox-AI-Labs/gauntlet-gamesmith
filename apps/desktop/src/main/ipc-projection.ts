import type { LoopListPage, LoopRecord, LoopSnapshot, RunRecord } from '../shared/loop'

export const IPC_LOOP_LIST_LIMIT = 100
export const IPC_SNAPSHOT_RUN_LIMIT = 200
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

function boundedRun(run: RunRecord): { run: RunRecord; truncated: boolean } {
  const prompt = boundedText(run.prompt, PROMPT_LIMIT)
  const summary = boundedText(run.summary, TEXT_LIMIT)
  const error = boundedText(run.error, TEXT_LIMIT)
  const verdict = run.verdict && bytes(run.verdict) <= VERDICT_LIMIT ? run.verdict : null
  const metrics = run.metrics && bytes(run.metrics) <= METRICS_LIMIT ? run.metrics : null
  return {
    run: { ...run, prompt: prompt.value ?? '', summary: summary.value, error: error.value, verdict, metrics },
    truncated: prompt.truncated || summary.truncated || error.truncated || (run.verdict != null && verdict == null) || (run.metrics != null && metrics == null),
  }
}

/** Bound every full snapshot before Electron structured-clones it to the renderer. */
export function boundedLoopSnapshot(snapshot: LoopSnapshot): LoopSnapshot {
  const totalRuns = snapshot.totalRuns ?? snapshot.runs.length
  const runOffset = snapshot.runOffset ?? 0
  const recent = snapshot.runs.slice(-IPC_SNAPSHOT_RUN_LIMIT)
  const kept: RunRecord[] = []
  let projectedBytes = bytes(snapshot.loop)
  let truncatedFields = false
  for (let index = recent.length - 1; index >= 0; index -= 1) {
    const projected = boundedRun(recent[index])
    const runBytes = bytes(projected.run)
    if (projectedBytes + runBytes > IPC_SNAPSHOT_BYTE_LIMIT) break
    kept.unshift(projected.run)
    projectedBytes += runBytes
    truncatedFields ||= projected.truncated
  }
  const omitted = Math.max(0, totalRuns - runOffset - kept.length)
  const detailTruncated = truncatedFields || snapshot.detailTruncated === true
  const hasMoreRuns = runOffset + kept.length < totalRuns || detailTruncated
  const warnings = [
    omitted > 0 ? `${omitted} older attempt${omitted === 1 ? '' : 's'} were omitted from this page.` : null,
    detailTruncated ? 'Oversized prompt, verdict, or metrics fields were elided.' : null,
  ].filter((warning): warning is string => warning != null)
  return {
    loop: snapshot.loop,
    runs: kept,
    totalRuns,
    runOffset,
    aggregate: snapshot.aggregate,
    hasMoreRuns,
    detailTruncated,
    projectionWarning: warnings.length > 0 ? warnings.join(' ') : null,
  }
}

/** History list rows carry no attempt payload; selection fetches one bounded detail snapshot. */
export function loopSummarySnapshot(loop: LoopRecord, totalRuns: number): LoopSnapshot {
  const prompt = boundedText(loop.prompt, 1_024)
  return {
    loop: { ...loop, prompt: prompt.value ?? '' },
    runs: [],
    totalRuns,
    runOffset: 0,
    hasMoreRuns: totalRuns > 0 || prompt.truncated,
    detailTruncated: prompt.truncated,
    projectionWarning: totalRuns > 0 || prompt.truncated ? 'Select this run to load its bounded attempt history.' : null,
  }
}

export function loopListPage(loops: LoopRecord[], total: number, offset: number, runCount: (loopId: string) => number): LoopListPage {
  return {
    snapshots: loops.map((loop) => loopSummarySnapshot(loop, runCount(loop.id))),
    total,
    offset,
    hasMore: offset + loops.length < total,
  }
}
