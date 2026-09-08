import { useEffect, useRef, useState } from 'react'
import { ArrowLeft } from 'lucide-react'
import { Button } from '@gauntlet/ui/button'
import { PublishedGameCover } from './PublishedGameCover'
import type { CoverSelection, PublishedGame } from '../../../shared/publishing'

export function PublishedGameEditor({
  game,
  onSaved,
  onCancel,
}: {
  game: PublishedGame
  onSaved: () => Promise<void>
  onCancel: () => void
}) {
  const [description, setDescription] = useState(game.description)
  const [controls, setControls] = useState(game.controls)
  const [editGeneration] = useState(game.generation)
  const [cover, setCover] = useState<CoverSelection | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const alive = useRef(true)
  const inFlight = useRef(false)
  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => {
    alive.current = true
    heading.current?.focus()
    return () => {
      alive.current = false
    }
  }, [])
  async function work(operation: () => Promise<void>) {
    if (inFlight.current) return
    inFlight.current = true
    setBusy(true)
    setError('')
    try {
      await operation()
    } catch (cause) {
      if (alive.current)
        setError(
          cause instanceof Error ? cause.message : 'Could not save listing.',
        )
    } finally {
      inFlight.current = false
      if (alive.current) setBusy(false)
    }
  }
  return (
    <section
      className="w-full max-w-sm space-y-5"
      aria-label={`Edit ${game.title}`}
    >
      <Button variant="ghost" disabled={busy} onClick={onCancel}>
        <ArrowLeft /> Back to game
      </Button>
      <div className="space-y-2">
        <h2
          ref={heading}
          tabIndex={-1}
          className="text-2xl font-semibold outline-none"
        >
          Edit listing
        </h2>
        <p className="text-sm text-muted-foreground">{game.title}</p>
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <form
        className="grid gap-4"
        aria-label="Edit listing"
        onSubmit={(event) => {
          event.preventDefault()
          void work(async () => {
            const result = await window.publishing.updateListing({
              gameId: game.gameId,
              generation: editGeneration,
              description,
              controls,
              ...(cover ? { coverSelectionId: cover.id } : {}),
            })
            if (!result.ok) throw new Error(result.error)
            if (!alive.current) return
            await onSaved()
          })
        }}
      >
        <label className="grid gap-2 text-sm">
          Description
          <textarea
            data-testid="listing-description"
            className="min-h-28 rounded-md border bg-background p-3"
            disabled={busy}
            maxLength={2000}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </label>
        <label className="grid gap-2 text-sm">
          Controls
          <textarea
            data-testid="listing-controls"
            className="min-h-20 rounded-md border bg-background p-3"
            disabled={busy}
            maxLength={500}
            value={controls}
            onChange={(e) => setControls(e.target.value)}
          />
        </label>
        <div>
          <PublishedGameCover game={game} preview={cover?.dataUrl} />
        </div>
        <Button
          type="button"
          variant="outline"
          disabled={busy}
          data-testid="listing-choose-cover"
          onClick={() =>
            void work(async () => {
              const result = await window.publishing.chooseCover()
              if (!result.ok) throw new Error(result.error)
              if (result.value && alive.current) setCover(result.value)
            })
          }
        >
          Choose cover image
        </Button>
        <p className="text-xs text-muted-foreground">
          Static PNG, JPEG, WebP, or GIF. Up to 3 MiB and 4096 × 4096 pixels.
        </p>
        <div className="flex gap-3">
          <Button type="submit" disabled={busy} data-testid="listing-save">
            {busy ? 'Saving…' : 'Save listing'}
          </Button>
          <Button
            type="button"
            variant="ghost"
            disabled={busy}
            onClick={onCancel}
          >
            Cancel
          </Button>
        </div>
      </form>
    </section>
  )
}
