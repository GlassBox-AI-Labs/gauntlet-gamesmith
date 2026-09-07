import type { BuildSnapshot } from '../../../shared/build'

export interface SidebarRound {
  round: number
  score: number | null
  active: boolean
}

export function summarizeRounds(snapshot: BuildSnapshot): SidebarRound[] {
  const rounds = new Map<number, SidebarRound>()
  for (const attempt of snapshot.attempts) {
    if (attempt.round <= 0) continue
    const current = rounds.get(attempt.round) ?? { round: attempt.round, score: null, active: false }
    current.score ??= attempt.verdict?.score ?? null
    current.active ||= attempt.status === 'running' || attempt.status === 'queued'
    rounds.set(attempt.round, current)
  }
  return [...rounds.values()].sort((a, b) => b.round - a.round)
}
