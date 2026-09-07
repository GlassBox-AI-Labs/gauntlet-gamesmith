import { describe, expect, it } from 'vitest'
import {
  orphanedGroupIds,
  parseProcessTable,
  processIdentityOf,
  strayGroupIds,
  trackDescendantGroups,
  type DescendantGroups,
  type ProcessTableRow,
} from './stray-processes'

const LEADER = 1000
let clock = 0

function row(pid: number, ppid: number, pgid: number, lstart = `Mon Sep  7 00:00:${String(clock++ % 60).padStart(2, '0')} 2026`): ProcessTableRow {
  return { pid, ppid, pgid, lstart }
}

/** The attempt leader, detached, so it leads its own group. */
function leader(): ProcessTableRow {
  return row(LEADER, 1, LEADER, 'Mon Sep  7 00:00:01 2026')
}

function track(samples: ProcessTableRow[][]): DescendantGroups {
  const groups: DescendantGroups = new Map()
  for (const sample of samples) trackDescendantGroups(sample, LEADER, groups)
  return groups
}

describe('tracking the groups an attempt creates', () => {
  it('records the leader group', () => {
    expect([...track([[leader()]]).keys()]).toEqual([LEADER])
  })

  it('records a descendant that stayed in the leader group', () => {
    const groups = track([[leader(), row(1001, LEADER, LEADER)]])
    expect([...groups.keys()]).toEqual([LEADER])
  })

  // The stock CLIs run each of their own Bash commands in a fresh process
  // group. That group is what Stop was missing.
  it('records a descendant that started its own group', () => {
    const groups = track([[leader(), row(2000, LEADER, 2000)]])
    expect([...groups.keys()].sort()).toEqual([LEADER, 2000])
  })

  it('records a group nested below another escaped group', () => {
    const groups = track([[leader(), row(2000, LEADER, 2000), row(3000, 2000, 3000)]])
    expect([...groups.keys()].sort()).toEqual([LEADER, 2000, 3000])
  })

  // The incident: the shell exits, the background process is reparented to
  // init, and every parent link back to the attempt is gone.
  it('keeps a group after its parent link is severed', () => {
    const escaped = row(2000, LEADER, 2000)
    const orphaned: ProcessTableRow = { ...escaped, ppid: 1 }
    const groups = track([[leader(), escaped], [leader(), orphaned]])
    expect([...groups.keys()].sort()).toEqual([LEADER, 2000])
  })

  it('still finds new work started by an orphaned group', () => {
    const escaped = row(2000, LEADER, 2000)
    const orphaned: ProcessTableRow = { ...escaped, ppid: 1 }
    const groups = track([
      [leader(), escaped],
      [leader(), orphaned, row(4000, 2000, 4000)],
    ])
    expect([...groups.keys()].sort()).toEqual([LEADER, 2000, 4000])
  })

  it('never descends from init into unrelated processes', () => {
    const groups = track([[leader(), row(9000, 1, 9000), row(9001, 9000, 9000)]])
    expect([...groups.keys()]).toEqual([LEADER])
  })

  it('ignores a process unrelated to the attempt', () => {
    const groups = track([[leader(), row(5000, 4999, 5000)]])
    expect([...groups.keys()]).toEqual([LEADER])
  })

  // The leader's own group empties when it exits; what it spawned does not.
  it('survives the leader exiting, still tracking what it left behind', () => {
    const escaped = row(2000, LEADER, 2000)
    const groups = track([[leader(), escaped], [{ ...escaped, ppid: 1 }]])
    expect([...groups.keys()]).toEqual([2000])
  })

  // A PGID freed by a finished group can be handed to a stranger. Only the
  // identities actually seen in the group keep it in scope.
  it('drops a group whose id was recycled by a stranger', () => {
    const escaped = row(2000, LEADER, 2000, 'Mon Sep  7 00:00:05 2026')
    const stranger = row(2000, 1, 2000, 'Mon Sep  7 09:30:00 2026')
    const groups = track([
      [leader(), escaped],
      [leader(), stranger, row(6000, 2000, 6000)],
    ])
    expect([...groups.keys()]).toEqual([LEADER])
    // Neither the stranger nor its children were ever adopted as ours.
    expect(groups.has(6000)).toBe(false)
  })

  it('forgets a group once everything it held has exited', () => {
    const escaped = row(2000, LEADER, 2000)
    const groups = track([[leader(), escaped], [leader()]])
    expect([...groups.keys()]).toEqual([LEADER])
  })

  // A group outlives the individual member we first saw in it.
  it('keeps a group whose members turn over while it runs', () => {
    const first = row(2000, LEADER, 2000, 'Mon Sep  7 00:00:05 2026')
    const second = row(2001, 2000, 2000, 'Mon Sep  7 00:00:06 2026')
    const groups = track([
      [leader(), first],
      [leader(), first, second],
      [leader(), second],
    ])
    expect([...groups.keys()].sort()).toEqual([LEADER, 2000])
  })

  it('remembers the identities it saw so the stop can verify them', () => {
    const escaped = row(2000, LEADER, 2000, 'Mon Sep  7 00:00:05 2026')
    const groups = track([[leader(), escaped]])
    expect([...groups.get(2000)!]).toEqual(['2000:Mon Sep  7 00:00:05 2026'])
  })

  it('accumulates every member identity of a group it owns', () => {
    const first = row(2000, LEADER, 2000, 'Mon Sep  7 00:00:05 2026')
    const second = row(2001, 2000, 2000, 'Mon Sep  7 00:00:06 2026')
    const groups = track([[leader(), first], [leader(), first, second]])
    expect([...groups.get(2000)!].sort()).toEqual([
      '2000:Mon Sep  7 00:00:05 2026',
      '2001:Mon Sep  7 00:00:06 2026',
    ])
  })

  it('does not record process groups 0 or 1', () => {
    const groups = track([[leader(), row(2000, LEADER, 1), row(2001, LEADER, 0)]])
    expect([...groups.keys()]).toEqual([LEADER])
  })

  it('does nothing for an unsafe leader pid', () => {
    const groups: DescendantGroups = new Map()
    trackDescendantGroups([leader()], 0, groups)
    expect(groups.size).toBe(0)
  })

  it('builds an identity string the canonical group probe would match', () => {
    expect(processIdentityOf(row(2000, 1, 2000, 'Mon Sep  7 00:00:05 2026')))
      .toBe('2000:Mon Sep  7 00:00:05 2026')
  })
})

describe('choosing which groups the sweep signals', () => {
  it('leaves out the groups the canonical stop already covers', () => {
    const groups: DescendantGroups = new Map([[LEADER, new Set<string>()], [2000, new Set<string>()]])
    expect(strayGroupIds(groups, [LEADER])).toEqual([2000])
  })

  it('sorts the groups so the sweep order is stable', () => {
    const groups: DescendantGroups = new Map([[5000, new Set<string>()], [2000, new Set<string>()]])
    expect(strayGroupIds(groups, [])).toEqual([2000, 5000])
  })

  it('returns nothing when the attempt never escaped its own group', () => {
    expect(strayGroupIds(new Map([[LEADER, new Set<string>()]]), [LEADER])).toEqual([])
  })
})

describe('spotting what an agent has left running', () => {
  it('reports a tracked group once every member has been reparented to init', () => {
    const rows = [leader(), row(2000, 1, 2000)]
    const groups = track([[leader(), row(2000, LEADER, 2000)]])
    expect(orphanedGroupIds(rows, groups, LEADER)).toEqual([2000])
  })

  it('says nothing while the group still has a parent waiting on it', () => {
    const rows = [leader(), row(2000, LEADER, 2000)]
    expect(orphanedGroupIds(rows, track([rows]), LEADER)).toEqual([])
  })

  it('says nothing about a group with one live parented member left', () => {
    const rows = [leader(), row(2000, 1, 2000), row(2001, LEADER, 2000)]
    expect(orphanedGroupIds(rows, track([rows]), LEADER)).toEqual([])
  })

  it('never reports the attempt leader group itself', () => {
    const rows = [row(LEADER, 1, LEADER, 'Mon Sep  7 00:00:01 2026')]
    expect(orphanedGroupIds(rows, track([rows]), LEADER)).toEqual([])
  })

  it('ignores a group it never tracked', () => {
    expect(orphanedGroupIds([row(7000, 1, 7000)], new Map(), LEADER)).toEqual([])
  })
})

describe('process table parsing', () => {
  const LINE = '19742 19720 19664 Mon Sep  7 00:57:56 2026'

  it('reads pid, parent, group and start time from a ps row', () => {
    expect(parseProcessTable(LINE)).toEqual([
      { pid: 19742, ppid: 19720, pgid: 19664, lstart: 'Mon Sep  7 00:57:56 2026' },
    ])
  })

  it('keeps the good rows when a row is malformed', () => {
    expect(parseProcessTable(['not a process row', LINE, ''].join('\n')).map((entry) => entry.pid))
      .toEqual([19742])
  })

  it('drops a row whose start time is not a real ps timestamp', () => {
    expect(parseProcessTable('19742 19720 19664 whenever')).toEqual([])
  })

  it('drops a row with an unsafe pid', () => {
    expect(parseProcessTable('0 0 0 Mon Sep  7 00:57:56 2026')).toEqual([])
  })
})
