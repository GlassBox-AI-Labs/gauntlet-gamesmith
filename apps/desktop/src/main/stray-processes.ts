import { spawnSync } from 'node:child_process'
import { PROCESS_LSTART, safePid } from './attempt-process'

/**
 * Stopping an attempt signals its process group, which covers every descendant
 * that stayed in it. It does not cover a descendant that started a group of its
 * own: the stock CLIs run each of their own Bash commands in a fresh group, so
 * anything an agent backgrounds there is reparented to init the moment that
 * command's shell exits.
 *
 * Once that has happened no kernel link back to the attempt survives. The
 * parent is gone, the group differs, and macOS exposes neither the process
 * environment (`ps -E` is restricted) nor a usable session id. Asking at stop
 * time is therefore too late — the answer no longer exists.
 *
 * So the app watches instead. While the attempt runs it samples the process
 * table, walks the live parent links down from the attempt's leader, and
 * records every process group it reaches. A group recorded while its parent
 * link was still visible stays known after that link is severed.
 *
 * Each group is remembered by the same `pid:lstart` identity strings the
 * canonical group stop already verifies, so a group whose PGID is later
 * recycled by an unrelated process fails that check and is left alone.
 */

// A full table on a busy machine is a few hundred KB; the ceiling only exists
// so a pathological `ps` cannot exhaust memory.
const TABLE_LIMIT_BYTES = 4 * 1024 * 1024
const TABLE_PROBE_TIMEOUT_MS = 5_000
// Captured loosely, then held to the canonical `PROCESS_LSTART` grammar: these
// identities are handed to the canonical group stop, so the two must agree.
const ROW = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\w{3} \w{3}\s+\d{1,2} \d{2}:\d{2}:\d{2} \d{4})\s*$/
/** A descendant tree far larger than this is a runaway; stop walking it. */
const MAX_TRACKED_PIDS = 10_000

export interface ProcessTableRow {
  pid: number
  ppid: number
  pgid: number
  /** `ps` start-time text, verbatim, so identities match `processGroupIdentity`. */
  lstart: string
}

/** Groups reached from the attempt leader, each with the identities seen in it. */
export type DescendantGroups = Map<number, Set<string>>

export function processIdentityOf(row: ProcessTableRow): string {
  return `${row.pid}:${row.lstart}`
}

export function parseProcessTable(stdout: string): ProcessTableRow[] {
  const rows: ProcessTableRow[] = []
  for (const line of stdout.split('\n')) {
    // A row we cannot read is skipped, never fatal. This sweep is a safety net
    // behind the identity-verified group stop; it must not be able to break it.
    const match = line.match(ROW)
    if (!match) continue
    const pid = Number(match[1])
    const ppid = Number(match[2])
    const pgid = Number(match[3])
    if (!safePid(pid) || !safePid(pgid) || !Number.isSafeInteger(ppid) || ppid < 0) continue
    if (!PROCESS_LSTART.test(match[4])) continue
    rows.push({ pid, ppid, pgid, lstart: match[4] })
  }
  return rows
}

/**
 * Fold one process-table sample into `groups`.
 *
 * Seeds are the attempt leader plus every member of an already-recorded group
 * that still holds one of its recorded identities. Walking the parent links
 * down from those seeds reaches groups created since the last sample, while the
 * recorded identities keep groups whose parent link has since been cut.
 */
export function trackDescendantGroups(
  rows: readonly ProcessTableRow[],
  rootPid: number,
  groups: DescendantGroups,
): void {
  if (!safePid(rootPid)) return
  const children = new Map<number, ProcessTableRow[]>()
  const live = new Set<string>()
  for (const row of rows) {
    live.add(processIdentityOf(row))
    const siblings = children.get(row.ppid)
    if (siblings) siblings.push(row)
    else children.set(row.ppid, [row])
  }

  // A recorded group only keeps its standing while a process we actually saw in
  // it is still there. Otherwise its PGID may since have been reused.
  const owned = new Set<number>()
  for (const [pgid, identities] of groups) {
    for (const identity of identities) {
      if (live.has(identity)) {
        owned.add(pgid)
        break
      }
    }
  }

  const record = (row: ProcessTableRow): void => {
    if (!safePid(row.pgid) || row.pgid <= 1) return
    const identities = groups.get(row.pgid) ?? new Set<string>()
    identities.add(processIdentityOf(row))
    groups.set(row.pgid, identities)
  }

  // Every current member of an owned group is a seed, so a member that appears
  // between samples is recorded while the member we already knew is still there.
  const queue = rows.filter((row) => row.pid === rootPid || owned.has(row.pgid))
  const visited = new Set<number>(queue.map((row) => row.pid))
  for (let index = 0; index < queue.length && visited.size <= MAX_TRACKED_PIDS; index += 1) {
    const row = queue[index]
    record(row)
    for (const child of children.get(row.pid) ?? []) {
      // init is every orphan's parent; descending from it would claim the machine.
      if (child.pid <= 1 || visited.has(child.pid)) continue
      visited.add(child.pid)
      queue.push(child)
    }
  }

  // Drop a group once nothing we ever saw in it is still running. It has either
  // finished or had its PGID handed to a stranger; neither is ours to signal,
  // and forgetting it keeps a long attempt's tracking bounded.
  const stillLive = new Set(rows.map(processIdentityOf))
  for (const [pgid, identities] of groups) {
    let alive = false
    for (const identity of identities) {
      if (stillLive.has(identity)) {
        alive = true
        break
      }
    }
    if (!alive) groups.delete(pgid)
  }
}

/**
 * The recorded groups that the canonical stop does not already cover, sorted so
 * a sweep signals them in a stable order.
 */
export function strayGroupIds(groups: DescendantGroups, coveredGroupIds: readonly number[]): number[] {
  const covered = new Set(coveredGroupIds)
  return [...groups.keys()].filter((pgid) => !covered.has(pgid)).sort((left, right) => left - right)
}

/**
 * Recorded groups that are now running with no parent: every member has been
 * reparented to init, so nothing is waiting on them any more. These are the
 * processes an agent has genuinely left behind, and the operator should see
 * them while they run rather than only when the phase ends (VIS-001).
 */
export function orphanedGroupIds(
  rows: readonly ProcessTableRow[],
  groups: DescendantGroups,
  leaderGroupId: number,
): number[] {
  const members = new Map<number, ProcessTableRow[]>()
  for (const row of rows) {
    if (!groups.has(row.pgid)) continue
    const found = members.get(row.pgid)
    if (found) found.push(row)
    else members.set(row.pgid, [row])
  }
  const orphaned: number[] = []
  for (const [pgid, rowsInGroup] of members) {
    if (pgid === leaderGroupId) continue
    if (rowsInGroup.every((row) => row.ppid === 1)) orphaned.push(pgid)
  }
  return orphaned.sort((left, right) => left - right)
}

/** Read the whole process table. Throws when it cannot be read at all. */
export function scanProcessTable(): ProcessTableRow[] {
  const result = spawnSync('/bin/ps', ['-Ao', 'pid=,ppid=,pgid=,lstart='], {
    cwd: '/',
    env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' },
    encoding: 'utf8',
    timeout: TABLE_PROBE_TIMEOUT_MS,
    maxBuffer: TABLE_LIMIT_BYTES,
  })
  if (result.error || result.status !== 0 || typeof result.stdout !== 'string') {
    throw new Error(`Process table scan failed${result.error ? `: ${result.error.message}` : ` with status ${String(result.status)}`}.`)
  }
  return parseProcessTable(result.stdout)
}
