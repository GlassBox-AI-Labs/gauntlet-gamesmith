import type { ReferenceMode, RunRecord } from '../shared/loop'

export type CompletionPlan =
  | { kind: 'queue-implement'; round: number }
  | { kind: 'queue-critique'; round: number }
  | { kind: 'finish-passed' }
  | { kind: 'finish-exhausted' }
  | { kind: 'finish-budget' }

type CompletionInput =
  | { role: 'reference'; round: 0; maxRounds: number; budgetExceeded: boolean }
  | { role: 'implement'; round: number; maxRounds: number; budgetExceeded: boolean }
  | { role: 'critique'; round: number; maxRounds: number; budgetExceeded: boolean; verdictPass: boolean }

/** Pure phase-completion table; callers only perform the returned transition. */
export function planCompletion(input: CompletionInput): CompletionPlan {
  if (input.role === 'reference') return input.budgetExceeded ? { kind: 'finish-budget' } : { kind: 'queue-implement', round: 1 }
  if (input.role === 'implement') {
    if (input.budgetExceeded) return { kind: 'finish-budget' }
    return input.round >= input.maxRounds
      ? { kind: 'finish-exhausted' }
      : { kind: 'queue-critique', round: input.round }
  }
  if (input.verdictPass) return { kind: 'finish-passed' }
  if (input.round >= input.maxRounds) return { kind: 'finish-exhausted' }
  return input.budgetExceeded ? { kind: 'finish-budget' } : { kind: 'queue-implement', round: input.round + 1 }
}

export type ResumePlan =
  | { kind: 'continue-queued'; run: RunRecord }
  | { kind: 'retry'; run: RunRecord }
  | { kind: 'queue-reference'; round: 0 }
  | { kind: 'queue-implement'; round: number; prior: RunRecord | null }
  | { kind: 'queue-critique'; round: number; prior: RunRecord }
  | { kind: 'finish-exhausted'; prior: RunRecord }

/** Pure resume table keeps terminal and successor rules out of controller code. */
export function planResume(last: RunRecord | null | undefined, maxRounds: number, referenceMode: ReferenceMode = 'web'): ResumePlan {
  if (last?.status === 'queued') return { kind: 'continue-queued', run: last }
  if (last && last.status !== 'succeeded') return { kind: 'retry', run: last }
  // A loop that skipped the Reference Study has no round 0 to fall back to.
  if (!last) return referenceMode === 'skip' ? { kind: 'queue-implement', round: 1, prior: null } : { kind: 'queue-reference', round: 0 }
  if (last.role === 'reference') return { kind: 'queue-implement', round: 1, prior: last }
  if (last.role === 'implement') {
    return last.round >= maxRounds
      ? { kind: 'finish-exhausted', prior: last }
      : { kind: 'queue-critique', round: last.round, prior: last }
  }
  const nextRound = last.round + 1
  return nextRound > maxRounds
    ? { kind: 'finish-exhausted', prior: last }
    : { kind: 'queue-implement', round: nextRound, prior: last }
}

export function planStart(referenceMode: ReferenceMode = 'web'): { role: 'reference' | 'implement'; round: number } {
  return referenceMode === 'skip' ? { role: 'implement', round: 1 } : { role: 'reference', round: 0 }
}
