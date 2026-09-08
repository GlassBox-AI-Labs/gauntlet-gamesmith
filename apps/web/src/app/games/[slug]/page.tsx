import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { publicGames } from '@/lib/public-games'
import { socialMetadata } from '@/lib/social-metadata'
import { gameOrigin } from '@/lib/config'
import { GamePlayer } from '@/components/features/catalog/game-player'
export const dynamic = 'force-dynamic'
type Props = {
  params: Promise<{ slug: string }>
}

async function findGame(slug: string) {
  const game = (await publicGames()).find((game) => game.slug === slug)
  if (!game) notFound()
  return game
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params
  const game = await findGame(slug)
  const coverPath = game.listing.coverPath
    ?.split('/')
    .map(encodeURIComponent)
    .join('/')
  return socialMetadata({
    title: game.listing.title,
    description: game.listing.description,
    path: `/games/${encodeURIComponent(game.slug)}`,
    image: coverPath
      ? {
          url: `${await gameOrigin()}/play/${game.id}/${game.current_release_id}/${coverPath}`,
          alt: `${game.listing.title} — cover art`,
        }
      : undefined,
  })
}

export default async function GamePage({ params }: Props) {
  const { slug } = await params,
    game = await findGame(slug)
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
