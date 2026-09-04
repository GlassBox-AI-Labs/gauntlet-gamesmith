import fs from 'node:fs'
import path from 'node:path'

export const WORKSPACE_METADATA_DIR = '.gauntlet-gamesmith'

function assertPathSegment(segment: string): void {
  if (!segment || segment === '.' || segment === '..' || path.basename(segment) !== segment) {
    throw new Error('Workspace metadata path contains an invalid segment.')
  }
}

/**
 * Resolve an app-owned directory below a real workspace without following a
 * directory symlink planted by code running in that workspace.
 */
export function safeWorkspaceMetadataDir(
  workspaceDir: string,
  segments: readonly string[] = [],
  create = false,
): string {
  const workspace = fs.realpathSync(workspaceDir)
  let current = workspace
  for (const segment of [WORKSPACE_METADATA_DIR, ...segments]) {
    assertPathSegment(segment)
    current = path.join(current, segment)
    try {
      const stat = fs.lstatSync(current)
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error(`Workspace metadata component ${segment} must be a real directory.`)
      }
    } catch (error) {
      if (!create || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      fs.mkdirSync(current, { mode: 0o700 })
    }
    if (fs.realpathSync(current) !== current) {
      throw new Error(`Workspace metadata component ${segment} resolves outside its canonical path.`)
    }
  }
  return current
}

/** Reject special files and symlinks before a native library opens a path. */
export function assertSafeWorkspaceFile(filePath: string): void {
  try {
    const stat = fs.lstatSync(filePath)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
      throw new Error(`Workspace metadata file ${path.basename(filePath)} must be an unlinked regular file.`)
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}
