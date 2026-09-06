const SAFE_BUILD_ID = /^[a-zA-Z0-9-]+$/

/** Canonical workspace-relative directory for a build's frozen Reference Pack. */
export function referencePackDir(buildId: string): string {
  if (!SAFE_BUILD_ID.test(buildId)) throw new Error('Invalid build id for Reference Pack path.')
  return `reference/${buildId}`
}

/** Historical builds without an explicit reference phase used the shared reference/ directory. */
export function referenceRootForBuild(buildId: string, hasReferenceAttempt: boolean): string {
  return hasReferenceAttempt ? referencePackDir(buildId) : 'reference'
}
