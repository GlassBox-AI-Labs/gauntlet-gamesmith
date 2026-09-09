import { publicGames } from '@/lib/public-games'
import { socialMetadata } from '@/lib/social-metadata'
import { GameGrid } from '@/components/features/catalog/game-grid'
export const dynamic = 'force-dynamic'
export const metadata = socialMetadata({ path: '/games' })
export default async function CatalogPage() {
  const games = await publicGames()
  return (
    <>
      <p className="mb-4 text-xs uppercase tracking-widest text-muted-foreground">
        Independent games. Open doors.
      </p>
      <h1 className="text-4xl font-semibold tracking-tight sm:text-6xl">
        Made here. Played here.
      </h1>
      <p className="mb-14 mt-6 text-lg text-muted-foreground">
        Small worlds, big ideas. Pick a game and jump in.
      </p>
      <div className="mb-7 flex items-center justify-between border-b pb-5">
        <h2 className="text-xl">
          The collection{' '}
          <span className="ml-2 text-sm text-muted-foreground">
            {games.length}
          </span>
        </h2>
        <span className="text-xs text-muted-foreground">
          No account needed to play
        </span>
      </div>
      <GameGrid games={games} />
    </>
  )
}
