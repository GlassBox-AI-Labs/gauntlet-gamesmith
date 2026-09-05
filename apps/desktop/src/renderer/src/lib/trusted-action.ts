import type { LoopRecord, LoopApi } from '../../../shared/loop'

/** Capture the action's run and selection generation across the native confirmation. */
export async function withExistingRunTrust<T>(
  loop: LoopRecord,
  trust: LoopApi['trust'],
  stillSelected: () => boolean,
  action: (id: string) => Promise<T>,
): Promise<T | undefined> {
  // Main decides whether consent is needed, even when the renderer projection is stale.
  const result = await trust(loop.id)
  if (!stillSelected()) return undefined
  if (!result.ok) throw new Error(result.error)
  if (!result.value) return undefined
  if (result.value.id !== loop.id || result.value.workspaceDir !== loop.workspaceDir) {
    throw new Error('The confirmed run no longer matches the selected run.')
  }
  return action(loop.id)
}
