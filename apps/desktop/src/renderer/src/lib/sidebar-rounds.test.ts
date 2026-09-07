import { describe, expect, it } from 'vitest'
import type { BuildSnapshot } from '../../../shared/build'
import { summarizeRounds } from './sidebar-rounds'

describe('sidebar round summaries', () => {
  it('keeps round labels, scores and active state without retaining heavy attempt details', () => {
    const snapshot = { attempts: [
      { round: 0, status: 'succeeded', verdict: null },
      { round: 1, status: 'succeeded', verdict: { score: 0.75 }, prompt: 'large prompt', metrics: {} },
      { round: 1, status: 'queued', verdict: null },
      { round: 2, status: 'running', verdict: null },
      { round: 3, status: 'failed', verdict: null },
    ] } as BuildSnapshot
    const rounds = summarizeRounds(snapshot)
    expect(rounds).toEqual([
      { round: 3, score: null, active: false },
      { round: 2, score: null, active: true },
      { round: 1, score: 0.75, active: true },
    ])
    snapshot.attempts = []
    expect(rounds).toHaveLength(3)
  })

  it('does not invent rounds for an empty build or a reference-only build', () => {
    expect(summarizeRounds({ attempts: [] } as unknown as BuildSnapshot)).toEqual([])
    expect(summarizeRounds({ attempts: [{ round: 0 }] } as BuildSnapshot)).toEqual([])
  })
})
