import fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { isRecordId } from '../shared/record-id'
import { assertChildStreamBoundary, childStreamInventory, recoverChildStreams } from './child-agents'
import { MAX_CHILD_ACCOUNTING_FILE_BYTES, parseChildStreamName } from './child-stream-name'
import { readExactFileDescriptor } from './bounded-fd'
import type { WorkspaceRootIdentity } from './workspace-boundary'

/** Move completed child streams under their owning run instead of deleting evidence. */
export function archiveChildStreams(
  workspaceDir: string,
  ownerRunId: string,
  expectedWorkspace?: WorkspaceRootIdentity,
): number {
  if (!isRecordId(ownerRunId)) throw new Error('Invalid owner run id for child stream archive.')
  let boundary: ReturnType<typeof recoverChildStreams>
  try {
    boundary = recoverChildStreams(workspaceDir, expectedWorkspace)
  } catch (error) {
    // A never-used workspace has no live evidence to archive. Recovery still
    // performs the safe component walk first, so planted metadata symlinks and
    // non-directories remain terminal rather than being mistaken for absence.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0
    throw error
  }
  const root = assertChildStreamBoundary(boundary)
  const inventory = childStreamInventory(root)
  if (inventory.overflow) throw new Error('Delegated stream archive exceeds its bounded inventory; refusing to leave live streams for the next run.')
  const streams = inventory.files
  if (!streams.length) return 0
  const destination = path.join(root, ownerRunId)
  try {
    fs.mkdirSync(destination, { mode: 0o700 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  const destinationStat = fs.lstatSync(destination)
  if (!destinationStat.isDirectory() || destinationStat.isSymbolicLink() || fs.realpathSync(destination) !== destination) {
    throw new Error('Child stream archive destination must be a real directory inside the workspace.')
  }
  const assertDestination = (): void => {
    assertChildStreamBoundary(boundary)
    const current = fs.lstatSync(destination)
    if (
      !current.isDirectory()
      || current.isSymbolicLink()
      || current.dev !== destinationStat.dev
      || current.ino !== destinationStat.ino
      || fs.realpathSync(destination) !== destination
    ) throw new Error('Child stream archive destination changed identity during publication.')
  }
  for (const name of streams.sort()) {
    assertDestination()
    const source = path.join(root, name)
    const sourceStat = fs.lstatSync(source)
    if (!sourceStat.isFile() || sourceStat.isSymbolicLink() || sourceStat.nlink !== 1) {
      throw new Error(`Child stream ${name} must be an unlinked regular file before archiving.`)
    }
    // Publish a distinct archive inode through an O_EXCL target. The original
    // entry is then moved (never unlinked) to a second unpredictable retained
    // path, so a source-path replacement is preserved instead of deleted.
    const nonce = randomUUID()
    const target = path.join(destination, `${name}.${nonce}.archived`)
    const retained = path.join(destination, `${name}.${randomUUID()}.retained`)
    let sourceFd: number | null = null
    let targetFd: number | null = null
    try {
      sourceFd = fs.openSync(source, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0))
      const opened = fs.fstatSync(sourceFd)
      if (
        !opened.isFile()
        || opened.nlink !== 1
        || opened.dev !== sourceStat.dev
        || opened.ino !== sourceStat.ino
        || opened.size !== sourceStat.size
      ) throw new Error(`Child stream ${name} changed before its archive copy was opened.`)
      targetFd = fs.openSync(
        target,
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0),
        0o600,
      )
      const bytes = readExactFileDescriptor(sourceFd, opened.size, MAX_CHILD_ACCOUNTING_FILE_BYTES, `Child stream ${name}`)
      let written = 0
      while (written < bytes.length) written += fs.writeSync(targetFd, bytes, written, bytes.length - written)
      fs.fsyncSync(targetFd)
      const after = fs.fstatSync(sourceFd)
      if (
        after.dev !== opened.dev
        || after.ino !== opened.ino
        || after.nlink !== 1
        || after.size !== opened.size
      ) throw new Error(`Child stream ${name} changed while its archive copy was written.`)
    } finally {
      if (targetFd !== null) fs.closeSync(targetFd)
      if (sourceFd !== null) fs.closeSync(sourceFd)
    }
    const archived = fs.lstatSync(target)
    if (
      !archived.isFile()
      || archived.isSymbolicLink()
      || archived.nlink !== 1
      || archived.size !== sourceStat.size
    ) {
      throw new Error(`Child stream ${name} archive copy is not a unique regular file.`)
    }
    // Do not pre-check this secret random target: publishing it in a separate
    // lstat would create a race window. The source move is non-destructive; an
    // identity mismatch below leaves both the copy and moved replacement.
    fs.renameSync(source, retained)
    const moved = fs.lstatSync(retained)
    if (
      !moved.isFile()
      || moved.isSymbolicLink()
      || moved.nlink !== 1
      || moved.dev !== sourceStat.dev
      || moved.ino !== sourceStat.ino
    ) throw new Error(`Child stream ${name} changed while its source entry was retained.`)
    assertDestination()
  }
  const remaining = childStreamInventory(root)
  if (remaining.overflow || remaining.files.length > 0) {
    throw new Error('Delegated stream archive did not drain every valid live stream; refusing to start the next run.')
  }
  return streams.length
}
