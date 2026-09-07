import Link from 'next/link'
import { Badge } from '@gauntlet/ui/badge'
import type { PublicGame } from '@gauntlet/data/contracts'
import { gameOrigin } from '@/lib/config'
export async function GameGrid({ games }: { games: PublicGame[] }) {
  if (!games.length)
    return (
      <div className="rounded-xl border bg-card p-10">
        <h2 className="text-xl font-medium">The first game is on its way.</h2>
        <p className="mt-3 text-muted-foreground">
          Finished a game? Publish a saved round from the desktop app.
        </p>
      </div>
    )
  const origin = await gameOrigin()
  return (
    <div className="grid gap-8 sm:grid-cols-2 lg:grid-cols-3">
      {games.map((game) => (
        <article key={game.id}>
          <Link
            data-testid={`game-${game.slug}`}
            href={`/games/${game.slug}`}
            prefetch={false}
            className="group block"
          >
            <div className="flex aspect-[1.35] items-center justify-center overflow-hidden rounded-xl border bg-card">
              {game.listing.coverPath ? (
                <img
                  src={`${origin}/play/${game.id}/${game.current_release_id}/${game.listing.coverPath}`}
                  alt=""
                  loading="lazy"
                  crossOrigin="anonymous"
                  referrerPolicy="no-referrer"
                  className="size-full object-cover transition-transform group-hover:scale-105"
                />
              ) : (
                <span className="p-8 text-3xl">{game.listing.title}</span>
              )}
            </div>
            <h2 className="mt-5 text-xl font-medium">{game.listing.title}</h2>
            <p className="mt-2 line-clamp-2 text-sm text-muted-foreground">
              {game.listing.description}
            </p>
          </Link>
          <Link
            data-testid={`publisher-${game.slug}`}
            href={`/publishers/${game.publisher.handle}`}
            className="mt-4 inline-block"
          >
            <Badge variant="secondary">By {game.publisher.display_name}</Badge>
          </Link>
        </article>
      ))}
    </div>
  )
}
