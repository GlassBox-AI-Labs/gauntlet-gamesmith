import { describe, expect, it } from 'vitest'
import { roundPublication } from './round-publication'
import type { ReleaseHistory } from '../../../shared/publishing'
const history: ReleaseHistory = {
  gameId: 'game',
  gameUrl: 'https://catalog.test/games/game',
  currentReleaseId: 'r2',
  generation: 2,
  releases: [
    {
      id: 'r1',
      title: 'Game',
      status: 'ready',
      createdAt: '',
      buildId: 'build',
      round: 1,
      revision: 'a',
    },
    {
      id: 'r2',
      title: 'Game',
      status: 'ready',
      createdAt: '',
      buildId: 'build',
      round: 2,
      revision: 'b',
    },
  ],
}
describe('saved round publication status', () => {
  it('requires exact build, round, revision, and the current ready release', () => {
    expect(roundPublication(history, 'build', 2, 'b').text).toBe('Published')
    expect(roundPublication(history, 'build', 1, 'a').text).toBe(
      'Round 2 is live',
    )
    expect(roundPublication(history, 'build', 2, 'old').text).toBe(
      'Another saved revision is live',
    )
    expect(roundPublication(history, 'another-build', 2, 'b').text).not.toBe(
      'Published',
    )
    expect(roundPublication(history, 'build', 2, null).text).not.toBe(
      'Published',
    )
  })
  it('follows rollback and unpublish, without treating a ready preview as published', () => {
    expect(
      roundPublication({ ...history, currentReleaseId: 'r1' }, 'build', 1, 'a')
        .text,
    ).toBe('Published')
    expect(
      roundPublication({ ...history, currentReleaseId: null }, 'build', 2, 'b')
        .text,
    ).toBe('Unpublished')
    expect(
      roundPublication(
        {
          ...history,
          releases: history.releases.map((r) => ({ ...r, status: 'failed' })),
        },
        'build',
        2,
        'b',
      ).text,
    ).not.toBe('Published')
  })
  it('keeps unavailable and signed-out states distinct from unpublished', () => {
    expect(roundPublication(null, 'build', 2, 'b').text).toBe(
      'Checking publication…',
    )
    expect(roundPublication(history, 'build', 2, 'b', 'Offline')).toEqual({
      text: 'Publication unavailable',
      gameId: null,
    })
    expect(
      roundPublication(
        null,
        'build',
        2,
        'b',
        'Sign in to check publication status.',
      ).text,
    ).toBe('Sign in to check publication')
  })
})
