import type { Studio } from '@gauntlet/data/contracts'
import type { PublishedGame } from '../shared/publishing'
/** One projection for account-wide management and a build's publication history. */
export function publicationGames(
  studio: Studio,
  catalogUrl: string,
): PublishedGame[] {
  return studio.games.map((game) => {
    const releases = studio.releases.filter((r) => r.game_id === game.id)
    const current = releases.find((r) => r.id === game.current_release_id)
    if (game.current_release_id && (!current || current.status !== 'ready'))
      throw new Error(
        'Published release information is unavailable. Refresh and try again.',
      )
    const listing = (
      current ??
      releases.find((r) => r.status === 'ready') ??
      releases[0]
    )?.listing
    return {
      gameId: game.id,
      gameUrl: `${catalogUrl}/games/${game.slug}`,
      currentReleaseId: game.current_release_id,
      generation: game.generation,
      title: listing?.title ?? game.slug,
      description: game.description_override ?? listing?.description ?? '',
      controls: game.controls_override ?? listing?.controls ?? '',
      hasCover: !!(game.cover_key || listing?.coverPath),
      releases: releases.map((r) => ({
        id: r.id,
        title: r.listing.title,
        status: r.status,
        createdAt: r.created_at,
        round: r.source?.round ?? null,
        buildId: r.source?.loopId ?? null,
        revision: r.source?.revision ?? null,
      })),
    }
  })
}
