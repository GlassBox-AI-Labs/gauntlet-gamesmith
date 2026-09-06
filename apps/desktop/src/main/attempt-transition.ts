import type { Ledger } from './ledger'

type AttemptPatch = Parameters<Ledger['patchAttempt']>[1]

/**
 * Close a running attempt exactly once. The attempt's terminal state, its cost
 * contribution, and any successor rows share one SQLite transaction.
 *
 * Live metric flushes may happen before this call. They are deliberately not
 * charged to the build until the attempt is terminal, so replaying a finalizer
 * after a crash cannot charge or queue twice.
 */
export function commitRunningAttempt(
  ledger: Ledger,
  buildId: string,
  attemptId: string,
  patch: AttemptPatch & { status: 'succeeded' | 'failed' | 'cancelled' | 'interrupted' },
  transition?: () => void,
): boolean {
  let applied = false
  ledger.transaction(() => {
    const attempt = ledger.getAttempt(attemptId)
    const build = ledger.getBuild(buildId)
    if (!attempt || attempt.buildId !== buildId || attempt.status !== 'running' || !build) return

    // Every terminal attempt must carry a terminal timestamp, including
    // automatic retries and budget stops. Centralizing the fallback here
    // prevents a new transition branch from leaving an attempt looking live.
    ledger.patchAttempt(attemptId, { ...patch, finishedAt: patch.finishedAt ?? new Date().toISOString() })
    const costUsd = patch.costUsd === undefined ? attempt.costUsd : patch.costUsd
    if (typeof costUsd === 'number' && Number.isFinite(costUsd) && costUsd > 0) {
      ledger.patchBuild(buildId, { totalCostUsd: build.totalCostUsd + costUsd })
    }
    transition?.()
    applied = true
  })
  return applied
}
