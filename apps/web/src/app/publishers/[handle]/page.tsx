import type { Metadata } from 'next'
import { publicGames } from '@/lib/public-games'
import { socialMetadata } from '@/lib/social-metadata'
import { GameGrid } from '@/components/features/catalog/game-grid'
export const dynamic = 'force-dynamic'
type Props = {
  params: Promise<{ handle: string }>
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { handle } = await params
  const game = (await publicGames()).find(
    (game) => game.publisher.handle === handle,
  )
  const name = game?.publisher.display_name ?? handle
  return socialMetadata({
    title: `Games by ${name}`,
    description: `Discover games by ${name} on Glassbox Arcade. Play instantly in your browser, no account required.`,
    path: `/publishers/${encodeURIComponent(handle)}`,
  })
}

export default async function PublisherPage({ params }: Props) {
  const { handle } = await params,
    games = (await publicGames()).filter((g) => g.publisher.handle === handle)
  return (
    <>
      <h1 className="text-4xl font-semibold">
        {games[0]?.publisher.display_name ?? handle}
      </h1>
      <p className="mb-10 mt-4 text-muted-foreground">
        Games from this publisher.
      </p>
      <GameGrid games={games} />
    </>
  )
}
