import { useEffect, useRef, useState } from 'react'
import { ArrowLeft } from 'lucide-react'
import { PublishedGameEditor } from './PublishedGameEditor'
import { Button } from '@gauntlet/ui/button'
import { Badge } from '@gauntlet/ui/badge'
import { PublishedGameCover } from './PublishedGameCover'
import type {
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
  onBack,
}: {
  game: PublishedGame
  refresh: () => Promise<void>
  onBack?: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [preview, setPreview] = useState<PublicationPreview | null>(null)
  const [editing, setEditing] = useState(false)
  const alive = useRef(true)
  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => {
    if (!editing) heading.current?.focus()
  }, [editing])
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
  if (editing)
    return (
      <PublishedGameEditor
        game={game}
        onCancel={() => setEditing(false)}
        onSaved={async () => {
          await refresh()
          if (!alive.current) return
          setNotice('Listing saved. The playable release is unchanged.')
          setEditing(false)
        }}
      />
    )
  return (
    <section className="space-y-5" aria-label={`Manage ${game.title}`}>
      {onBack && (
        <Button variant="ghost" disabled={busy} onClick={onBack}>
          <ArrowLeft /> All my games
        </Button>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <h2
          ref={heading}
          tabIndex={-1}
          className="mr-auto text-2xl font-semibold outline-none"
        >
          {game.title}
        </h2>
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
      <div className="flex flex-wrap gap-3">
        <Button
          variant="outline"
          data-testid="listing-edit"
          disabled={busy}
          onClick={() => {
            setPreview(null)
            setError('')
            setNotice('')
            setEditing(true)
          }}
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
      <PublishedGameCover game={game} />
      <div className="grid gap-5 sm:grid-cols-2">
        <div className="space-y-2">
          <h3 className="text-lg font-medium">About this game</h3>
          <p className="whitespace-pre-wrap break-words text-sm text-muted-foreground">
            {game.description || 'No description yet.'}
          </p>
        </div>
        <div className="space-y-2">
          <h3 className="text-lg font-medium">Controls</h3>
          <p className="whitespace-pre-wrap break-words text-sm text-muted-foreground">
            {game.controls || 'No controls provided yet.'}
          </p>
        </div>
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
            {release.status} · {new Date(release.createdAt).toLocaleString()}
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
            The private preview opened in your browser. Publish after checking
            this version.
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
    </section>
  )
}
