import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const MAX_PACK_FILES = 5_000
const MAX_PACK_ENTRIES = 10_000
const MAX_PACK_FILE_BYTES = 1024 * 1024 * 1024
const MAX_PACK_TOTAL_BYTES = 2 * 1024 * 1024 * 1024

interface PathIdentity {
  path: string
  dev: number
  ino: number
  kind: 'directory' | 'file'
}

function identityOf(target: string, kind: PathIdentity['kind'], label: string): PathIdentity {
  const stat = fs.lstatSync(target)
  if (stat.isSymbolicLink() || (kind === 'directory' ? !stat.isDirectory() : !stat.isFile())) {
    throw new Error(`${label} ${kind} changed type or became a symlink: ${target}`)
  }
  if (kind === 'file' && stat.nlink !== 1) throw new Error(`${label} entry is not an owned regular file: ${target}`)
  return { path: target, dev: stat.dev, ino: stat.ino, kind }
}

function assertIdentity(identity: PathIdentity, label: string): void {
  const current = identityOf(identity.path, identity.kind, label)
  if (current.dev !== identity.dev || current.ino !== identity.ino) {
    throw new Error(`${label} ${identity.kind} changed identity during traversal: ${identity.path}`)
  }
}

function ownedRoot(workspaceDir: string, relativeDir: string, label: string, allowMissing = false): { workspace: string; root: string | null; ancestors: PathIdentity[] } {
  if (!relativeDir || relativeDir.includes('\\') || path.posix.isAbsolute(relativeDir)) {
    throw new Error(`${label} path is invalid.`)
  }
  const segments = relativeDir.split('/')
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) throw new Error(`${label} path is invalid.`)
  const workspace = fs.realpathSync(workspaceDir)
  const ancestors = [identityOf(workspace, 'directory', label)]
  let current = workspace
  for (const segment of segments) {
    current = path.join(current, segment)
    let stat: fs.Stats
    try {
      stat = fs.lstatSync(current)
    } catch (error) {
      if (allowMissing && (error as NodeJS.ErrnoException).code === 'ENOENT') return { workspace, root: null, ancestors }
      throw error
    }
    if (stat.isSymbolicLink()) throw new Error(`${label} path contains a symlink: ${segment}`)
    if (!stat.isDirectory()) throw new Error(`${label} path component is not a directory: ${segment}`)
    ancestors.push({ path: current, dev: stat.dev, ino: stat.ino, kind: 'directory' })
  }
  const root = fs.realpathSync(current)
  const relativeRoot = path.relative(workspace, root)
  if (!relativeRoot || relativeRoot.startsWith('..') || path.isAbsolute(relativeRoot)) throw new Error(`${label} escapes the workspace.`)
  return { workspace, root, ancestors }
}

function collectFiles(root: string, label: string, ancestors: PathIdentity[]): PathIdentity[] {
  const files: PathIdentity[] = []
  const rootIdentity = ancestors.at(-1)!
  const pending = [rootIdentity]
  const directories = [...ancestors]
  let entriesSeen = 0
  while (pending.length > 0) {
    const directory = pending.pop()!
    assertIdentity(directory, label)
    const entries: fs.Dirent[] = []
    const handle = fs.opendirSync(directory.path)
    try {
      // Bind the newly opened handle to the pathname identity captured before
      // open. A rename/replacement on either side of opendir is rejected.
      assertIdentity(directory, label)
      while (true) {
        const entry = handle.readSync()
        if (!entry) break
        entriesSeen += 1
        if (entriesSeen > MAX_PACK_ENTRIES) throw new Error(`${label} exceeds ${MAX_PACK_ENTRIES} entries.`)
        entries.push(entry)
      }
    } finally {
      handle.closeSync()
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const entry of entries) {
      const absolute = path.join(directory.path, entry.name)
      const stat = fs.lstatSync(absolute)
      if (stat.isSymbolicLink()) throw new Error(`${label} contains a symlink: ${path.relative(root, absolute)}`)
      if (stat.isDirectory()) {
        const identity: PathIdentity = { path: absolute, dev: stat.dev, ino: stat.ino, kind: 'directory' }
        pending.push(identity)
        directories.push(identity)
      } else if (stat.isFile()) {
        if (stat.nlink !== 1) throw new Error(`${label} entry is not an owned regular file: ${absolute}`)
        files.push({ path: absolute, dev: stat.dev, ino: stat.ino, kind: 'file' })
      } else throw new Error(`${label} contains an unsupported entry: ${path.relative(root, absolute)}`)
      if (files.length > MAX_PACK_FILES) throw new Error(`${label} exceeds ${MAX_PACK_FILES} files.`)
    }
  }
  for (const directory of directories) assertIdentity(directory, label)
  return files.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
}

function hashFile(hash: crypto.Hash, file: PathIdentity, remainingBytes: number, label: string): number {
  let descriptor: number | null = null
  try {
    assertIdentity(file, label)
    descriptor = fs.openSync(file.path, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0))
    const stat = fs.fstatSync(descriptor)
    if (!stat.isFile() || stat.nlink !== 1 || stat.dev !== file.dev || stat.ino !== file.ino) {
      throw new Error(`${label} entry changed identity before open: ${file.path}`)
    }
    if (stat.size > MAX_PACK_FILE_BYTES) throw new Error(`${label} file exceeds 1 GiB: ${file.path}`)
    if (stat.size > remainingBytes) throw new Error(`${label} exceeds the 2 GiB aggregate safety limit.`)
    const buffer = Buffer.allocUnsafe(1024 * 1024)
    let offset = 0
    while (offset < stat.size) {
      const read = fs.readSync(descriptor, buffer, 0, Math.min(buffer.length, stat.size - offset), offset)
      if (read === 0) throw new Error(`${label} file changed while hashing: ${file.path}`)
      hash.update(buffer.subarray(0, read))
      offset += read
    }
    assertIdentity(file, label)
    return stat.size
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor)
  }
}

function fingerprintRoot(root: string, label: string, ancestors: PathIdentity[]): string {
  const files = collectFiles(root, label, ancestors)
  const hash = crypto.createHash('sha256')
  hash.update('present\0')
  let totalBytes = 0
  for (const file of files) {
    hash.update(path.relative(root, file.path).split(path.sep).join('/'))
    hash.update('\0')
    totalBytes += hashFile(hash, file, MAX_PACK_TOTAL_BYTES - totalBytes, label)
    hash.update('\0')
  }
  for (const ancestor of ancestors) assertIdentity(ancestor, label)
  return hash.digest('hex')
}

/** Hash names and bytes so every later phase can prove the frozen pack stayed frozen. */
export function referencePackFingerprint(workspaceDir: string, referenceDir: string): string {
  const { root, ancestors } = ownedRoot(workspaceDir, referenceDir, 'Reference Pack')
  if (!root) throw new Error('Reference Pack is missing.')
  return fingerprintRoot(root, 'Reference Pack', ancestors)
}

/** Snapshot a phase-owned tree, including a stable state for a missing tree. */
export function phaseTreeFingerprint(workspaceDir: string, relativeDir: string): string {
  const { root, ancestors } = ownedRoot(workspaceDir, relativeDir, 'Phase tree', true)
  if (root) return fingerprintRoot(root, 'Phase tree', ancestors)
  return crypto.createHash('sha256').update(`missing\0${relativeDir}`).digest('hex')
}
