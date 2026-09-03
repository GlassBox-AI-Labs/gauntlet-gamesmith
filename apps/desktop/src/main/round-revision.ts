import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { LEGACY_RUN_METADATA_DIR, RUN_METADATA_DIR } from './run-transfer'

const REPOSITORY_DIR = 'revisions.git'
const PLAY_DIR = 'play'
const REVISION_PATTERN = /^[0-9a-f]{40,64}$/
const EXCLUDED_PATHS = [
  `:(exclude)${RUN_METADATA_DIR}`,
  `:(exclude)${RUN_METADATA_DIR}/**`,
  // A folder that predates the rename, in case its migration did not run.
  `:(exclude)${LEGACY_RUN_METADATA_DIR}`,
  `:(exclude)${LEGACY_RUN_METADATA_DIR}/**`,
  ':(exclude,glob)**/node_modules/**',
  ':(exclude)node_modules',
  ':(exclude)critique',
  ':(exclude)critique/**',
  ':(exclude)reference',
  ':(exclude)reference/**',
  ':(exclude,top,glob)shots*/**',
  ':(exclude,top,glob)screenshots*/**',
  ':(exclude,glob)**/coverage/**',
  ':(exclude,glob)**/playwright-report/**',
  ':(exclude,glob)**/test-results/**',
  ':(exclude,glob)**/dist*/**',
  ':(exclude,glob)**/build/**',
  ':(exclude,glob)**/out/**',
]

interface CaptureRoundRevisionInput {
  workspaceDir: string
  loopId: string
  round: number
  /** The prior round revision, or a source round revision when forking a future run. */
  parentRevision?: string | null
}

function repositoryDir(workspaceDir: string): string {
  return path.join(workspaceDir, RUN_METADATA_DIR, REPOSITORY_DIR)
}

/**
 * `git add` exits 1 when a pathspec names a directory the workspace's own
 * .gitignore already ignores, even though it stages everything else correctly.
 * Our EXCLUDED_PATHS routinely collide with an agent-written .gitignore, so
 * that warning must not fail the round.
 */
const IGNORED_PATHS_WARNING = /paths are ignored by one of your \.gitignore files/

function run(command: string, args: string[], env?: NodeJS.ProcessEnv, tolerate?: RegExp): string {
  const result = spawnSync(command, args, { env: { ...process.env, ...env }, encoding: 'utf8' })
  const output = (result.stderr || result.stdout || `${command} exited ${result.status}`).trim()
  if (result.status !== 0 && !tolerate?.test(output)) throw new Error(output)
  return result.stdout.trim()
}

function git(workspaceDir: string, args: string[], indexFile?: string, tolerate?: RegExp): string {
  return run(
    'git',
    [`--git-dir=${repositoryDir(workspaceDir)}`, `--work-tree=${workspaceDir}`, ...args],
    {
      ...(indexFile ? { GIT_INDEX_FILE: indexFile } : {}),
      GIT_AUTHOR_NAME: 'Gauntlet Gamesmith',
      GIT_AUTHOR_EMAIL: 'rounds@gauntlet.local',
      GIT_COMMITTER_NAME: 'Gauntlet Gamesmith',
      GIT_COMMITTER_EMAIL: 'rounds@gauntlet.local',
    },
    tolerate,
  )
}

function ensureRepository(workspaceDir: string): void {
  const repo = repositoryDir(workspaceDir)
  if (fs.existsSync(path.join(repo, 'HEAD'))) return
  fs.mkdirSync(path.dirname(repo), { recursive: true })
  run('git', ['init', '--bare', '--quiet', repo])
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

/** Commit the playable source tree without touching a user's Git repository, index, or branch. */
export function captureRoundRevision(input: CaptureRoundRevisionInput): string {
  if (!Number.isInteger(input.round) || input.round < 1) throw new Error('Round must be a positive integer.')
  ensureRepository(input.workspaceDir)
  if (input.parentRevision) {
    assertRevision(input.parentRevision)
    git(input.workspaceDir, ['cat-file', '-e', `${input.parentRevision}^{commit}`])
  }

  const revision = withTemporaryIndex((indexFile) => {
    git(input.workspaceDir, input.parentRevision ? ['read-tree', input.parentRevision] : ['read-tree', '--empty'], indexFile)
    git(input.workspaceDir, ['add', '-A', '--', '.', ...EXCLUDED_PATHS], indexFile, IGNORED_PATHS_WARNING)
    const tree = git(input.workspaceDir, ['write-tree'], indexFile)
    const args = ['commit-tree', tree, '-m', `Gauntlet Gamesmith ${input.loopId} round ${input.round}`]
    if (input.parentRevision) args.push('-p', input.parentRevision)
    return git(input.workspaceDir, args, indexFile)
  })

  assertRevision(revision)
  const safeLoopId = input.loopId.replace(/[^a-zA-Z0-9._-]+/g, '-')
  git(input.workspaceDir, ['update-ref', `refs/loops/${safeLoopId}/rounds/${input.round}`, revision])
  return revision
}

/** Materialize a temporary playable checkout for one immutable round revision. */
export function checkoutRoundRevision(workspaceDir: string, round: number, revision: string): string {
  if (!Number.isInteger(round) || round < 1) throw new Error('Round must be a positive integer.')
  assertRevision(revision)
  ensureRepository(workspaceDir)
  git(workspaceDir, ['cat-file', '-e', `${revision}^{commit}`])
  const destination = path.join(workspaceDir, RUN_METADATA_DIR, PLAY_DIR, `round-${round}-${revision.slice(0, 12)}`)
  fs.rmSync(destination, { recursive: true, force: true })
  fs.mkdirSync(destination, { recursive: true })
  try {
    withTemporaryIndex((indexFile) => {
      git(workspaceDir, ['read-tree', revision], indexFile)
      git(workspaceDir, ['checkout-index', '--all', '--force', `--prefix=${destination}${path.sep}`], indexFile)
    })
    return destination
  } catch (error) {
    fs.rmSync(destination, { recursive: true, force: true })
    throw error
  }
}

export function cleanupRoundCheckout(checkoutDir: string): void {
  fs.rmSync(checkoutDir, { recursive: true, force: true })
}
