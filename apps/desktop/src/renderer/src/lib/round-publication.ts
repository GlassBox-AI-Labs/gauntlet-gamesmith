import type { ReleaseHistory } from '../../../shared/publishing'
export function roundPublication(
  history: ReleaseHistory | null,
  buildId: string,
  round: number,
  revision: string | null,
  error = '',
) {
  if (error)
    return {
      text: error.startsWith('Sign in')
        ? 'Sign in to check publication'
        : 'Publication unavailable',
      gameId: null,
    }
  if (!history) return { text: 'Checking publication…', gameId: null }
  const current = history.releases.find(
    (r) => r.id === history.currentReleaseId && r.status === 'ready',
  )
  if (!current) return { text: 'Unpublished', gameId: null }
  if (
    revision &&
    current.buildId === buildId &&
    current.round === round &&
    current.revision === revision
  )
    return { text: 'Published', gameId: history.gameId }
  return {
    text:
      current.round !== round
        ? `Round ${current.round ?? '?'} is live`
        : 'Another saved revision is live',
    gameId: history.gameId,
  }
}
