import { describe, expect, it } from 'vitest'
import type { RunRecord } from '../shared/loop'
import { planCompletion, planResume, planStart } from './round-planner'

describe('planCompletion', () => {
  it.each([
    [{ role: 'reference', round: 0, maxRounds: 3, budgetExceeded: false }, { kind: 'queue-implement', round: 1 }],
    [{ role: 'reference', round: 0, maxRounds: 3, budgetExceeded: true }, { kind: 'finish-budget' }],
    [{ role: 'implement', round: 1, maxRounds: 3, budgetExceeded: false }, { kind: 'queue-critique', round: 1 }],
    [{ role: 'implement', round: 3, maxRounds: 3, budgetExceeded: false }, { kind: 'finish-exhausted' }],
    [{ role: 'implement', round: 1, maxRounds: 3, budgetExceeded: true }, { kind: 'finish-budget' }],
    [{ role: 'critique', round: 1, maxRounds: 3, budgetExceeded: false, verdictPass: true }, { kind: 'finish-passed' }],
    [{ role: 'critique', round: 3, maxRounds: 3, budgetExceeded: false, verdictPass: false }, { kind: 'finish-exhausted' }],
    [{ role: 'critique', round: 1, maxRounds: 3, budgetExceeded: true, verdictPass: false }, { kind: 'finish-budget' }],
    [{ role: 'critique', round: 1, maxRounds: 3, budgetExceeded: false, verdictPass: false }, { kind: 'queue-implement', round: 2 }],
  ] as const)('maps %o to %o', (input, expected) => {
    expect(planCompletion(input)).toEqual(expected)
  })
})

function run(role: RunRecord['role'], status: RunRecord['status'], round: number): RunRecord {
  return { role, status, round } as RunRecord
}

describe('planResume', () => {
  it.each([
    [null, { kind: 'queue-reference', round: 0 }],
    [run('implement', 'queued', 2), { kind: 'continue-queued', run: run('implement', 'queued', 2) }],
    [run('critique', 'failed', 2), { kind: 'retry', run: run('critique', 'failed', 2) }],
    [run('reference', 'succeeded', 0), { kind: 'queue-implement', round: 1, prior: run('reference', 'succeeded', 0) }],
    [run('implement', 'succeeded', 2), { kind: 'queue-critique', round: 2, prior: run('implement', 'succeeded', 2) }],
    [run('implement', 'succeeded', 3), { kind: 'finish-exhausted', prior: run('implement', 'succeeded', 3) }],
    [run('critique', 'succeeded', 2), { kind: 'queue-implement', round: 3, prior: run('critique', 'succeeded', 2) }],
    [run('critique', 'succeeded', 3), { kind: 'finish-exhausted', prior: run('critique', 'succeeded', 3) }],
  ] as const)('maps resume state %# to one action', (last, expected) => {
    expect(planResume(last, 3)).toEqual(expected)
  })

})

it('skips reference on initial start and on an empty-history resume', () => {
  expect(planStart('skip')).toEqual({ role: 'implement', round: 1 })
  expect(planResume(null, 4, 'skip')).toEqual({ kind: 'queue-implement', round: 1, prior: null })
  expect(planStart('files')).toEqual({ role: 'reference', round: 0 })
  expect(planStart()).toEqual({ role: 'reference', round: 0 })
})
