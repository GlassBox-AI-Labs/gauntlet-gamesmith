import type { LoopRecord } from '../shared/loop'
import { failure, success, type OperationResult } from '../shared/result'

interface LoopLookup {
  getLoop(id: string): LoopRecord | null
}

interface LoopStopper {
  stop(id: string): void
}

export function stopExistingLoop(ledger: LoopLookup, runner: LoopStopper, loopId: string): OperationResult<void> {
  if (!ledger.getLoop(loopId)) return failure('Run not found.')
  runner.stop(loopId)
  return success(undefined)
}
