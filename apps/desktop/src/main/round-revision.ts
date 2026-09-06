import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { isRecordId } from '../shared/record-id'
import { LEGACY_BUILD_METADATA_DIR, BUILD_METADATA_DIR } from './build-transfer'

const REPOSITORY_DIR = 'repository.git'
const PLAY_DIR = 'play'
const REVISION_PATTERN = /^[0-9a-f]{40,64}$/
const GIT_CONFIG_OVERRIDES = ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null']
const GIT_BINARY = '/usr/bin/git'
const GIT_TIMEOUT_MS = 2 * 60_000
const GIT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024
const MAX_REPOSITORY_ENTRIES = 200_000
const MAX_RETAINED_CHECKOUTS = 16
const MAX_RETAINED_CHECKOUT_ENTRIES = 100_000
const MAX_RETAINED_CHECKOUT_BYTES = 1024 * 1024 * 1024
const CHECKOUT_NAME = /^round-[1-9]\d*-[0-9a-f]{12}-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const EXCLUDED_PATHS = [
  `:(exclude)${BUILD_METADATA_DIR}`,
  `:(exclude)${BUILD_METADATA_DIR}/**`,
  // A folder that predates the rename, in case its migration did not run.
  `:(exclude)${LEGACY_BUILD_METADATA_DIR}`,
  `:(exclude)${LEGACY_BUILD_METADATA_DIR}/**`,
  ':(exclude)gauntlet-report-v1.md',
  ':(exclude,glob)**/node_modules/**',
  ':(exclude)node_modules',
  ':(exclude)critique',
  ':(exclude)critique/**',
  ':(exclude)reference',
  ':(exclude)reference/**',
  ':(exclude,glob)**/coverage/**',
  ':(exclude,glob)**/playwright-report/**',
  ':(exclude,glob)**/test-results/**',
]
const liveCheckoutIdentities = new Map<string, { dev: number; ino: number }>()
let revisionStorageRoot: string | null = null

interface CaptureRoundRevisionInput {
  workspaceDir: string
  buildId: string
  round: number
  /** The prior round revision, or a source round revision when forking a future attempt. */
  parentRevision?: string | null
}

/** Configure the app-private authority used for immutable source revisions. */
export function configureRoundRevisionStorage(root: string): void {
  if (!path.isAbsolute(root)) throw new Error('Round revision storage root must be absolute.')
  const parent = fs.realpathSync(path.dirname(root))
  const candidate = path.join(parent, path.basename(root))
  try {
    fs.mkdirSync(candidate, { mode: 0o700 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  const stat = fs.lstatSync(candidate)
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(candidate) !== candidate) {
    throw new Error('Round revision storage root must be a real app-private directory.')
  }
  fs.chmodSync(candidate, 0o700)
  revisionStorageRoot = candidate
}

export function roundRevisionRepositoryPath(buildId: string): string {
  if (!isRecordId(buildId)) throw new Error('Invalid build id for round revision.')
  if (!revisionStorageRoot) throw new Error('Round revision storage has not been configured.')
  return ownedDirectory(revisionStorageRoot, [buildId, REPOSITORY_DIR], false)
}

function repositoryDir(buildId: string): string {
  return roundRevisionRepositoryPath(buildId)
}

function contained(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

/** Walk every owned directory component without following a planted symlink. */
function ownedDirectory(workspaceDir: string, segments: string[], create: boolean): string {
  const workspace = fs.realpathSync(workspaceDir)
  let current = workspace
  for (const segment of segments) {
    current = path.join(current, segment)
    let stat: fs.Stats
    try {
      stat = fs.lstatSync(current)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !create) throw error
      fs.mkdirSync(current, { mode: 0o700 })
      stat = fs.lstatSync(current)
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Owned build directory is not a real directory: ${segment}`)
    const canonical = fs.realpathSync(current)
    if (!contained(workspace, canonical)) throw new Error(`Owned build directory escapes the workspace: ${segment}`)
    current = canonical
  }
  return current
}

/**
 * `git add` exits 1 when a pathspec names a directory the workspace's own
 * .gitignore already ignores, even though it stages everything else correctly.
 * Our excluded pathspecs routinely collide with a project .gitignore, so that
 * warning must not fail the round.
 */
const IGNORED_PATHS_WARNING = /paths are ignored by one of your \.gitignore files/

function safeGitEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const inherited = Object.fromEntries(
    ['SystemRoot', 'COMSPEC', 'PATHEXT', 'TMPDIR', 'TMP', 'TEMP']
      .map((key) => [key, process.env[key]])
      .filter((entry): entry is [string, string] => entry[1] !== undefined),
  )
  return {
    ...inherited,
    ...overrides,
    PATH: '/usr/bin:/bin',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    LC_ALL: 'C',
  }
}

function attempt(command: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv, tolerate?: RegExp): string {
  const result = spawnSync(command, args, {
    cwd,
    env: safeGitEnv(env),
    encoding: 'utf8',
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: GIT_MAX_OUTPUT_BYTES,
  })
  const output = (result.error?.message || result.stderr || result.stdout || `${command} exited ${result.status}`).trim()
  if (result.status !== 0 && !tolerate?.test(output)) throw new Error(output)
  return result.stdout.trim()
}

/** Remove every executable local Git option before operating on app-owned history. */
function sanitizeRepositoryConfig(repo: string): void {
  const configPath = path.join(repo, 'config')
  let descriptor: number | null = null
  try {
    descriptor = fs.openSync(configPath, fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW ?? 0))
    const stat = fs.fstatSync(descriptor)
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 1024 * 1024) throw new Error('Round revision config is not an owned regular file.')
    fs.ftruncateSync(descriptor, 0)
    fs.writeFileSync(descriptor, '[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = true\n')
    fs.fsyncSync(descriptor)
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor)
  }
}

/** Reject link-based escape routes anywhere Git may read or mutate. */
function validateRepositoryLayout(repo: string): void {
  const canonicalRepo = fs.realpathSync(repo)
  const pending = [canonicalRepo]
  let entriesSeen = 0
  while (pending.length > 0) {
    const directory = pending.pop()!
    const handle = fs.opendirSync(directory)
    try {
      while (true) {
        const entry = handle.readSync()
        if (!entry) break
        entriesSeen += 1
        if (entriesSeen > MAX_REPOSITORY_ENTRIES) throw new Error(`Round revision repository exceeds ${MAX_REPOSITORY_ENTRIES} entries.`)
        const target = path.join(directory, entry.name)
        const stat = fs.lstatSync(target)
        if (stat.isSymbolicLink()) throw new Error(`Round revision repository contains a symlink: ${path.relative(canonicalRepo, target)}`)
        if (stat.isDirectory()) {
          const canonical = fs.realpathSync(target)
          if (!contained(canonicalRepo, canonical)) throw new Error('Round revision repository directory escapes its root.')
          pending.push(canonical)
        } else if (!stat.isFile() || stat.nlink !== 1) {
          throw new Error(`Round revision repository contains a non-owned file: ${path.relative(canonicalRepo, target)}`)
        }
      }
    } finally {
      handle.closeSync()
    }
  }
}

function git(workspaceDir: string, buildId: string, args: string[], indexFile?: string, tolerate?: RegExp): string {
  const repo = repositoryDir(buildId)
  validateRepositoryLayout(repo)
  sanitizeRepositoryConfig(repo)
  const output = attempt(
    GIT_BINARY,
    [...GIT_CONFIG_OVERRIDES, `--git-dir=${repo}`, `--work-tree=${workspaceDir}`, ...args],
    workspaceDir,
    {
      ...(indexFile ? { GIT_INDEX_FILE: indexFile } : {}),
      GIT_AUTHOR_NAME: 'Gauntlet Gamesmith',
      GIT_AUTHOR_EMAIL: 'rounds@gauntlet.local',
      GIT_COMMITTER_NAME: 'Gauntlet Gamesmith',
      GIT_COMMITTER_EMAIL: 'rounds@gauntlet.local',
    },
    tolerate,
  )
  validateRepositoryLayout(repo)
  return output
}

function ensureRepository(workspaceDir: string, buildId: string): void {
  if (!revisionStorageRoot) throw new Error('Round revision storage has not been configured.')
  const repo = ownedDirectory(revisionStorageRoot, [buildId, REPOSITORY_DIR], true)
  const head = path.join(repo, 'HEAD')
  try {
    const stat = fs.lstatSync(head)
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('Round revision HEAD is not a regular file.')
    return
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  attempt(GIT_BINARY, [...GIT_CONFIG_OVERRIDES, 'init', '--bare', '--quiet', repo], workspaceDir)
  const headStat = fs.lstatSync(head)
  if (headStat.isSymbolicLink() || !headStat.isFile()) throw new Error('Git did not create a safe round revision repository.')
}

function assertRevision(revision: string): void {
  if (!REVISION_PATTERN.test(revision)) throw new Error('Invalid round revision.')
}

function withTemporaryIndex<T>(work: (indexFile: string) => T): T {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gauntlet-round-revision-'))
  try {
    return work(path.join(tempDir, 'index'))
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
}

function assertCheckoutCapacity(playRoot: string): void {
  const pending: string[] = []
  const rootEntries = fs.readdirSync(playRoot)
  if (rootEntries.length >= MAX_RETAINED_CHECKOUTS) {
    throw new Error(`Saved-round Play storage reached its ${MAX_RETAINED_CHECKOUTS}-checkout limit. Remove retained directories under ${playRoot} before starting another saved round.`)
  }
  for (const name of rootEntries) {
    if (!CHECKOUT_NAME.test(name)) throw new Error(`Unexpected entry in saved-round Play storage: ${name}.`)
    const candidate = path.join(playRoot, name)
    const stat = fs.lstatSync(candidate)
    if (!stat.isDirectory() || stat.isSymbolicLink() || !contained(playRoot, fs.realpathSync(candidate))) {
      throw new Error(`Saved-round Play checkout is not a contained real directory: ${name}.`)
    }
    pending.push(candidate)
  }
  let entries = 0
  let bytes = 0
  while (pending.length > 0) {
    const directory = pending.pop()!
    const handle = fs.opendirSync(directory)
    try {
      while (true) {
        const entry = handle.readSync()
        if (!entry) break
        entries += 1
        if (entries > MAX_RETAINED_CHECKOUT_ENTRIES) {
          throw new Error(`Saved-round Play storage exceeds its ${MAX_RETAINED_CHECKOUT_ENTRIES}-entry limit. Remove retained checkouts under ${playRoot}.`)
        }
        const target = path.join(directory, entry.name)
        const stat = fs.lstatSync(target)
        if (stat.isDirectory() && !stat.isSymbolicLink()) pending.push(target)
        else {
          bytes += stat.size
          if (!Number.isSafeInteger(bytes) || bytes > MAX_RETAINED_CHECKOUT_BYTES) {
            throw new Error(`Saved-round Play storage exceeds its ${MAX_RETAINED_CHECKOUT_BYTES / 1024 / 1024} MiB limit. Remove retained checkouts under ${playRoot}.`)
          }
        }
      }
    } finally {
      handle.closeSync()
    }
  }
}

/** Commit the playable source tree without touching a user's Git repository, index, or branch. */
export function captureRoundRevision(input: CaptureRoundRevisionInput): string {
  // Round zero is the durable pre-reference source baseline. Positive rounds
  // remain the immutable implementations assigned to critics.
  if (!Number.isInteger(input.round) || input.round < 0) throw new Error('Round must be a nonnegative integer.')
  if (!isRecordId(input.buildId)) throw new Error('Invalid build id for round revision.')
  ensureRepository(input.workspaceDir, input.buildId)
  if (input.parentRevision) {
    assertRevision(input.parentRevision)
    git(input.workspaceDir, input.buildId, ['cat-file', '-e', `${input.parentRevision}^{commit}`])
  }

  const revision = withTemporaryIndex((indexFile) => {
    git(input.workspaceDir, input.buildId, input.parentRevision ? ['read-tree', input.parentRevision] : ['read-tree', '--empty'], indexFile)
    git(input.workspaceDir, input.buildId, ['add', '-A', '-f', '--', '.', ...EXCLUDED_PATHS], indexFile, IGNORED_PATHS_WARNING)
    const tree = git(input.workspaceDir, input.buildId, ['write-tree'], indexFile)
    const args = ['commit-tree', tree, '-m', `Gauntlet Gamesmith ${input.buildId} round ${input.round}`]
    if (input.parentRevision) args.push('-p', input.parentRevision)
    return git(input.workspaceDir, input.buildId, args, indexFile)
  })

  assertRevision(revision)
  git(input.workspaceDir, input.buildId, ['update-ref', `refs/builds/${input.buildId}/rounds/${input.round}`, revision])
  return revision
}

/** Compare the current playable source to the immutable tree a critic was assigned. */
export function workspaceMatchesRevision(workspaceDir: string, buildId: string, revision: string): boolean {
  assertRevision(revision)
  ensureRepository(workspaceDir, buildId)
  const expectedTree = git(workspaceDir, buildId, ['show', '-s', '--format=%T', revision])
  const actualTree = withTemporaryIndex((indexFile) => {
    git(workspaceDir, buildId, ['read-tree', revision], indexFile)
    // Files present in the immutable revision remain tracked even when they
    // live below an ignored build/dist directory, so their edits/deletions are
    // detected. Newly created project-ignored outputs are not source drift.
    git(workspaceDir, buildId, ['add', '-A', '--', '.', ...EXCLUDED_PATHS], indexFile, IGNORED_PATHS_WARNING)
    return git(workspaceDir, buildId, ['write-tree'], indexFile)
  })
  return actualTree === expectedTree
}

/** Materialize a temporary playable checkout for one immutable round revision. */
export function checkoutRoundRevision(workspaceDir: string, buildId: string, round: number, revision: string): string {
  if (!Number.isInteger(round) || round < 1) throw new Error('Round must be a positive integer.')
  assertRevision(revision)
  ensureRepository(workspaceDir, buildId)
  git(workspaceDir, buildId, ['cat-file', '-e', `${revision}^{commit}`])
  const playRoot = ownedDirectory(workspaceDir, [BUILD_METADATA_DIR, PLAY_DIR], true)
  assertCheckoutCapacity(playRoot)
  // A fresh unguessable directory makes every Play session a no-clobber
  // publication. Never reclaim a deterministic pathname whose entry may have
  // been replaced by workspace code between validation and recursive removal.
  const destination = path.join(playRoot, `round-${round}-${revision.slice(0, 12)}-${randomUUID()}`)
  fs.mkdirSync(destination, { mode: 0o700 })
  try {
    withTemporaryIndex((indexFile) => {
      git(workspaceDir, buildId, ['read-tree', revision], indexFile)
      git(workspaceDir, buildId, ['checkout-index', '--all', '--force', `--prefix=${destination}${path.sep}`], indexFile)
    })
    const stat = fs.lstatSync(destination)
    if (stat.isSymbolicLink() || !stat.isDirectory() || !contained(playRoot, fs.realpathSync(destination))) {
      throw new Error('Round checkout destination is not a contained real directory.')
    }
    liveCheckoutIdentities.set(destination, { dev: stat.dev, ino: stat.ino })
    return destination
  } catch (error) {
    // Node has no inode-conditional recursive delete. Retain the unique partial
    // checkout rather than risk deleting a replacement planted at this path.
    throw new Error(`Round checkout failed; partial files were retained at ${destination}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export function cleanupRoundCheckout(checkoutDir: string): void {
  const name = path.basename(checkoutDir)
  const playRoot = path.dirname(checkoutDir)
  const metadataRoot = path.dirname(playRoot)
  const workspaceDir = path.dirname(metadataRoot)
  if (
    path.basename(playRoot) !== PLAY_DIR
    || path.basename(metadataRoot) !== BUILD_METADATA_DIR
    || !CHECKOUT_NAME.test(name)
  ) {
    throw new Error('Refusing to clean an invalid round checkout path.')
  }
  const expectedRoot = ownedDirectory(workspaceDir, [BUILD_METADATA_DIR, PLAY_DIR], false)
  const expected = liveCheckoutIdentities.get(checkoutDir)
  if (!expected) throw new Error('Refusing to clean a round checkout not owned by this app session.')
  let stat: fs.Stats
  try {
    stat = fs.lstatSync(checkoutDir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      liveCheckoutIdentities.delete(checkoutDir)
      return
    }
    throw error
  }
  if (
    stat.isSymbolicLink()
    || !stat.isDirectory()
    || stat.dev !== expected.dev
    || stat.ino !== expected.ino
    || !contained(expectedRoot, fs.realpathSync(checkoutDir))
  ) {
    throw new Error('Refusing to clean an unowned round checkout.')
  }
  liveCheckoutIdentities.delete(checkoutDir)
  // The checkout is already quarantined beneath a unique app path. Retaining
  // it is intentional: recursive pathname deletion cannot be conditioned on
  // the inode above and could delete an operator replacement after this check.
}
