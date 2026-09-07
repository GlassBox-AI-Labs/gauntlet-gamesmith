import { useEffect, useState } from 'react'
import type { PublishedGame } from '../../../shared/publishing'
export function PublishedGameCover({
  game,
  preview,
}: {
  game: PublishedGame
  preview?: string
}) {
  const [cover, setCover] = useState<string | null>(null)
  const [error, setError] = useState(false)
  useEffect(() => {
    let disposed = false
    setCover(null)
    setError(false)
    if (game.hasCover && !preview)
      void window.publishing
        .cover(game.gameId)
        .then((result) => {
          if (disposed) return
          if (result.ok) setCover(result.value)
          else setError(true)
        })
        .catch(() => {
          if (!disposed) setError(true)
        })
    return () => {
      disposed = true
    }
  }, [game.gameId, game.generation, game.hasCover, preview])
  return (
    <div className="flex aspect-video items-center justify-center overflow-hidden rounded-lg border bg-secondary">
      {preview || cover ? (
        <img
          src={preview ?? cover!}
          alt=""
          className="size-full object-contain"
        />
      ) : (
        <span className="p-4 text-sm text-muted-foreground">
          {error
            ? 'Cover unavailable'
            : game.hasCover
              ? 'Loading cover…'
              : game.title}
        </span>
      )}
    </div>
  )
}
