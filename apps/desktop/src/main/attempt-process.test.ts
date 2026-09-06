import fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  completeProcessMeta,
  interruptCapturedProcessGroup,
  interruptNewProcessGroup,
  interruptProcessGroup,
  prepareProcessMeta,
  processMatches,
  processMetaPath,
  readProcessIdentity,
  readProcessMeta,
  safePid,
} from './attempt-process'

const dirs: string[] = []

function workspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gauntlet-process-'))
  dirs.push(dir)
  return dir
}

function workspaceIdentity(dir: string): { dev: number; ino: number } {
  const stat = fs.lstatSync(dir)
  return { dev: stat.dev, ino: stat.ino }
}

function testSnapshot(pid: number, startedAtMs: number): { identity: string; groupId: number; startedAtMs: number } {
  return { identity: readProcessIdentity(pid)!, groupId: pid, startedAtMs }
}

afterEach(() => {
  vi.restoreAllMocks()
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('build process metadata', () => {
  it('rejects unsafe PIDs including the POSIX broadcast target', () => {
    expect(safePid(-1)).toBe(false)
    expect(safePid(0)).toBe(false)
    expect(safePid(1)).toBe(false)
    expect(safePid(2)).toBe(true)
    expect(safePid(1e300)).toBe(false)
    expect(safePid(0x8000_0000)).toBe(false)
  })

  it('persists a starting marker, then validates exact contained streams and PID identity', () => {
    const dir = workspace()
    const attemptId = randomUUID()
    const marker = prepareProcessMeta(dir, attemptId, Date.now(), workspaceIdentity(dir))
    fs.writeFileSync(marker.outPath, '')
    fs.writeFileSync(marker.errPath, '')
    expect(readProcessMeta(dir, attemptId).error).toContain('did not finish')

    const meta = completeProcessMeta(dir, attemptId, marker, process.pid, (pid) => testSnapshot(pid, marker.startedAtMs))
    expect(readProcessMeta(dir, attemptId)).toEqual({ meta, error: null })
    expect(processMatches(meta)).toBe(true)
  })

  it('rejects a reused PID or a process that is not the detached group leader', () => {
    const dir = workspace()
    const attemptId = randomUUID()
    const marker = prepareProcessMeta(dir, attemptId, Date.now(), workspaceIdentity(dir))
    expect(() => completeProcessMeta(dir, attemptId, marker, 42, () => ({
      identity: 'Thu Sep  3 00:00:00 2026',
      groupId: 99,
      startedAtMs: marker.startedAtMs,
    }))).toThrow(/process-group leader/)
    expect(() => completeProcessMeta(dir, attemptId, marker, 42, () => ({
      identity: 'Thu Sep  3 00:00:00 2026',
      groupId: 42,
      startedAtMs: marker.startedAtMs - 60_000,
    }))).toThrow(/launch time/)
  })

  it('rejects forged paths and malformed offsets before recovery can read them', () => {
    const dir = workspace()
    const attemptId = randomUUID()
    const marker = prepareProcessMeta(dir, attemptId, Date.now(), workspaceIdentity(dir))
    fs.writeFileSync(marker.outPath, '')
    fs.writeFileSync(marker.errPath, '')
    const meta = completeProcessMeta(dir, attemptId, marker, process.pid, (pid) => testSnapshot(pid, marker.startedAtMs))
    fs.writeFileSync(processMetaPath(dir, attemptId), JSON.stringify({ ...meta, outPath: '/etc/passwd' }))
    expect(readProcessMeta(dir, attemptId).error).toContain('exact-path')
    fs.writeFileSync(processMetaPath(dir, attemptId), JSON.stringify({ ...meta, childOffsets: { '../escape.codex.jsonl': 1 } }))
    expect(readProcessMeta(dir, attemptId).error).toContain('schema')
    fs.writeFileSync(processMetaPath(dir, attemptId), JSON.stringify({ ...meta, workflowOffsets: { '../session/agent-a.jsonl': 1 } }))
    expect(readProcessMeta(dir, attemptId).error).toContain('schema')
  })

  it('rejects a symlink planted at an otherwise exact stream path', () => {
    const dir = workspace()
    const attemptId = randomUUID()
    const marker = prepareProcessMeta(dir, attemptId, Date.now(), workspaceIdentity(dir))
    const target = path.join(dir, 'outside.log')
    fs.writeFileSync(target, 'not this build')
    fs.writeFileSync(marker.outPath, '')
    fs.writeFileSync(marker.errPath, '')
    const meta = completeProcessMeta(dir, attemptId, marker, process.pid, (pid) => testSnapshot(pid, marker.startedAtMs))
    fs.unlinkSync(marker.outPath)
    fs.symlinkSync(target, marker.outPath)

    expect(readProcessMeta(dir, attemptId)).toEqual({ meta: null, error: 'process streams must not be symbolic links' })
  })

  it('rejects hard-linked process metadata before parsing it', () => {
    const dir = workspace()
    const attemptId = randomUUID()
    const file = processMetaPath(dir, attemptId)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const outside = path.join(dir, 'outside-meta.json')
    fs.writeFileSync(outside, '{}')
    fs.linkSync(outside, file)

    expect(readProcessMeta(dir, attemptId).error).toContain('unlinked regular file')
  })

  it('never overwrites a completed-metadata target planted at exclusive publication', () => {
    const dir = workspace()
    const attemptId = randomUUID()
    const marker = prepareProcessMeta(dir, attemptId, Date.now(), workspaceIdentity(dir))
    fs.writeFileSync(marker.outPath, '')
    fs.writeFileSync(marker.errPath, '')
    const target = processMetaPath(dir, attemptId)
    const originalOpen = fs.openSync.bind(fs)
    let planted = false
    vi.spyOn(fs, 'openSync').mockImplementation(((file: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
      if (!planted && String(file) === target && typeof flags === 'number' && (flags & fs.constants.O_EXCL) !== 0) {
        planted = true
        fs.writeFileSync(target, 'operator metadata')
      }
      return originalOpen(file, flags, mode)
    }) as typeof fs.openSync)

    expect(() => completeProcessMeta(dir, attemptId, marker, process.pid, (pid) => testSnapshot(pid, marker.startedAtMs))).toThrow(/EEXIST/)
    expect(fs.readFileSync(target, 'utf8')).toBe('operator metadata')
  })

  it('does not publish completed metadata through a replaced workspace root', () => {
    const dir = workspace()
    const attemptId = randomUUID()
    const marker = prepareProcessMeta(dir, attemptId, Date.now(), workspaceIdentity(dir))
    fs.writeFileSync(marker.outPath, '')
    fs.writeFileSync(marker.errPath, '')
    const preserved = `${dir}-preserved`
    dirs.push(preserved)
    fs.renameSync(dir, preserved)
    fs.mkdirSync(dir)

    expect(() => completeProcessMeta(dir, attemptId, marker, process.pid, (pid) => testSnapshot(pid, marker.startedAtMs))).toThrow(
      /Workspace root changed identity/,
    )
    expect(fs.existsSync(processMetaPath(dir, attemptId))).toBe(false)
  })

  it('keeps escalating an owned process group after its leader identity disappears', () => {
    const signals: Array<0 | NodeJS.Signals> = []
    const scheduled: Array<() => void> = []
    const reports: string[] = []
    const meta = {
      version: 1 as const,
      pid: 42,
      processIdentity: 'owned',
      groupIdentities: ['42:owned'],
      outPath: '/tmp/out',
      errPath: '/tmp/err',
      startedAtMs: 1,
      outDev: 1,
      outIno: 1,
      errDev: 1,
      errIno: 1,
      loggedOutLines: 0,
      loggedErrLines: 0,
    }
    let owned = true
    interruptProcessGroup(meta, (line) => reports.push(line), {
      identityMatches: () => true,
      groupIdentity: () => owned ? ['42:owned', '43:owned-child'] : [],
      groupStillOwned: () => owned,
      kill: (_pid, signal) => {
        signals.push(signal)
        if (signal === 'SIGKILL') owned = false
      },
      defer: (work) => {
        scheduled.push(work)
        return { unref: () => undefined }
      },
    })

    while (scheduled.length > 0) scheduled.shift()!()
    expect(signals).toEqual([0, 'SIGINT', 0, 'SIGKILL'])
    expect(reports).toEqual(expect.arrayContaining([
      'SIGINT sent to owned process group 42.',
      'SIGKILL sent to owned process group 42.',
    ]))
  })

  it('does not signal when the durable leader leaves before group capture', () => {
    const signals: Array<0 | NodeJS.Signals> = []
    let settled = false
    const meta = {
      version: 1 as const,
      pid: 46,
      processIdentity: 'owned-start',
      groupIdentities: ['46:owned-start'],
      outPath: '/tmp/out',
      errPath: '/tmp/err',
      startedAtMs: 1,
      outDev: 1,
      outIno: 1,
      errDev: 1,
      errIno: 1,
      loggedOutLines: 0,
      loggedErrLines: 0,
    }
    interruptProcessGroup(meta, () => {}, {
      identityMatches: () => true,
      groupIdentity: () => ['99:stranger-start'],
      groupStillOwned: () => true,
      kill: (_pid, signal) => { signals.push(signal) },
      defer: () => ({ unref: () => undefined }),
    }, () => { settled = true })

    expect(signals).toEqual([0])
    expect(settled).toBe(true)
  })

  it('supervises a just-spawned group through bounded escalation', () => {
    const signals: Array<0 | NodeJS.Signals> = []
    const scheduled: Array<() => void> = []
    let settled = false
    let owned = true
    interruptNewProcessGroup(43, () => {}, () => { settled = true }, {
      kill: (_pid, signal) => { signals.push(signal) },
      groupIdentity: () => owned ? ['43:owned-child'] : [],
      groupStillOwned: () => owned,
      defer: (work) => {
        scheduled.push(work)
        return { unref: () => undefined }
      },
    })
    // Model the OS dropping the captured group immediately after SIGKILL.
    const first = scheduled.shift()!
    first()
    owned = false
    while (scheduled.length > 0) scheduled.shift()!()
    expect(signals).toEqual([0, 'SIGINT', 0, 'SIGKILL'])
    expect(settled).toBe(true)
  })

  it('latches ownership finished after absence so a reused PGID is never signalled later', () => {
    const signals: Array<0 | NodeJS.Signals> = []
    const scheduled: Array<() => void> = []
    let probes = 0
    let settled = 0
    interruptNewProcessGroup(44, () => {}, () => { settled += 1 }, {
      kill: (_pid, signal) => {
        signals.push(signal)
        if (signal === 0 && ++probes === 2) throw new Error('group gone')
      },
      groupIdentity: () => ['44:owned-child'],
      groupStillOwned: () => true,
      defer: (work) => {
        scheduled.push(work)
        return { unref: () => undefined }
      },
    })

    scheduled.forEach((work) => work())
    expect(signals).toEqual([0, 'SIGINT', 0])
    expect(settled).toBe(1)
  })

  it('does not SIGKILL a live numeric PGID after every captured member identity changed', () => {
    const signals: Array<0 | NodeJS.Signals> = []
    const scheduled: Array<() => void> = []
    let outcome: string | null = null
    interruptNewProcessGroup(45, () => {}, (next) => { outcome = next }, {
      kill: (_pid, signal) => { signals.push(signal) },
      groupIdentity: () => ['99:foreign-start'],
      groupStillOwned: () => false,
      defer: (work) => {
        scheduled.push(work)
        return { unref: () => undefined }
      },
    })
    scheduled.forEach((work) => work())
    expect(signals).toEqual([])
    expect(outcome).toBe('unresolved')
  })

  it('treats a failed identity probe as unknown and never signals the numeric PGID', () => {
    const signals: Array<0 | NodeJS.Signals> = []
    let outcome: string | null = null
    interruptCapturedProcessGroup(48, ['48:owned-start'], () => {}, (next) => { outcome = next }, {
      kill: (_pid, signal) => { signals.push(signal) },
      groupIdentity: () => { throw new Error('ps timed out') },
      groupStillOwned: () => { throw new Error('ps timed out') },
      defer: () => ({ unref: () => undefined }),
    })

    expect(signals).toEqual([])
    expect(outcome).toBe('unresolved')
  })

  it('reports unresolved and retains ownership when a group survives SIGKILL', () => {
    const signals: Array<0 | NodeJS.Signals> = []
    const scheduled: Array<() => void> = []
    const reports: string[] = []
    let outcome: string | null = null
    interruptNewProcessGroup(47, (line) => reports.push(line), (next) => { outcome = next }, {
      kill: (_pid, signal) => { signals.push(signal) },
      groupIdentity: () => ['47:owned-child'],
      groupStillOwned: () => true,
      defer: (work) => {
        scheduled.push(work)
        return { unref: () => undefined }
      },
    })

    while (scheduled.length > 0) scheduled.shift()!()

    expect(signals).toEqual([0, 'SIGINT', 0, 'SIGKILL', 0])
    expect(outcome).toBe('unresolved')
    expect(reports.some((line) => line.includes('manual intervention'))).toBe(true)
  })
})
