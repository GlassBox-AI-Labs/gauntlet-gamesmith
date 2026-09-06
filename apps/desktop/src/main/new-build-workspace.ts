import fs from 'node:fs'
import path from 'node:path'
import { assertBuildWorkspaceIdentity, assertWorkspaceBoundary, captureWorkspaceIdentity } from './workspace-boundary'

const MAX_FOLDER_ATTEMPTS = 10_000

export function buildWorkspaceFolderName(title: string): string {
  const slug = title
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/g, '')
  return slug || 'build'
}

/** Create one exclusive project directory beneath an operator-selected root. */
export function createNewBuildWorkspace(
  rootDir: string,
  title: string,
  protectedRoots: readonly string[],
): { workspaceDir: string; workspaceIdentity: { dev: number; ino: number } } {
  const requestedRoot = assertWorkspaceBoundary(rootDir, protectedRoots)
  fs.mkdirSync(requestedRoot, { recursive: true, mode: 0o700 })
  const root = captureWorkspaceIdentity(requestedRoot, protectedRoots)
  const base = buildWorkspaceFolderName(title)

  for (let attempt = 1; attempt <= MAX_FOLDER_ATTEMPTS; attempt += 1) {
    const name = attempt === 1 ? base : `${base}-${attempt}`
    const candidate = assertWorkspaceBoundary(path.join(root.workspaceDir, name), protectedRoots)
    try {
      fs.mkdirSync(candidate, { recursive: false, mode: 0o700 })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue
      throw error
    }
    // Refuse a parent swap that raced the exclusive child creation.
    assertBuildWorkspaceIdentity(root, protectedRoots)
    return captureWorkspaceIdentity(candidate, protectedRoots)
  }
  throw new Error('Could not find an available project folder name for this build.')
}
