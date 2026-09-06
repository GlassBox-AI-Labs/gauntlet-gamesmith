import type { BuildSnapshot } from '../../../shared/build'

/** Keep at most one heavy detail snapshot resident in renderer state. */
function compactForList(snapshot: BuildSnapshot): BuildSnapshot {
  if (snapshot.attempts.length === 0) return snapshot
  const totalAttempts = snapshot.totalAttempts ?? snapshot.attempts.length
  return {
    build: { ...snapshot.build, prompt: snapshot.build.prompt.slice(0, 1_024) },
    attempts: [],
    totalAttempts,
    hasMoreAttempts: totalAttempts > 0,
    projectionWarning: totalAttempts > 0 ? 'Select this build to load its bounded attempt history.' : null,
  }
}

/** Hydrate the selected build in place so clicking a history never changes sidebar order. */
export function selectSnapshotInList(current: BuildSnapshot[], detail: BuildSnapshot): BuildSnapshot[] {
  const selectedIndex = current.findIndex((item) => item.build.id === detail.build.id)
  const compacted = current.map(compactForList)
  if (selectedIndex < 0) return [detail, ...compacted]
  compacted[selectedIndex] = detail
  return compacted
}

/** Keep an explicitly selected older page stable while live updates refresh canonical build totals. */
export function applySnapshotUpdate(current: BuildSnapshot | null, incoming: BuildSnapshot): BuildSnapshot {
  if (!current || current.build.id !== incoming.build.id || (current.attemptOffset ?? 0) === 0) return incoming
  return {
    ...current,
    build: incoming.build,
    totalAttempts: incoming.totalAttempts,
    aggregate: incoming.aggregate,
  }
}

/** Offset of the next older bounded page, or null once every canonical row is behind this page. */
export function olderAttemptPageOffset(snapshot: BuildSnapshot): number | null {
  const end = (snapshot.attemptOffset ?? 0) + snapshot.attempts.length
  return end < (snapshot.totalAttempts ?? snapshot.attempts.length) ? end : null
}

/** Discard expansion state for histories no longer resident in the bounded sidebar page. */
export function pruneExpandedBuilds(current: Set<string>, snapshots: readonly BuildSnapshot[]): Set<string> {
  const allowed = new Set(snapshots.map((snapshot) => snapshot.build.id))
  const next = new Set([...current].filter((buildId) => allowed.has(buildId)))
  return next.size === current.size ? current : next
}

/** Keep per-build round disclosure state bounded to the resident projected rounds. */
export function pruneVisibleRoundCounts(
  current: Readonly<Record<string, number>>,
  snapshots: readonly BuildSnapshot[],
  defaultLimit: number,
): Record<string, number> {
  const roundCounts = new Map(snapshots.map((snapshot) => [
    snapshot.build.id,
    new Set(snapshot.attempts.filter((attempt) => attempt.role !== 'consult' && attempt.round > 0).map((attempt) => attempt.round)).size,
  ]))
  let changed = false
  const next: Record<string, number> = {}
  for (const [buildId, value] of Object.entries(current)) {
    const count = roundCounts.get(buildId) ?? 0
    if (count <= defaultLimit) {
      changed = true
      continue
    }
    const bounded = Math.max(defaultLimit, Math.min(count, Math.floor(value)))
    next[buildId] = bounded
    if (bounded !== value) changed = true
  }
  return changed || Object.keys(next).length !== Object.keys(current).length ? next : current as Record<string, number>
}
