const HOSTED_CATALOG = 'https://gauntletgamesmith.com'
const HOSTED_GAMES = 'https://glassbox-games.vercel.app'

/** Resolve the API and preview hosts together so hosted publishing works out of the box. */
export function publishingConfig(env: {
  GAUNTLET_CATALOG_URL?: string
  GAUNTLET_GAME_ORIGIN?: string
  GAUNTLET_GAME_PORT?: string
}) {
  const catalogUrl = new URL(env.GAUNTLET_CATALOG_URL ?? HOSTED_CATALOG).origin
  const games = new URL(env.GAUNTLET_GAME_ORIGIN ?? (
    catalogUrl === HOSTED_CATALOG ? HOSTED_GAMES : catalogUrl
  ))
  if (!env.GAUNTLET_GAME_ORIGIN && catalogUrl !== HOSTED_CATALOG)
    games.port = env.GAUNTLET_GAME_PORT ?? '4311'
  return { catalogUrl, gameOrigin: games.origin }
}
