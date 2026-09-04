const SAFE_LOOP_ID = /^[a-zA-Z0-9-]+$/

/** Canonical workspace-relative directory for a loop's frozen Reference Pack. */
export function referencePackDir(loopId: string): string {
  if (!SAFE_LOOP_ID.test(loopId)) throw new Error('Invalid loop id for Reference Pack path.')
  return `reference/${loopId}`
}

/** Historical loops without an explicit reference phase used the shared reference/ directory. */
export function referenceRootForLoop(loopId: string, hasReferenceRun: boolean): string {
  return hasReferenceRun ? referencePackDir(loopId) : 'reference'
}
