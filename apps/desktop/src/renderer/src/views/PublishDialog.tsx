import { useEffect, useState } from 'react'
import { Button } from '@gauntlet/ui/button'
import { Input } from '@gauntlet/ui/input'
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@gauntlet/ui/sheet'
import { PublisherWorkspace } from './PublisherWorkspace'
import { PublishedGameManager, operationValue } from './PublishedGameManager'
import type { PublicationPreview } from '../../../shared/publishing'
export function PublishDialog({
  buildId,
  round,
  title,
  initialTab = 'build',
  onClose,
}: {
  buildId: string
  round: number
  title: string
  initialTab?: 'build' | 'releases'
  onClose: () => void
}) {
  const liveWorkspace = round === 0
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [tab, setTab] = useState<'build' | 'releases'>(initialTab)
  const [preview, setPreview] = useState<PublicationPreview | null>(null)
  const [draft, setDraft] = useState({
    title,
    slug: title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 64),
    description: '',
    controls: '',
  })
  useEffect(
    () =>
      window.publishing.onChanged((kind) => {
        if (kind === 'account') {
          setPreview(null)
          setError('')
        }
      }),
    [],
  )
  async function work(fn: () => Promise<void>) {
    setBusy(true)
    setError('')
    try {
      await fn()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Publishing failed.')
    } finally {
      setBusy(false)
    }
  }
  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose()
      }}
    >
      <SheetContent
        className="overflow-y-auto"
        onEscapeKeyDown={(event) => {
          if (busy) event.preventDefault()
        }}
        onInteractOutside={(event) => {
          if (busy) event.preventDefault()
        }}
      >
        <SheetHeader>
          <SheetTitle>
            {tab === 'releases'
              ? 'Manage game'
              : liveWorkspace
                ? 'Publish live workspace'
                : `Publish round ${round}`}
          </SheetTitle>
          <SheetDescription>
            {liveWorkspace
              ? 'Snapshot the current project folder, preview it, then publish to the arcade. This includes edits made outside the build.'
              : "Preview a saved round or manage this game's published listing and releases."}
          </SheetDescription>
        </SheetHeader>
        <div className="space-y-5 px-6 pb-8">
          <PublisherWorkspace>
            {(library, refresh) => {
              const game = library.games.find((g) =>
                g.releases.some((r) => r.buildId === buildId),
              )
              return (
                <>
                  <div className="flex gap-3">
                    <Button
                      variant={tab === 'build' ? 'secondary' : 'ghost'}
                      disabled={busy}
                      onClick={() => setTab('build')}
                      aria-pressed={tab === 'build'}
                    >
                      {liveWorkspace ? 'Publish this folder' : 'Publish this round'}
                    </Button>
                    <Button
                      data-testid="publishing-releases-tab"
                      variant={tab === 'releases' ? 'secondary' : 'ghost'}
                      disabled={busy}
                      onClick={() => {
                        setTab('releases')
                        setPreview(null)
                      }}
                      aria-pressed={tab === 'releases'}
                    >
                      Releases
                    </Button>
                  </div>
                  {error && (
                    <p role="alert" className="text-sm text-destructive">
                      {error}
                    </p>
                  )}
                  {tab === 'releases' ? (
                    game ? (
                      <PublishedGameManager
                        key={game.gameId}
                        game={game}
                        refresh={refresh}
                      />
                    ) : (
                      <p className="text-sm text-muted-foreground">
                        No releases yet.{' '}
                        {liveWorkspace
                          ? 'Preview this folder to begin.'
                          : 'Preview this saved round to begin.'}
                      </p>
                    )
                  ) : (
                    <>
                      <form
                        className="grid gap-4"
                        onSubmit={(event) => {
                          event.preventDefault()
                          void work(async () => {
                            setPreview(
                              operationValue(
                                await window.publishing.prepare({
                                  buildId,
                                  round,
                                  ...draft,
                                }),
                              ),
                            )
                            await refresh()
                          })
                        }}
                      >
                        {(
                          [
                            ['title', 'Title'],
                            ['slug', 'Game URL slug'],
                            ['description', 'Description (optional)'],
                            ['controls', 'Controls (optional)'],
                          ] as const
                        ).map(([key, label]) => (
                          <label key={key} className="grid gap-2 text-sm">
                            {label}
                            <Input
                              data-testid={`publishing-${key}`}
                              required={key === 'title' || key === 'slug'}
                              disabled={busy || !!preview}
                              value={draft[key]}
                              onChange={(event) =>
                                setDraft({
                                  ...draft,
                                  [key]: event.target.value,
                                })
                              }
                            />
                          </label>
                        ))}
                        <p className="text-sm text-muted-foreground">
                          The main menu is captured automatically as the default
                          cover. You can change it later in Edit listing.
                        </p>
                        {!preview && (
                          <Button
                            data-testid="publishing-build"
                            type="submit"
                            disabled={busy}
                          >
                            {busy ? 'Preparing preview…' : 'Preview game'}
                          </Button>
                        )}
                      </form>
                      {preview && (
                        <section className="space-y-4 rounded-lg border p-4">
                          <p className="text-sm">
                            The private preview opened in your browser. Publish
                            after checking this version.
                          </p>
                          <div className="flex gap-3">
                            <Button
                              data-testid="publishing-promote"
                              disabled={busy}
                              onClick={() =>
                                void work(async () => {
                                  operationValue(
                                    await window.publishing.publish({
                                      ...preview,
                                      buildId,
                                    }),
                                  )
                                  setPreview(null)
                                  setTab('releases')
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
                              Back
                            </Button>
                          </div>
                        </section>
                      )}
                    </>
                  )}
                </>
              )
            }}
          </PublisherWorkspace>
        </div>
      </SheetContent>
    </Sheet>
  )
}
