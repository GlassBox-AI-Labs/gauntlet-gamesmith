import type { BuildRecord } from '../shared/build'
import { failure, success, type OperationResult } from '../shared/result'

interface BuildLookup {
  getBuild(id: string): BuildRecord | null
}

interface BuildStopper {
  stop(id: string): void
}

export function stopExistingBuild(ledger: BuildLookup, runner: BuildStopper, buildId: string): OperationResult<void> {
  if (!ledger.getBuild(buildId)) return failure('Build not found.')
  runner.stop(buildId)
  return success(undefined)
}
