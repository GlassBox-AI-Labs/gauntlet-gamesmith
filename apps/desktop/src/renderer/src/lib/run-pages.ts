import type { LoopSnapshot } from '../../../shared/loop'

/** Keep at most one heavy detail snapshot resident in renderer state. */
function compactForList(snapshot: LoopSnapshot): LoopSnapshot {
  if (snapshot.runs.length === 0) return snapshot
  const totalRuns = snapshot.totalRuns ?? snapshot.runs.length
  return {
    loop: { ...snapshot.loop, prompt: snapshot.loop.prompt.slice(0, 1_024) },
    runs: [],
    totalRuns,
    hasMoreRuns: totalRuns > 0,
    projectionWarning: totalRuns > 0 ? 'Select this run to load its bounded attempt history.' : null,
  }
}

/** Hydrate the selected run in place so clicking a history never changes sidebar order. */
export function selectSnapshotInList(current: LoopSnapshot[], detail: LoopSnapshot): LoopSnapshot[] {
  const selectedIndex = current.findIndex((item) => item.loop.id === detail.loop.id)
  const compacted = current.map(compactForList)
  if (selectedIndex < 0) return [detail, ...compacted]
  compacted[selectedIndex] = detail
  return compacted
}

/** Keep an explicitly selected older page stable while live updates refresh canonical loop totals. */
export function applySnapshotUpdate(current: LoopSnapshot | null, incoming: LoopSnapshot): LoopSnapshot {
  if (!current || current.loop.id !== incoming.loop.id || (current.runOffset ?? 0) === 0) return incoming
  return {
    ...current,
    loop: incoming.loop,
    totalRuns: incoming.totalRuns,
    aggregate: incoming.aggregate,
  }
}

/** Offset of the next older bounded page, or null once every canonical row is behind this page. */
export function olderRunPageOffset(snapshot: LoopSnapshot): number | null {
  const end = (snapshot.runOffset ?? 0) + snapshot.runs.length
  return end < (snapshot.totalRuns ?? snapshot.runs.length) ? end : null
}

/** Discard expansion state for histories no longer resident in the bounded sidebar page. */
export function pruneExpandedLoops(current: Set<string>, snapshots: readonly LoopSnapshot[]): Set<string> {
  const allowed = new Set(snapshots.map((snapshot) => snapshot.loop.id))
  const next = new Set([...current].filter((loopId) => allowed.has(loopId)))
  return next.size === current.size ? current : next
}

/** Keep per-loop round disclosure state bounded to the resident projected rounds. */
export function pruneVisibleRoundCounts(
  current: Readonly<Record<string, number>>,
  snapshots: readonly LoopSnapshot[],
  defaultLimit: number,
): Record<string, number> {
  const roundCounts = new Map(snapshots.map((snapshot) => [
    snapshot.loop.id,
    new Set(snapshot.runs.filter((run) => run.role !== 'consult' && run.round > 0).map((run) => run.round)).size,
  ]))
  let changed = false
  const next: Record<string, number> = {}
  for (const [loopId, value] of Object.entries(current)) {
    const count = roundCounts.get(loopId) ?? 0
    if (count <= defaultLimit) {
      changed = true
      continue
    }
    const bounded = Math.max(defaultLimit, Math.min(count, Math.floor(value)))
    next[loopId] = bounded
    if (bounded !== value) changed = true
  }
  return changed || Object.keys(next).length !== Object.keys(current).length ? next : current as Record<string, number>
}
