import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { safeWorkspaceMetadataDir } from './workspace-metadata'

export const BUILD_METADATA_DIR = '.gauntlet-gamesmith'
/** What this folder was called while the app was named Gauntlet Loop. */
export const LEGACY_BUILD_METADATA_DIR = '.gauntlet-loop'
export const LEGACY_METADATA_ARCHIVE_DIR = 'legacy-gauntlet-loop'
export const BUILD_LEDGER_FILE = 'ledger.db'
export const MAX_IMPORTED_LEDGER_BYTES = 64 * 1024 * 1024
export const RAW_EXPORT_WARNING = 'This export includes complete, unsanitized raw CLI streams. If an agent echoed a secret, the raw files contain it; review them before sharing.'
const SQLITE_SIDECARS = ['-journal', '-wal', '-shm'] as const

export interface BuildLedgerSnapshot {
  ledgerPath: string
  sourceIdentities: readonly BuildLedgerSourceIdentity[]
  cleanup(): void
}

export interface BuildLedgerSourceIdentity {
  suffix: '' | (typeof SQLITE_SIDECARS)[number]
  identity: { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint; nlink: bigint } | null
}

/**
 * Rename a pre-rename build folder's metadata directory to the current name.
 *
 * Doing it once, on sight, is what lets the rest of the app use a single
 * constant instead of checking two names at every call site. When a current
 * directory already exists, retain the legacy tree beneath it before removing
 * the old top-level name so raw evidence is not silently discarded.
 */
export function migrateBuildMetadataDir(workspaceDir: string): void {
  const workspace = fs.realpathSync(workspaceDir)
  const current = path.join(workspace, BUILD_METADATA_DIR)
  const legacy = path.join(workspace, LEGACY_BUILD_METADATA_DIR)
  if (!fs.existsSync(legacy)) return
  try {
    const legacyStat = fs.lstatSync(legacy)
    if (!legacyStat.isDirectory() || legacyStat.isSymbolicLink() || fs.realpathSync(legacy) !== legacy) return
    if (!fs.existsSync(current)) {
      fs.renameSync(legacy, current)
      return
    }
    const currentStat = fs.lstatSync(current)
    if (!currentStat.isDirectory() || currentStat.isSymbolicLink() || fs.realpathSync(current) !== current) return
    for (let suffix = 1; suffix <= 100; suffix += 1) {
      const name = suffix === 1 ? LEGACY_METADATA_ARCHIVE_DIR : `${LEGACY_METADATA_ARCHIVE_DIR}-${suffix}`
      const archive = path.join(current, name)
      if (fs.existsSync(archive)) continue
      fs.renameSync(legacy, archive)
      return
    }
  } catch {
    // Losing the rename is survivable; losing the folder is not.
  }
}

/**
 * Where this folder's mirrored ledger is. Falls back to the pre-rename
 * directory so a folder that never got migrated — one copied in from another
 * machine, say — is still recognised as a build rather than treated as a
 * stranger. A folder with neither gets the current name, ready to create.
 */
export function buildLedgerPath(workspaceDir: string): string {
  const current = path.join(workspaceDir, BUILD_METADATA_DIR, BUILD_LEDGER_FILE)
  if (fs.existsSync(current)) return current
  const legacy = path.join(workspaceDir, LEGACY_BUILD_METADATA_DIR, BUILD_LEDGER_FILE)
  return fs.existsSync(legacy) ? legacy : current
}

export function safeExportFolderName(projectName: string): string {
  const safe = projectName.trim().replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '') || 'build'
  return `${safe}-gauntlet-run`
}

export function exportActivityError(buildRunning: boolean, playRunning: boolean): string | null {
  if (buildRunning) return 'Stop the build before exporting so the folder and SQLite history are an exact snapshot.'
  if (playRunning) return 'Stop the running game before exporting so the project and SQLite history are an exact snapshot.'
  return null
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

/** Canonicalize a possibly-not-yet-created path through its nearest real ancestor. */
export function canonicalizePath(targetPath: string): string {
  if (!path.isAbsolute(targetPath)) throw new Error('Path must be absolute.')
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

export function assertExportDestination(sourceDir: string, destinationDir: string): string {
  const source = fs.realpathSync(sourceDir)
  const destination = canonicalizePath(destinationDir)
  const relative = path.relative(source, destination)
  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
    throw new Error('Choose an export destination outside the project folder.')
  }
  return destination
}

interface DirectoryIdentity {
  dev: number
  ino: number
}

function assertExactDirectory(candidate: string, expected: DirectoryIdentity, label: string): void {
  const stat = fs.lstatSync(candidate)
  if (
    !stat.isDirectory()
    || stat.isSymbolicLink()
    || stat.dev !== expected.dev
    || stat.ino !== expected.ino
    || fs.realpathSync(candidate) !== candidate
  ) throw new Error(`${label} changed identity while the export was being copied.`)
}

/** Copy the project as a byte-for-byte folder export, preserving symlinks and timestamps. */
export async function copyBuildFolder(
  sourceDir: string,
  destinationDir: string,
  expectedSource?: DirectoryIdentity | null,
): Promise<void> {
  const source = fs.realpathSync(sourceDir)
  const sourceStat = fs.lstatSync(source)
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) throw new Error('Export source must be a real directory.')
  const sourceIdentity = { dev: sourceStat.dev, ino: sourceStat.ino }
  if (expectedSource && (expectedSource.dev !== sourceIdentity.dev || expectedSource.ino !== sourceIdentity.ino)) {
    throw new Error('Export source no longer matches the canonical workspace identity.')
  }
  const destination = assertExportDestination(source, destinationDir)
  let destinationClaimed = false
  try {
    await fs.promises.mkdir(path.dirname(destination), { recursive: true })
    // Claim this exact path atomically. If another process wins the race, do
    // not copy into its folder.
    await fs.promises.mkdir(destination)
    destinationClaimed = true
    const claimed = await fs.promises.lstat(destination)
    if (!claimed.isDirectory() || claimed.isSymbolicLink()) throw new Error('The claimed export destination is not a real directory.')
    const destinationIdentity = { dev: claimed.dev, ino: claimed.ino }
    const entries = await fs.promises.readdir(source)
    for (const entry of entries.sort()) {
      assertExactDirectory(source, sourceIdentity, 'Export source')
      assertExactDirectory(destination, destinationIdentity, 'Export destination')
      await fs.promises.cp(path.join(source, entry), path.join(destination, entry), {
        recursive: true,
        preserveTimestamps: true,
        verbatimSymlinks: true,
        errorOnExist: true,
        force: false,
      })
      assertExactDirectory(source, sourceIdentity, 'Export source')
      assertExactDirectory(destination, destinationIdentity, 'Export destination')
    }
    assertExactDirectory(source, sourceIdentity, 'Export source')
    assertExactDirectory(destination, destinationIdentity, 'Export destination')
  } catch (error) {
    // Node has no inode-conditional recursive remove primitive. Any
    // lstat-then-rm rollback would allow a replacement to land between those
    // operations and delete operator data. Leave the uniquely claimed partial
    // export for explicit inspection/removal instead.
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(
      destinationClaimed
        ? `Export copy failed; partial output was left at ${destination}: ${detail}`
        : `Export copy failed before the destination was claimed: ${detail}`,
      { cause: error },
    )
  }
}

export function assertBuildFolder(workspaceDir: string): string {
  const workspace = canonicalizePath(workspaceDir)
  const ledgerPath = buildLedgerPath(workspace)
  const metadataDir = path.dirname(ledgerPath)
  let metadataStat: fs.Stats
  try {
    metadataStat = fs.lstatSync(metadataDir)
  } catch {
    throw new Error(`No ${BUILD_METADATA_DIR}/${BUILD_LEDGER_FILE} or legacy ${LEGACY_BUILD_METADATA_DIR}/${BUILD_LEDGER_FILE} was found in that folder.`)
  }
  if (
    !metadataStat.isDirectory()
    || metadataStat.isSymbolicLink()
    || fs.realpathSync(metadataDir) !== metadataDir
    || path.dirname(metadataDir) !== workspace
    || ![BUILD_METADATA_DIR, LEGACY_BUILD_METADATA_DIR].includes(path.basename(metadataDir))
  ) {
    throw new Error('The build metadata directory must be a real app-owned directory inside the selected project.')
  }
  let stat: fs.Stats
  try {
    stat = fs.lstatSync(ledgerPath)
  } catch {
    throw new Error(`No ${path.basename(metadataDir)}/${BUILD_LEDGER_FILE} was found in that folder.`)
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    throw new Error('The folder ledger must be a regular file, not a symlink or hard link.')
  }
  const realLedger = fs.realpathSync(ledgerPath)
  const relative = path.relative(workspace, realLedger)
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('The folder ledger resolves outside the selected project.')
  let totalBytes = stat.size
  for (const suffix of SQLITE_SIDECARS) {
    const sidecar = `${ledgerPath}${suffix}`
    let sidecarStat: fs.Stats
    try {
      sidecarStat = fs.lstatSync(sidecar)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw new Error(`Could not validate the folder ledger${suffix} sidecar.`)
    }
    if (!sidecarStat.isFile() || sidecarStat.isSymbolicLink() || sidecarStat.nlink !== 1) {
      throw new Error(`The folder ledger${suffix} sidecar must be a regular file with exactly one link, not a symlink or device.`)
    }
    totalBytes += sidecarStat.size
    if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_IMPORTED_LEDGER_BYTES) {
      throw new Error('The folder ledger and SQLite sidecars exceed the import safety limit.')
    }
  }
  if (totalBytes > MAX_IMPORTED_LEDGER_BYTES) {
    throw new Error('The folder ledger and SQLite sidecars exceed the import safety limit.')
  }
  return realLedger
}

function copySnapshotFile(sourcePath: string, targetPath: string): void {
  let sourceFd: number | null = null
  let targetFd: number | null = null
  try {
    sourceFd = fs.openSync(sourcePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
    const source = fs.fstatSync(sourceFd)
    if (!source.isFile() || source.nlink !== 1 || source.size > MAX_IMPORTED_LEDGER_BYTES) {
      throw new Error('The retained import snapshot is not a safe regular file.')
    }
    try {
      targetFd = fs.openSync(
        targetPath,
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
        0o600,
      )
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || !snapshotMatchesTarget(sourceFd, source, targetPath)) throw error
      return
    }
    const chunk = Buffer.allocUnsafe(1024 * 1024)
    let copied = 0
    while (true) {
      const read = fs.readSync(sourceFd, chunk, 0, chunk.length, null)
      if (read === 0) break
      copied += read
      let written = 0
      while (written < read) written += fs.writeSync(targetFd, chunk, written, read - written)
    }
    if (copied !== source.size) throw new Error('The retained import snapshot changed during rollback.')
    fs.fsyncSync(targetFd)
  } finally {
    if (targetFd !== null) fs.closeSync(targetFd)
    if (sourceFd !== null) fs.closeSync(sourceFd)
  }
}

function snapshotMatchesTarget(sourceFd: number, source: fs.Stats, targetPath: string): boolean {
  let targetFd: number | null = null
  try {
    targetFd = fs.openSync(targetPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
    const before = fs.fstatSync(targetFd)
    if (!before.isFile() || before.nlink !== 1 || before.size !== source.size) return false
    const sourceChunk = Buffer.allocUnsafe(1024 * 1024)
    const targetChunk = Buffer.allocUnsafe(1024 * 1024)
    let offset = 0
    while (offset < source.size) {
      const length = Math.min(sourceChunk.length, source.size - offset)
      const sourceRead = fs.readSync(sourceFd, sourceChunk, 0, length, offset)
      const targetRead = fs.readSync(targetFd, targetChunk, 0, length, offset)
      if (sourceRead !== targetRead || sourceRead === 0 || !sourceChunk.subarray(0, sourceRead).equals(targetChunk.subarray(0, targetRead))) return false
      offset += sourceRead
    }
    const after = fs.fstatSync(targetFd)
    const linked = fs.lstatSync(targetPath)
    return after.dev === before.dev && after.ino === before.ino && after.size === before.size && after.nlink === 1
      && linked.dev === before.dev && linked.ino === before.ino && linked.nlink === 1
  } catch {
    return false
  } finally {
    if (targetFd !== null) fs.closeSync(targetFd)
  }
}

/** Restore the selected portable ledger exactly after a failed import publish. */
export function restoreBuildLedgerSnapshot(snapshot: BuildLedgerSnapshot, workspaceDir: string): void {
  const workspace = canonicalizePath(workspaceDir)
  const metadataDir = safeWorkspaceMetadataDir(workspace, [], false)
  const targetPath = path.join(metadataDir, BUILD_LEDGER_FILE)
  // Restore only into absent names. A failure may itself have been caused by
  // a concurrent replacement, which must never be overwritten or unlinked.
  for (const suffix of SQLITE_SIDECARS) {
    const source = `${snapshot.ledgerPath}${suffix}`
    const target = `${targetPath}${suffix}`
    if (fs.existsSync(source)) copySnapshotFile(source, target)
    else if (fs.existsSync(target)) throw new Error(`A competing portable ledger${suffix} sidecar prevents safe rollback.`)
  }
  copySnapshotFile(snapshot.ledgerPath, targetPath)
}

function sameIdentity(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

function unchanged(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  return sameIdentity(left, right)
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs
    && left.nlink === right.nlink
}

function containedBy(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function copyVerifiedLedgerFile(
  sourcePath: string,
  destinationPath: string,
  workspace: string,
  copiedBytes: { value: number },
): NonNullable<BuildLedgerSourceIdentity['identity']> {
  const sourceFd = fs.openSync(sourcePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
  let destinationFd: number | null = null
  try {
    const before = fs.fstatSync(sourceFd, { bigint: true })
    const linkedBefore = fs.lstatSync(sourcePath, { bigint: true })
    const realSource = fs.realpathSync(sourcePath)
    if (!before.isFile() || before.nlink !== 1n || !sameIdentity(before, linkedBefore) || !containedBy(workspace, realSource)) {
      throw new Error('The transferred SQLite file changed identity or escaped the selected project.')
    }
    if (before.size > BigInt(MAX_IMPORTED_LEDGER_BYTES - copiedBytes.value)) {
      throw new Error('The folder ledger and SQLite sidecars exceed the import safety limit.')
    }

    destinationFd = fs.openSync(
      destinationPath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
      0o600,
    )
    const chunk = Buffer.allocUnsafe(1024 * 1024)
    let fileBytes = 0
    while (true) {
      const read = fs.readSync(sourceFd, chunk, 0, chunk.length, null)
      if (read === 0) break
      fileBytes += read
      copiedBytes.value += read
      if (copiedBytes.value > MAX_IMPORTED_LEDGER_BYTES) {
        throw new Error('The folder ledger and SQLite sidecars exceed the import safety limit.')
      }
      let written = 0
      while (written < read) written += fs.writeSync(destinationFd, chunk, written, read - written)
    }
    fs.fsyncSync(destinationFd)

    const after = fs.fstatSync(sourceFd, { bigint: true })
    const linkedAfter = fs.lstatSync(sourcePath, { bigint: true })
    const realAfter = fs.realpathSync(sourcePath)
    if (!unchanged(before, after) || !sameIdentity(after, linkedAfter) || realAfter !== realSource || fileBytes !== Number(after.size)) {
      throw new Error('The transferred SQLite file changed while it was being copied.')
    }
    return {
      dev: after.dev,
      ino: after.ino,
      size: after.size,
      mtimeNs: after.mtimeNs,
      ctimeNs: after.ctimeNs,
      nlink: after.nlink,
    }
  } finally {
    if (destinationFd != null) fs.closeSync(destinationFd)
    fs.closeSync(sourceFd)
  }
}

/**
 * Copy an untrusted portable database through verified file descriptors before
 * SQLite sees it. SQLite only accepts paths, so opening the workspace file
 * directly would leave a validation-to-open symlink/replacement race.
 */
export function snapshotBuildLedger(workspaceDir: string): BuildLedgerSnapshot {
  const workspace = canonicalizePath(workspaceDir)
  const ledgerPath = assertBuildFolder(workspace)
  const snapshotDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gauntlet-ledger-import-'))
  fs.chmodSync(snapshotDir, 0o700)
  const snapshotPath = path.join(snapshotDir, BUILD_LEDGER_FILE)
  const copiedBytes = { value: 0 }
  const sourceIdentities: BuildLedgerSourceIdentity[] = []
  try {
    sourceIdentities.push({ suffix: '', identity: copyVerifiedLedgerFile(ledgerPath, snapshotPath, workspace, copiedBytes) })
    for (const suffix of SQLITE_SIDECARS) {
      const source = `${ledgerPath}${suffix}`
      try {
        fs.lstatSync(source)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          sourceIdentities.push({ suffix, identity: null })
          continue
        }
        throw error
      }
      sourceIdentities.push({ suffix, identity: copyVerifiedLedgerFile(source, `${snapshotPath}${suffix}`, workspace, copiedBytes) })
    }
    return {
      ledgerPath: snapshotPath,
      sourceIdentities,
      cleanup: () => fs.rmSync(snapshotDir, { recursive: true, force: true }),
    }
  } catch (error) {
    fs.rmSync(snapshotDir, { recursive: true, force: true })
    throw error
  }
}

/**
 * Refuse to delete anything that is not plainly a build folder. The proof is the
 * folder's own mirrored `ledger.db`: without it we would be pointing
 * `rm -rf` at a directory this app never created.
 */
export function assertDeletableBuildFolder(workspaceDir: string, homeDir: string): void {
  const target = path.resolve(workspaceDir)
  if (!path.isAbsolute(target)) throw new Error('That project path is not absolute.')
  if (target === path.parse(target).root) throw new Error('That project path is a filesystem root.')
  const home = path.resolve(homeDir)
  if (target === home) throw new Error('That project path is your home folder.')
  const fromHome = path.relative(target, home)
  if (fromHome === '' || (!fromHome.startsWith('..') && !path.isAbsolute(fromHome))) {
    throw new Error('That project path contains your home folder.')
  }
  if (!fs.existsSync(buildLedgerPath(target))) {
    throw new Error(`No ${BUILD_METADATA_DIR}/${BUILD_LEDGER_FILE} in that folder, so it may not be a build folder.`)
  }
}

/** Remove a build's project folder from disk. Guarded, and not undoable. */
export async function deleteBuildFolder(workspaceDir: string, homeDir: string): Promise<void> {
  assertDeletableBuildFolder(workspaceDir, homeDir)
  await fs.promises.rm(path.resolve(workspaceDir), { recursive: true, force: true })
}
