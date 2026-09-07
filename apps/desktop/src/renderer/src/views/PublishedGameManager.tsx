import { useEffect, useRef, useState } from 'react'
import { Button } from '@gauntlet/ui/button'
import { Badge } from '@gauntlet/ui/badge'
import { PublishedGameCover } from './PublishedGameCover'
import type {
  CoverSelection,
  PublicationPreview,
  PublishedGame,
} from '../../../shared/publishing'
import type { OperationResult } from '../../../shared/result'

export function operationValue<T>(result: OperationResult<T>): T {
  if (!result.ok) throw new Error(result.error)
  return result.value
}
export function PublishedGameManager({
  game,
  refresh,
}: {
  game: PublishedGame
  refresh: () => Promise<void>
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [preview, setPreview] = useState<PublicationPreview | null>(null)
  const [editing, setEditing] = useState(false)
  const [description, setDescription] = useState(game.description)
  const [controls, setControls] = useState(game.controls)
  const [editGeneration, setEditGeneration] = useState(game.generation)
  const [cover, setCover] = useState<CoverSelection | null>(null)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  useEffect(() => {
    setPreview(null)
  }, [game.generation])
  async function work(operation: () => Promise<void>) {
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await operation()
    } catch (cause) {
      if (alive.current)
        setError(cause instanceof Error ? cause.message : 'Publishing failed.')
    } finally {
      if (alive.current) setBusy(false)
    }
  }
  function edit() {
    setDescription(game.description)
    setControls(game.controls)
    setEditGeneration(game.generation)
    setCover(null)
    setPreview(null)
    setEditing(true)
    setError('')
    setNotice('')
  }
  return (
    <section className="space-y-5" aria-label={`Manage ${game.title}`}>
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="mr-auto text-xl font-semibold">{game.title}</h2>
        <Badge>{game.currentReleaseId ? 'Published' : 'Unpublished'}</Badge>
        {game.currentReleaseId && (
          <Button
            variant="outline"
            disabled={busy}
            onClick={() =>
              void work(async () => {
                operationValue(await window.publishing.openGame(game.gameId))
              })
            }
          >
            Open game
          </Button>
        )}
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="text-sm">
          {notice}
        </p>
      )}
      {editing ? (
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault()
            void work(async () => {
              operationValue(
                await window.publishing.updateListing({
                  gameId: game.gameId,
                  generation: editGeneration,
                  description,
                  controls,
                  ...(cover ? { coverSelectionId: cover.id } : {}),
                }),
              )
              if (!alive.current) return
              setEditing(false)
              setCover(null)
              setNotice('Listing saved. The playable release is unchanged.')
              await refresh()
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
          <div className="max-w-md">
            <PublishedGameCover game={game} preview={cover?.dataUrl} />
          </div>
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            data-testid="listing-choose-cover"
            onClick={() =>
              void work(async () => {
                const selected = operationValue(
                  await window.publishing.chooseCover(),
                )
                if (selected && alive.current) setCover(selected)
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
              onClick={() => {
                setEditing(false)
                setCover(null)
                setError('')
              }}
            >
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <>
          <div className="flex flex-wrap gap-3">
            <Button
              variant="outline"
              data-testid="listing-edit"
              disabled={busy}
              onClick={edit}
            >
              Edit listing
            </Button>
            {game.currentReleaseId && (
              <Button
                variant="outline"
                data-testid="publishing-unpublish"
                disabled={busy}
                onClick={() =>
                  void work(async () => {
                    operationValue(
                      await window.publishing.unpublish({
                        gameId: game.gameId,
                        generation: game.generation,
                      }),
                    )
                    setPreview(null)
                    await refresh()
                  })
                }
              >
                Unpublish
              </Button>
            )}
          </div>
          <h3 className="text-lg font-medium">Release history</h3>
          {!game.releases.length && (
            <p className="text-sm text-muted-foreground">No releases yet.</p>
          )}
          {game.releases.map((release) => (
            <div key={release.id} className="space-y-3 rounded-lg border p-4">
              <div className="flex items-center justify-between gap-3">
                <span>{release.title}</span>
                {game.currentReleaseId === release.id && <Badge>Current</Badge>}
              </div>
              <p className="text-xs text-muted-foreground">
                {release.round
                  ? `Round ${release.round} · ${release.revision?.slice(0, 12)} · `
                  : ''}
                {release.status} ·{' '}
                {new Date(release.createdAt).toLocaleString()}
              </p>
              <Button
                variant="outline"
                disabled={busy || release.status !== 'ready'}
                data-testid={`publishing-preview-${release.id}`}
                onClick={() =>
                  void work(async () => {
                    const result = operationValue(
                      await window.publishing.previewRelease({
                        gameId: game.gameId,
                        releaseId: release.id,
                      }),
                    )
                    if (alive.current) setPreview(result)
                  })
                }
              >
                Preview
                {game.currentReleaseId !== release.id ? ' / publish' : ''}
              </Button>
            </div>
          ))}
          {preview && (
            <div className="space-y-3 rounded-lg border p-4">
              <p className="text-sm">
                The private preview opened in your browser. Publish after
                checking this version.
              </p>
              <div className="flex gap-3">
                <Button
                  data-testid="publishing-promote"
                  disabled={busy}
                  onClick={() =>
                    void work(async () => {
                      operationValue(await window.publishing.publish(preview))
                      if (!alive.current) return
                      setPreview(null)
                      setNotice('Game published.')
                      await refresh()
                    })
                  }
                >
                  {busy ? 'Publishing…' : 'Publish this version'}
                </Button>
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={() => setPreview(null)}
                >
                  Cancel
                </Button>
              </div>
            </div>
          )}
        </>
      )}
    </section>
  )
}
