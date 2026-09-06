import fs from 'node:fs'
import path from 'node:path'
import { readExactFileDescriptor } from './bounded-fd'
import { assertBuildWorkspaceIdentity, type WorkspaceRootIdentity } from './workspace-boundary'

interface DirectoryComponentIdentity {
  path: string
  dev: number
  ino: number
}

/**
 * A captured, symlink-free directory chain rooted in an operator-selected
 * workspace. Callers must revalidate it immediately around every path-based
 * filesystem operation because Node does not expose openat(2).
 */
export interface OwnedDirectoryBoundary {
  readonly ownerRoot: string
  readonly path: string
  readonly components: readonly DirectoryComponentIdentity[]
}

function directoryIdentity(candidate: string): DirectoryComponentIdentity {
  const stat = fs.lstatSync(candidate)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Owned directory is not a real directory: ${candidate}`)
  if (fs.realpathSync(candidate) !== candidate) throw new Error(`Owned directory resolves through an unsafe component: ${candidate}`)
  return { path: candidate, dev: stat.dev, ino: stat.ino }
}

export function captureOwnedDirectory(
  ownerRoot: string,
  candidate: string,
  expectedOwner?: WorkspaceRootIdentity,
): OwnedDirectoryBoundary {
  const resolvedOwnerInput = path.resolve(ownerRoot)
  const canonicalRoot = expectedOwner
    ? assertBuildWorkspaceIdentity(expectedOwner, [])
    : fs.realpathSync(ownerRoot)
  if (expectedOwner && canonicalRoot !== resolvedOwnerInput) {
    throw new Error('Owned directory root does not match the expected workspace identity.')
  }
  const resolvedCandidate = path.resolve(candidate)
  const fromInput = path.relative(resolvedOwnerInput, resolvedCandidate)
  const relative = !fromInput.startsWith('..') && !path.isAbsolute(fromInput)
    ? fromInput
    : path.relative(canonicalRoot, resolvedCandidate)
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Owned directory escapes its workspace root.')
  const components: DirectoryComponentIdentity[] = [directoryIdentity(canonicalRoot)]
  let current = canonicalRoot
  if (relative) {
    for (const segment of relative.split(path.sep)) {
      if (!segment || segment === '.' || segment === '..') throw new Error('Owned directory contains an invalid path component.')
      current = path.join(current, segment)
      components.push(directoryIdentity(current))
    }
  }
  return { ownerRoot: canonicalRoot, path: current, components }
}

export function assertOwnedDirectoryBoundary(boundary: OwnedDirectoryBoundary): string {
  for (const expected of boundary.components) {
    const current = directoryIdentity(expected.path)
    if (current.dev !== expected.dev || current.ino !== expected.ino) {
      throw new Error(`Owned directory changed identity: ${expected.path}`)
    }
  }
  return boundary.path
}

export function boundedOwnedDirectoryEntries(
  boundary: OwnedDirectoryBoundary,
  limit: number,
): { entries: fs.Dirent[]; truncated: boolean } {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('Owned directory entry limit must be a positive safe integer.')
  assertOwnedDirectoryBoundary(boundary)
  let handle: fs.Dir | null = null
  try {
    handle = fs.opendirSync(boundary.path)
    // If a parent was swapped between validation and opendir, reject it before
    // reading even one name. The final check prevents returning a raced list.
    assertOwnedDirectoryBoundary(boundary)
    const entries: fs.Dirent[] = []
    while (true) {
      const entry = handle.readSync()
      if (!entry) break
      if (entries.length >= limit) {
        assertOwnedDirectoryBoundary(boundary)
        return { entries, truncated: true }
      }
      entries.push(entry)
    }
    assertOwnedDirectoryBoundary(boundary)
    return { entries, truncated: false }
  } finally {
    handle?.closeSync()
  }
}

function assertLeafName(name: string): void {
  if (!name || name === '.' || name === '..' || path.basename(name) !== name || name.includes('/') || name.includes('\\')) {
    throw new Error('Owned file name must be one path component.')
  }
}

function openOwnedFile(boundary: OwnedDirectoryBoundary, name: string): { descriptor: number; stat: fs.Stats; path: string } {
  assertLeafName(name)
  assertOwnedDirectoryBoundary(boundary)
  const filePath = path.join(boundary.path, name)
  const descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0))
  try {
    // The opened descriptor pins the leaf; this second chain check ensures it
    // was opened through the directory chain captured by the caller.
    assertOwnedDirectoryBoundary(boundary)
    const stat = fs.fstatSync(descriptor)
    const linked = fs.lstatSync(filePath)
    if (
      !stat.isFile()
      || stat.nlink !== 1
      || !linked.isFile()
      || linked.isSymbolicLink()
      || linked.nlink !== 1
      || linked.dev !== stat.dev
      || linked.ino !== stat.ino
    ) throw new Error('Owned file is not the unique regular file opened through the captured directory.')
    return { descriptor, stat, path: filePath }
  } catch (error) {
    fs.closeSync(descriptor)
    throw error
  }
}

export function ownedFileStat(boundary: OwnedDirectoryBoundary, name: string): fs.Stats {
  const opened = openOwnedFile(boundary, name)
  try {
    assertOwnedDirectoryBoundary(boundary)
    return opened.stat
  } finally {
    fs.closeSync(opened.descriptor)
  }
}

export function readOwnedFile(
  boundary: OwnedDirectoryBoundary,
  name: string,
  maxBytes: number,
  label = name,
): Buffer {
  const opened = openOwnedFile(boundary, name)
  try {
    if (opened.stat.size > maxBytes) throw new Error(`${label} exceeds its byte limit.`)
    const result = readExactFileDescriptor(opened.descriptor, opened.stat.size, maxBytes, label)
    const after = fs.fstatSync(opened.descriptor)
    if (
      after.dev !== opened.stat.dev
      || after.ino !== opened.stat.ino
      || after.nlink !== 1
      || after.size !== opened.stat.size
    ) throw new Error(`${label} changed while it was being read.`)
    assertOwnedDirectoryBoundary(boundary)
    const linked = fs.lstatSync(opened.path)
    if (
      !linked.isFile()
      || linked.isSymbolicLink()
      || linked.nlink !== 1
      || linked.dev !== after.dev
      || linked.ino !== after.ino
    ) throw new Error(`${label} changed identity while it was being read.`)
    return result
  } finally {
    fs.closeSync(opened.descriptor)
  }
}
