import path from 'node:path'
import fs from 'node:fs'
import type { BuildRecord } from '../shared/build'
import { canonicalizePath } from './build-transfer'

function contains(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

/** Reject any project/copy root that could include or mutate private app data. */
export function assertWorkspaceBoundary(workspaceDir: string, protectedRoots: readonly string[]): string {
  const workspace = canonicalizePath(workspaceDir)
  if (workspace === path.parse(workspace).root) throw new Error('The filesystem root cannot be used as a Gauntlet workspace.')
  for (const root of protectedRoots) {
    const protectedRoot = canonicalizePath(root)
    if (contains(workspace, protectedRoot) || contains(protectedRoot, workspace)) {
      throw new Error('The selected path overlaps private app data or CLI credential homes. Choose a separate project folder.')
    }
  }
  return workspace
}

export interface WorkspaceRootIdentity {
  workspaceDir: string
  workspaceIdentity?: { dev: number; ino: number } | null
}

export function captureWorkspaceIdentity(
  workspaceDir: string,
  protectedRoots: readonly string[],
): { workspaceDir: string; workspaceIdentity: { dev: number; ino: number } } {
  const canonical = assertWorkspaceBoundary(workspaceDir, protectedRoots)
  const stat = fs.lstatSync(canonical)
  if (
    !stat.isDirectory()
    || stat.isSymbolicLink()
    || !Number.isSafeInteger(stat.dev)
    || stat.dev <= 0
    || !Number.isSafeInteger(stat.ino)
    || stat.ino <= 0
  ) throw new Error('The selected workspace is not a stable real directory.')
  return { workspaceDir: canonical, workspaceIdentity: { dev: stat.dev, ino: stat.ino } }
}

/** Revalidate both protected-root separation and the exact registered root. */
export function assertBuildWorkspaceIdentity(
  build: WorkspaceRootIdentity | Pick<BuildRecord, 'workspaceDir' | 'workspaceIdentity'>,
  protectedRoots: readonly string[],
): string {
  const canonical = assertWorkspaceBoundary(build.workspaceDir, protectedRoots)
  const identity = build.workspaceIdentity
  if (!identity || canonical !== path.resolve(build.workspaceDir)) {
    throw new Error('Workspace identity is unavailable or its canonical path changed; execution and file access are blocked.')
  }
  const stat = fs.lstatSync(build.workspaceDir)
  if (
    !stat.isDirectory()
    || stat.isSymbolicLink()
    || stat.dev !== identity.dev
    || stat.ino !== identity.ino
    || fs.realpathSync(build.workspaceDir) !== build.workspaceDir
  ) throw new Error('Workspace root changed identity; execution and file access are blocked.')
  return canonical
}
