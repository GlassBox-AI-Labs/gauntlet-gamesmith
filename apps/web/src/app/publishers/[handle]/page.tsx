import * as catalogApi from '@gauntlet/data/api/catalog'
import { createAnonClient } from '@/lib/supabase-anon'
import { captureServerError } from '@/lib/capture'
import { GameGrid } from '@/components/features/catalog/game-grid'
export const dynamic = 'force-dynamic'
export default async function PublisherPage({
  params,
}: {
  params: Promise<{ handle: string }>
}) {
  const { handle } = await params,
    games = (
      await catalogApi.publicGames(createAnonClient(), captureServerError)
    ).filter((g) => g.publisher.handle === handle)
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
