import type { ReleaseHistory } from '../../../shared/publishing'
export function roundPublication(
  history: ReleaseHistory | null,
  buildId: string,
  round: number,
  revision: string | null,
  error = '',
) {
  const publish = { action: 'publish' as const, loading: false }
  if (error)
    return {
      ...publish,
      text: error.startsWith('Sign in')
        ? 'Sign in to check publication'
        : 'Publication unavailable',
      gameId: null,
    }
  if (!history)
    return {
      ...publish,
      loading: true,
      text: 'Checking publication…',
      gameId: null,
    }
  const current = history.releases.find(
    (r) => r.id === history.currentReleaseId && r.status === 'ready',
  )
  if (!current) return { ...publish, text: 'Unpublished', gameId: null }
  if (
    revision &&
    current.buildId === buildId &&
    current.round === round &&
    current.revision === revision
  )
    return {
      action: 'manage' as const,
      loading: false,
      text: `Published · Round ${round}`,
      gameId: history.gameId,
    }
  return {
    ...publish,
    text:
      current.round !== round
        ? `Round ${current.round ?? '?'} is currently live`
        : 'Another saved revision is live',
    gameId: history.gameId,
  }
}
