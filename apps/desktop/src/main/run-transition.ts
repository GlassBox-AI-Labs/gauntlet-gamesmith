import type { Ledger } from './ledger'

type RunPatch = Parameters<Ledger['patchRun']>[1]

/**
 * Close a running attempt exactly once. The run's terminal state, its cost
 * contribution, and any successor rows share one SQLite transaction.
 *
 * Live metric flushes may happen before this call. They are deliberately not
 * charged to the loop until the attempt is terminal, so replaying a finalizer
 * after a crash cannot charge or queue twice.
 */
export function commitRunningAttempt(
  ledger: Ledger,
  loopId: string,
  runId: string,
  patch: RunPatch & { status: 'succeeded' | 'failed' | 'cancelled' | 'interrupted' },
  transition?: () => void,
): boolean {
  let applied = false
  ledger.transaction(() => {
    const run = ledger.getRun(runId)
    const loop = ledger.getLoop(loopId)
    if (!run || run.loopId !== loopId || run.status !== 'running' || !loop) return

    // Every terminal attempt must carry a terminal timestamp, including
    // automatic retries and budget stops. Centralizing the fallback here
    // prevents a new transition branch from leaving a run looking live.
    ledger.patchRun(runId, { ...patch, finishedAt: patch.finishedAt ?? new Date().toISOString() })
    const costUsd = patch.costUsd === undefined ? run.costUsd : patch.costUsd
    if (typeof costUsd === 'number' && Number.isFinite(costUsd) && costUsd > 0) {
      ledger.patchLoop(loopId, { totalCostUsd: loop.totalCostUsd + costUsd })
    }
    transition?.()
    applied = true
  })
  return applied
}
