import type { BuildRecord, BuildApi } from '../../../shared/build'

/** Capture the action's build and selection generation across the native confirmation. */
export async function withExistingBuildTrust<T>(
  build: BuildRecord,
  trust: BuildApi['trust'],
  stillSelected: () => boolean,
  action: (id: string) => Promise<T>,
): Promise<T | undefined> {
  // Main decides whether consent is needed, even when the renderer projection is stale.
  const result = await trust(build.id)
  if (!stillSelected()) return undefined
  if (!result.ok) throw new Error(result.error)
  if (!result.value) return undefined
  if (result.value.id !== build.id || result.value.workspaceDir !== build.workspaceDir) {
    throw new Error('The confirmed build no longer matches the selected build.')
  }
  return action(build.id)
}
