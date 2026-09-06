import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { LoopRecord } from '../shared/loop'
import { assertLoopWorkspaceIdentity } from './workspace-boundary'
import { snapshotRunLedger } from './run-transfer'

const UNKNOWN_OWNERSHIP = 'Launch identity was not durably recorded before the app exited.'

/** Metadata only: never follows links or opens project/credential file contents. */
function folderFingerprint(workspace: string): string {
  const hash = crypto.createHash('sha256')
  const pending = [workspace]
  let count = 0
  while (pending.length) {
    const entry = pending.pop()!
    if (++count > 200_000) throw new Error('Workspace exceeds the 200,000-entry trust validation limit.')
    const stat = fs.lstatSync(entry, { bigint: true })
    if (!stat.isDirectory() && !stat.isFile() && !stat.isSymbolicLink()) throw new Error('Workspace contains an unsafe special filesystem entry.')
    if (stat.isSymbolicLink()) {
      const target = path.relative(workspace, fs.realpathSync(entry))
      if (target === '..' || target.startsWith(`..${path.sep}`) || path.isAbsolute(target)) {
        throw new Error('Workspace contains a link outside the folder being trusted.')
      }
    }
    hash.update(JSON.stringify([path.relative(workspace, entry), ...[stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs, stat.nlink].map(String)]))
    if (stat.isDirectory()) {
      const names = fs.readdirSync(entry).sort()
      if (names.length + count + pending.length > 200_000) throw new Error('Workspace exceeds the 200,000-entry trust validation limit.')
      for (const name of names) pending.push(path.join(entry, name))
    }
  }
  return hash.digest('hex')
}

/** Validate an inert portable snapshot and bind consent to the complete registry/history and folder metadata. */
export function captureExistingRunTrust(
  db: DatabaseSync,
  loop: LoopRecord,
  protectedRoots: readonly string[],
  validateHistory: (registry: DatabaseSync, workspace: string, portable: DatabaseSync) => void,
): string {
  assertLoopWorkspaceIdentity(loop, protectedRoots)
  const current = db.prepare('SELECT * FROM builds WHERE id = ?').get(loop.id)
  if (!current || current.workspace_dir !== loop.workspaceDir || current.workspace_dev !== loop.workspaceIdentity?.dev || current.workspace_ino !== loop.workspaceIdentity?.ino) {
    throw new Error('The registered workspace path or identity changed.')
  }
  const active = db.prepare(`SELECT builds.id FROM builds LEFT JOIN phase_attempts ON phase_attempts.build_id = builds.id
    AND (phase_attempts.status = 'running' OR phase_attempts.process_ownership_json IS NOT NULL)
    WHERE builds.workspace_dir = ? AND (builds.status = 'running' OR phase_attempts.id IS NOT NULL) LIMIT 1`).get(loop.workspaceDir)
  if (active) throw new Error('Active or unknown process ownership remains in this folder. Stop every run before trusting it.')
  const quarantined = db.prepare(`SELECT phase_attempts.id FROM phase_attempts JOIN builds ON builds.id = phase_attempts.build_id
    WHERE builds.workspace_dir = ? AND substr(phase_attempts.error, 1, ?) = ? LIMIT 1`).get(loop.workspaceDir, UNKNOWN_OWNERSHIP.length, UNKNOWN_OWNERSHIP)
  if (quarantined) throw new Error('This workspace is quarantined after unknown process ownership.')
  const before = folderFingerprint(loop.workspaceDir)
  const snapshot = snapshotRunLedger(loop.workspaceDir)
  try {
    // Writable because validation migrates pre-rename table names in this
    // private temp copy, so both sides of the comparison below speak the same
    // vocabulary. The user's own file is never opened for writing.
    const portable = new DatabaseSync(snapshot.ledgerPath)
    const hash = crypto.createHash('sha256')
    try {
      // Existing import validation rejects executable schemas and caps rows before queries below.
      validateHistory(db, loop.workspaceDir, portable)
      for (const table of ['builds', 'phase_attempts', 'events'] as const) {
        const columns = (portable.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[])
          .map(({ name }) => name).filter((name) => name !== 'seq').sort()
        const projection = columns.map((name) => `"${name}"`).join(', ')
        const order = table === 'events' ? 'build_id, seq' : 'id'
        const where = table === 'builds' ? 'workspace_dir = ?' : 'build_id IN (SELECT id FROM builds WHERE workspace_dir = ?)'
        const expected = db.prepare(`SELECT ${projection} FROM ${table} WHERE ${where} ORDER BY ${order}`).iterate(loop.workspaceDir)
        const actual = portable.prepare(`SELECT ${projection} FROM ${table} ORDER BY ${order}`).iterate()
        for (;;) {
          const left = expected.next()
          const right = actual.next()
          if (left.done && right.done) break
          if (left.done !== right.done || JSON.stringify(left.value) !== JSON.stringify(right.value)) {
            throw new Error('The portable history does not match the registered run history.')
          }
        }
        // Include every canonical column, even ones absent in an older portable schema.
        for (const row of db.prepare(`SELECT * FROM ${table} WHERE ${where} ORDER BY ${order}`).iterate(loop.workspaceDir)) {
          hash.update(JSON.stringify(row))
        }
      }
      hash.update(JSON.stringify(snapshot.sourceIdentities, (_key, value) => typeof value === 'bigint' ? String(value) : value))
    } finally {
      portable.close()
    }
    assertLoopWorkspaceIdentity(loop, protectedRoots)
    if (folderFingerprint(loop.workspaceDir) !== before) throw new Error('The folder changed during trust validation. Try again.')
    return hash.update(before).digest('hex')
  } finally {
    snapshot.cleanup()
  }
}
