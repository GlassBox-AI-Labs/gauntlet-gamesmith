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
    expect(roundPublication(history, 'build', 2, 'b').action).toBe('manage')
    expect(roundPublication(history, 'build', 1, 'a').text).toBe(
      'Round 2 is currently live',
    )
    expect(roundPublication(history, 'build', 2, 'old').text).toBe(
      'Another saved revision is live',
    )
    expect(roundPublication(history, 'another-build', 2, 'b').action).toBe(
      'publish',
    )
    expect(roundPublication(history, 'build', 2, null).action).toBe('publish')
  })
  it('follows rollback and unpublish, without treating a ready preview as published', () => {
    expect(
      roundPublication({ ...history, currentReleaseId: 'r1' }, 'build', 1, 'a')
        .action,
    ).toBe('manage')
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
      ).action,
    ).toBe('publish')
  })
  it('keeps unavailable and signed-out states distinct from unpublished', () => {
    expect(roundPublication(null, 'build', 2, 'b').text).toBe(
      'Checking publication…',
    )
    expect(roundPublication(history, 'build', 2, 'b', 'Offline')).toMatchObject(
      {
        text: 'Publication unavailable',
        gameId: null,
      },
    )
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

it('offers management only for the live revision, and disables action only while checking', () => {
  expect(roundPublication(history, 'build', 2, 'b')).toMatchObject({
    action: 'manage',
    text: 'Published · Round 2',
    loading: false,
  })
  expect(roundPublication(history, 'build', 1, 'a')).toMatchObject({
    action: 'publish',
    loading: false,
  })
  expect(roundPublication(history, 'build', 2, 'different')).toMatchObject({
    action: 'publish',
    loading: false,
  })
  expect(
    roundPublication({ ...history, currentReleaseId: null }, 'build', 2, 'b')
      .action,
  ).toBe('publish')
  expect(roundPublication(null, 'build', 2, 'b').loading).toBe(true)
  expect(
    roundPublication(
      null,
      'build',
      2,
      'b',
      'Sign in to check publication status.',
    ),
  ).toMatchObject({ action: 'publish', loading: false })
})
