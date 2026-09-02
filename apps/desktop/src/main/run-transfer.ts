import fs from 'node:fs'
import path from 'node:path'

export const RUN_METADATA_DIR = '.gauntlet-loop'
export const RUN_LEDGER_FILE = 'ledger.db'

export function runLedgerPath(workspaceDir: string): string {
  return path.join(workspaceDir, RUN_METADATA_DIR, RUN_LEDGER_FILE)
}

export function safeExportFolderName(projectName: string): string {
  const safe = projectName.trim().replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '') || 'run'
  return `${safe}-gauntlet-run`
}

export function nextAvailableExportPath(parentDir: string, folderName: string): string {
  const first = path.join(parentDir, folderName)
  if (!fs.existsSync(first)) return first
  for (let index = 2; index < 10_000; index += 1) {
    const candidate = path.join(parentDir, `${folderName}-${index}`)
    if (!fs.existsSync(candidate)) return candidate
  }
  throw new Error('Could not find an available export folder name.')
}

function resolveThroughExistingAncestor(targetPath: string): string {
  let ancestor = path.resolve(targetPath)
  const missing: string[] = []
  while (!fs.existsSync(ancestor)) {
    const parent = path.dirname(ancestor)
    if (parent === ancestor) break
    missing.unshift(path.basename(ancestor))
    ancestor = parent
  }
  return path.join(fs.realpathSync(ancestor), ...missing)
}

export function assertExportDestination(sourceDir: string, destinationDir: string): void {
  const source = fs.realpathSync(sourceDir)
  const destination = resolveThroughExistingAncestor(destinationDir)
  const relative = path.relative(source, destination)
  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
    throw new Error('Choose an export destination outside the project folder.')
  }
}

/** Copy the project as a byte-for-byte folder export, preserving symlinks and timestamps. */
export async function copyRunFolder(sourceDir: string, destinationDir: string): Promise<void> {
  assertExportDestination(sourceDir, destinationDir)
  try {
    await fs.promises.mkdir(path.dirname(destinationDir), { recursive: true })
    await fs.promises.cp(sourceDir, destinationDir, {
      recursive: true,
      preserveTimestamps: true,
      verbatimSymlinks: true,
      errorOnExist: true,
      force: false,
    })
  } catch (error) {
    // Only remove the destination we selected and created for this attempt.
    await fs.promises.rm(destinationDir, { recursive: true, force: true })
    throw error
  }
}

export function assertRunFolder(workspaceDir: string): string {
  const ledgerPath = runLedgerPath(workspaceDir)
  if (!fs.existsSync(ledgerPath) || !fs.statSync(ledgerPath).isFile()) {
    throw new Error(`No ${RUN_METADATA_DIR}/${RUN_LEDGER_FILE} was found in that folder.`)
  }
  return ledgerPath
}

/**
 * Refuse to delete anything that is not plainly a run folder. The proof is the
 * folder's own `.gauntlet-loop/ledger.db`: without it we would be pointing
 * `rm -rf` at a directory this app never created.
 */
export function assertDeletableRunFolder(workspaceDir: string, homeDir: string): void {
  const target = path.resolve(workspaceDir)
  if (!path.isAbsolute(target)) throw new Error('That project path is not absolute.')
  if (target === path.parse(target).root) throw new Error('That project path is a filesystem root.')
  const home = path.resolve(homeDir)
  if (target === home) throw new Error('That project path is your home folder.')
  const fromHome = path.relative(target, home)
  if (fromHome === '' || (!fromHome.startsWith('..') && !path.isAbsolute(fromHome))) {
    throw new Error('That project path contains your home folder.')
  }
  if (!fs.existsSync(runLedgerPath(target))) {
    throw new Error(`No ${RUN_METADATA_DIR}/${RUN_LEDGER_FILE} in that folder, so it may not be a run folder.`)
  }
}

/** Remove a run's project folder from disk. Guarded, and not undoable. */
export async function deleteRunFolder(workspaceDir: string, homeDir: string): Promise<void> {
  assertDeletableRunFolder(workspaceDir, homeDir)
  await fs.promises.rm(path.resolve(workspaceDir), { recursive: true, force: true })
}
