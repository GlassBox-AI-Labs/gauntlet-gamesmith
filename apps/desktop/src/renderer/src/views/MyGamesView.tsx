import { useEffect, useRef, useState } from 'react'
import { Button } from '@gauntlet/ui/button'
import { Badge } from '@gauntlet/ui/badge'
import { PublisherWorkspace } from './PublisherWorkspace'
import { PublishedGameManager } from './PublishedGameManager'
import { PublishedGameCover } from './PublishedGameCover'
export function MyGamesView() {
  const [openError, setOpenError] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const lastSelected = useRef<HTMLButtonElement | null>(null)
  const lastGameId = useRef<string | null>(null)
  useEffect(
    () =>
      window.publishing.onChanged((kind) => {
        if (kind === 'account') {
          setSelected(null)
          setOpenError('')
        }
      }),
    [],
  )
  useEffect(() => {
    if (!selected) lastSelected.current?.focus()
  }, [selected])
  return (
    <main className="mx-auto w-full max-w-5xl space-y-6 p-8">
      {!selected && (
        <>
          <h1 className="text-3xl font-semibold">My games</h1>
          <p className="text-muted-foreground">
            All games owned by your publisher account, across every build and
            computer.
          </p>
        </>
      )}
      {openError && (
        <p role="alert" className="text-sm text-destructive">
          {openError}
        </p>
      )}
      <PublisherWorkspace>
        {(library, refresh) => {
          const game = library.games.find((g) => g.gameId === selected)
          return game ? (
            <PublishedGameManager
              key={game.gameId}
              game={game}
              refresh={refresh}
              onBack={() => setSelected(null)}
            />
          ) : (
            <>
              {!library.games.length && (
                <p className="rounded-lg border p-8 text-muted-foreground">
                  No games yet. Publish a saved round from a build to add your
                  first game.
                </p>
              )}
              <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
                {library.games.map((game) => (
                  <article
                    key={game.gameId}
                    className="relative rounded-xl border p-4 transition-colors duration-150 hover:bg-secondary focus-within:bg-secondary"
                  >
                    <button
                      type="button"
                      data-testid={`my-game-${game.gameId}`}
                      ref={(node) => {
                        if (game.gameId === lastGameId.current)
                          lastSelected.current = node
                      }}
                      onClick={(event) => {
                        lastSelected.current = event.currentTarget
                        lastGameId.current = game.gameId
                        setOpenError('')
                        setSelected(game.gameId)
                      }}
                      className="w-full space-y-3 text-left outline-none after:absolute after:inset-0 after:rounded-xl focus-visible:after:ring-2 focus-visible:after:ring-ring"
                    >
                      <PublishedGameCover game={game} />
                      <h2 className="text-lg font-medium">{game.title}</h2>
                      <Badge variant="secondary">
                        {game.currentReleaseId ? 'Published' : 'Unpublished'}
                      </Badge>
                      <p className="text-sm text-muted-foreground">
                        Manage game →
                      </p>
                    </button>
                    {game.currentReleaseId && (
                      <Button
                        className="relative z-10 mt-3"
                        variant="outline"
                        onClick={() => {
                          setOpenError('')
                          void window.publishing
                            .openGame(game.gameId)
                            .then((result) => {
                              if (!result.ok) setOpenError(result.error)
                            })
                            .catch(() =>
                              setOpenError('Could not open this game.'),
                            )
                        }}
                      >
                        Open game
                      </Button>
                    )}
                  </article>
                ))}
              </div>
            </>
          )
        }}
      </PublisherWorkspace>
    </main>
  )
}
