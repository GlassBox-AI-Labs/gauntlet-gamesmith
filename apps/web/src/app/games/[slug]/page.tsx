import Link from 'next/link'
import { notFound } from 'next/navigation'
import * as catalogApi from '@gauntlet/data/api/catalog'
import { createAnonClient } from '@/lib/supabase-anon'
import { captureServerError } from '@/lib/capture'
import { gameOrigin } from '@/lib/config'
import { GamePlayer } from '@/components/features/catalog/game-player'
export const dynamic = 'force-dynamic'
export default async function GamePage({
  params,
}: {
  params: Promise<{ slug: string }>
}) {
  const { slug } = await params,
    game = (
      await catalogApi.publicGames(createAnonClient(), captureServerError)
    ).find((g) => g.slug === slug)
  if (!game) notFound()
  return (
    <>
      <Link
        data-testid="game-browse"
        href="/"
        className="text-sm text-muted-foreground"
      >
        ← All games
      </Link>
      <h1 className="mb-3 mt-8 text-4xl font-semibold">{game.listing.title}</h1>
      <p className="mb-8 text-muted-foreground">
        By{' '}
        <Link
          data-testid="game-publisher"
          href={`/publishers/${game.publisher.handle}`}
        >
          {game.publisher.display_name}
        </Link>
      </p>
      <GamePlayer
        url={`${await gameOrigin()}/play/${game.id}/${game.current_release_id}/index.html`}
        title={game.listing.title}
      />
      <section className="mt-10 grid gap-8 sm:grid-cols-2">
        <div>
          <h2 className="text-xl">About the game</h2>
          <p className="mt-3 text-muted-foreground">
            {game.listing.description}
          </p>
        </div>
        <div>
          <h2 className="text-xl">How to play</h2>
          <p className="mt-3 text-muted-foreground">
            {game.listing.controls || 'Follow the instructions in the game.'}
          </p>
        </div>
      </section>
    </>
  )
}
