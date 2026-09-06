import fs from 'node:fs'
import path from 'node:path'
import { readExactFileDescriptor } from './bounded-fd'
import type { Verdict } from '../shared/build'
import { normalizeVerdict } from '../shared/persisted-data'
import { isRecordId } from '../shared/record-id'

const MAX_VERDICT_BYTES = 64 * 1024
const MAX_CLOCK_SKEW_MS = 5_000
const REVISION_PATTERN = /^[0-9a-f]{40,64}$/

export interface VerdictArtifactResult {
  verdict: Verdict | null
  error: string | null
}

export function verdictArtifactRelativePath(round: number, attemptId: string): string {
  if (!Number.isInteger(round) || round < 1 || round > 100) throw new Error('Invalid critique round.')
  if (!isRecordId(attemptId)) throw new Error('Invalid critique attempt id.')
  return `critique/round-${round}/verdict-${attemptId}.json`
}

function artifactPath(workspaceDir: string, round: number, attemptId: string): { workspace: string; critiqueDir: string; roundDir: string; file: string; relative: string } {
  const relative = verdictArtifactRelativePath(round, attemptId)
  const workspace = fs.realpathSync(workspaceDir)
  const critiqueDir = path.join(workspace, 'critique')
  const roundDir = path.join(critiqueDir, `round-${round}`)
  return { workspace, critiqueDir, roundDir, file: path.join(workspace, relative), relative }
}

function assertOwnedDirectory(workspace: string, directory: string, expected?: { dev: number; ino: number }): { dev: number; ino: number } {
  const stat = fs.lstatSync(directory)
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Verdict artifact directory must be a real directory.')
  const relative = path.relative(workspace, fs.realpathSync(directory))
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Verdict artifact directory escapes the workspace.')
  if (expected && (expected.dev !== stat.dev || expected.ino !== stat.ino)) throw new Error('Verdict artifact directory changed identity.')
  return { dev: stat.dev, ino: stat.ino }
}

/** Claim a unique per-attempt result path without deleting any workspace entry. */
export function prepareVerdictArtifact(workspaceDir: string, round: number, attemptId: string): string {
  const target = artifactPath(workspaceDir, round, attemptId)
  for (const directory of [target.critiqueDir, target.roundDir]) {
    try {
      assertOwnedDirectory(target.workspace, directory)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return target.relative
      throw error
    }
  }
  try {
    fs.lstatSync(target.file)
    throw new Error('This critique attempt already has a verdict artifact; refusing to replace it.')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  return target.relative
}

function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value).sort()
  return actual.length === keys.length && actual.every((key, index) => key === [...keys].sort()[index])
}

/** Strict machine-result schema used before a critic is allowed to advance a build. */
export function parseVerdictArtifact(value: unknown, expectedRevision: string): VerdictArtifactResult {
  if (!REVISION_PATTERN.test(expectedRevision)) return { verdict: null, error: 'The critique attempt has no valid revision binding.' }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { verdict: null, error: 'Verdict must be a JSON object.' }
  const raw = value as Record<string, unknown>
  if (!exactKeys(raw, ['revision', 'score', 'pass', 'summary', 'findings'])) {
    return { verdict: null, error: 'Verdict must contain exactly revision, score, pass, summary, and findings.' }
  }
  if (raw.revision !== expectedRevision) return { verdict: null, error: 'Verdict revision does not match the implementation revision.' }
  const verdict = normalizeVerdict({ score: raw.score, pass: raw.pass, summary: raw.summary, findings: raw.findings })
  if (!verdict || !verdict.summary.trim()) return { verdict: null, error: 'Verdict fields do not match the strict verdict schema.' }
  if (verdict.pass && verdict.score < 0.9) return { verdict: null, error: 'A passing verdict must score at least 0.90.' }
  return { verdict, error: null }
}

/**
 * The artifact is the sole verdict channel. It must be a fresh regular file
 * created by this attempt and explicitly name the immutable revision judged.
 */
export function readVerdictArtifact(
  workspaceDir: string,
  round: number,
  attemptId: string,
  startedAtMs: number,
  expectedRevision: string,
  completedAtMs = Date.now(),
): VerdictArtifactResult {
  let target: ReturnType<typeof artifactPath>
  try {
    target = artifactPath(workspaceDir, round, attemptId)
  } catch (error) {
    return { verdict: null, error: error instanceof Error ? error.message : String(error) }
  }
  let descriptor: number | null = null
  let stat: fs.Stats
  try {
    const critiqueIdentity = assertOwnedDirectory(target.workspace, target.critiqueDir)
    const roundIdentity = assertOwnedDirectory(target.workspace, target.roundDir)
    const before = fs.lstatSync(target.file)
    if (before.isSymbolicLink()) {
      return { verdict: null, error: 'Verdict artifact must be a regular file, not a symlink.' }
    }
    descriptor = fs.openSync(target.file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0))
    stat = fs.fstatSync(descriptor)
    if (stat.dev !== before.dev || stat.ino !== before.ino) {
      fs.closeSync(descriptor)
      descriptor = null
      return { verdict: null, error: 'Verdict artifact changed identity before it was opened.' }
    }
    assertOwnedDirectory(target.workspace, target.critiqueDir, critiqueIdentity)
    assertOwnedDirectory(target.workspace, target.roundDir, roundIdentity)
  } catch {
    if (descriptor !== null) fs.closeSync(descriptor)
    return { verdict: null, error: `Missing ${target.relative}.` }
  }
  if (!stat.isFile() || stat.nlink !== 1) {
    fs.closeSync(descriptor)
    return { verdict: null, error: 'Verdict artifact must be an owned regular file, not a link.' }
  }
  if (stat.mtimeMs < startedAtMs) {
    fs.closeSync(descriptor)
    return { verdict: null, error: 'Verdict artifact predates this critique attempt.' }
  }
  if (!Number.isFinite(completedAtMs) || stat.mtimeMs > completedAtMs + MAX_CLOCK_SKEW_MS) {
    fs.closeSync(descriptor)
    return { verdict: null, error: 'Verdict artifact is future-dated beyond the allowed clock skew.' }
  }
  if (stat.size > MAX_VERDICT_BYTES) {
    fs.closeSync(descriptor)
    return { verdict: null, error: 'Verdict artifact exceeds 64 KiB.' }
  }
  let raw: unknown
  try {
    raw = JSON.parse(readExactFileDescriptor(descriptor, stat.size, MAX_VERDICT_BYTES, 'Verdict artifact').toString('utf8'))
    const after = fs.lstatSync(target.file)
    if (after.isSymbolicLink() || after.dev !== stat.dev || after.ino !== stat.ino || after.nlink !== 1) {
      throw new Error('Verdict artifact changed identity while it was read.')
    }
  } catch (error) {
    fs.closeSync(descriptor)
    return { verdict: null, error: `Verdict artifact is not valid JSON: ${error instanceof Error ? error.message : String(error)}` }
  }
  fs.closeSync(descriptor)
  return parseVerdictArtifact(raw, expectedRevision)
}
