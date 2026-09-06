import { useEffect, useState } from 'react'
import type {
  PublicationPreview,
  PublisherStatus,
  ReleaseHistory,
} from '../../../shared/publishing'
import { Button } from '@gauntlet/ui/button'
import { Input } from '@gauntlet/ui/input'
import { Badge } from '@gauntlet/ui/badge'
import { Brand } from '@gauntlet/ui/brand'
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@gauntlet/ui/sheet'
import appLogo from '../../../../build/icon.png'
export function PublishDialog({
  loopId,
  round,
  title,
  onClose,
}: {
  loopId: string
  round: number
  title: string
  onClose: () => void
}): React.JSX.Element {
  const [status, setStatus] = useState<PublisherStatus | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('')
  const [preview, setPreview] = useState<PublicationPreview | null>(null),
    [history, setHistory] = useState<ReleaseHistory | null>(null),
    [tab, setTab] = useState<'build' | 'releases'>('build')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [signingIn, setSigningIn] = useState(false)
  const [draft, setDraft] = useState({
    title,
    slug: title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 64),
    description: '',
    controls: '',
    coverPath: '',
    outputDir: 'dist',
  })
  async function refresh() {
    const result = await window.publishing.history(loopId)
    if (!result.ok) throw new Error(result.error)
    setHistory(result.value)
  }
  async function work(fn: () => Promise<void>) {
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await fn()
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Publishing failed.')
    } finally {
      setBusy(false)
    }
  }
  useEffect(() => {
    void work(async () => {
      const result = await window.publishing.status()
      if (!result.ok) throw new Error(result.error)
      setStatus(result.value)
      if (result.value.connected) await refresh()
    })
  }, [loopId])
  async function publish() {
    if (!preview) return
    const result = await window.publishing.publish({
      loopId,
      releaseId: preview.releaseId,
      gameId: preview.gameId,
      generation: preview.generation,
    })
    if (!result.ok) throw new Error(result.error)
    setPreview(null)
    await refresh()
    setTab('releases')
    setNotice(`Published: ${result.value}`)
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
          <Brand
            logo={<img src={appLogo} alt="" className="size-8" />}
            suffix="publishing"
          />
          <SheetTitle>Publish round {round}</SheetTitle>
          <SheetDescription>
            Build a saved round, preview it, then publish to the arcade.
          </SheetDescription>
        </SheetHeader>
        <div className="space-y-5 px-6 pb-8">
          {error && (
            <p
              role="alert"
              className="rounded-lg border border-destructive p-3 text-sm text-destructive"
            >
              {error}
            </p>
          )}
          {notice && (
            <p
              role="status"
              className="select-all rounded-lg border bg-secondary p-3 text-sm"
            >
              {notice}
            </p>
          )}
          {!status?.connected ? (
            <form
              className="space-y-4"
              onSubmit={(event) => {
                event.preventDefault()
                setSigningIn(true)
                void work(async () => {
                  try {
                    const result = await window.publishing.signIn({
                      email,
                      password,
                    })
                    if (!result.ok) throw new Error(result.error)
                    setStatus(result.value)
                    await refresh()
                  } finally {
                    setPassword('')
                    setSigningIn(false)
                  }
                })
              }}
            >
              <p className="text-sm text-muted-foreground">
                Sign in with your provisioned developer account. Creating and
                playing games locally needs no publisher account.
              </p>
              <label className="grid gap-2 text-sm">
                Email
                <Input
                  data-testid="publishing-email"
                  type="email"
                  autoComplete="username"
                  required
                  maxLength={254}
                  disabled={busy}
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                />
              </label>
              <label className="grid gap-2 text-sm">
                Password
                <Input
                  data-testid="publishing-password"
                  type="password"
                  autoComplete="current-password"
                  required
                  maxLength={200}
                  disabled={busy}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
              </label>
              <div className="flex gap-3">
                <Button
                  data-testid="publishing-sign-in"
                  type="submit"
                  disabled={busy}
                >
                  {signingIn ? 'Signing in…' : 'Sign in to publish'}
                </Button>
                {signingIn && (
                  <Button
                    data-testid="publishing-cancel-sign-in"
                    type="button"
                    variant="outline"
                    onClick={() =>
                      void window.publishing
                        .cancelSignIn()
                        .then((result) => {
                          if (!result.ok) setError(result.error)
                        })
                        .catch(() => setError('Unable to cancel sign-in.'))
                    }
                  >
                    Cancel sign-in
                  </Button>
                )}
              </div>
            </form>
          ) : (
            <>
              <div className="flex items-center justify-between gap-4">
                <span className="text-sm text-muted-foreground">
                  {status.publisherName}
                </span>
                <Button
                  data-testid="publishing-sign-out"
                  variant="ghost"
                  disabled={busy}
                  onClick={() =>
                    void work(async () => {
                      const result = await window.publishing.signOut()
                      if (!result.ok) throw new Error(result.error)
                      setStatus({ ...status, connected: false })
                      setHistory(null)
                      setPreview(null)
                    })
                  }
                >
                  Sign out
                </Button>
              </div>
              <div className="flex gap-3">
                <Button
                  data-testid="publishing-build-tab"
                  variant={tab === 'build' ? 'secondary' : 'ghost'}
                  aria-pressed={tab === 'build'}
                  disabled={busy}
                  onClick={() => setTab('build')}
                >
                  Publish this round
                </Button>
                <Button
                  data-testid="publishing-releases-tab"
                  variant={tab === 'releases' ? 'secondary' : 'ghost'}
                  aria-pressed={tab === 'releases'}
                  disabled={busy}
                  onClick={() =>
                    void work(async () => {
                      await refresh()
                      setTab('releases')
                    })
                  }
                >
                  Releases
                </Button>
              </div>
              {tab === 'build' ? (
                <form
                  className="grid gap-4"
                  onSubmit={(event) => {
                    event.preventDefault()
                    void work(async () => {
                      const result = await window.publishing.prepare({
                        loopId,
                        round,
                        ...draft,
                      })
                      if (!result.ok) throw new Error(result.error)
                      setPreview(result.value)
                      await refresh()
                    })
                  }}
                >
                  {(
                    [
                      ['title', 'Title'],
                      ['slug', 'Game URL slug'],
                      ['description', 'Description'],
                      ['controls', 'Controls'],
                      ['coverPath', 'Cover path inside build (optional)'],
                      ['outputDir', 'Build output folder'],
                    ] as const
                  ).map(([key, label]) => (
                    <label key={key} className="grid gap-2 text-sm">
                      {label}
                      <Input
                        data-testid={`publishing-${key}`}
                        required={[
                          'title',
                          'slug',
                          'description',
                          'outputDir',
                        ].includes(key)}
                        disabled={busy || !!preview}
                        value={draft[key]}
                        onChange={(event) =>
                          setDraft({ ...draft, [key]: event.target.value })
                        }
                      />
                    </label>
                  ))}
                  {!preview && (
                    <Button
                      data-testid="publishing-build"
                      disabled={busy}
                      type="submit"
                    >
                      {busy
                        ? 'Building and uploading…'
                        : 'Build & open private preview'}
                    </Button>
                  )}
                </form>
              ) : (
                <section className="space-y-5">
                  <div className="flex flex-wrap items-center gap-3">
                    <h2 className="font-semibold">Release history</h2>
                    <Badge variant="secondary">
                      {history?.currentReleaseId ? 'Live' : 'Unpublished'}
                    </Badge>
                    {history?.currentReleaseId && (
                      <Button
                        data-testid="publishing-unpublish"
                        variant="outline"
                        disabled={busy}
                        onClick={() =>
                          void work(async () => {
                            const result = await window.publishing.unpublish({
                              loopId,
                              generation: history.generation,
                            })
                            if (!result.ok) throw new Error(result.error)
                            await refresh()
                            setPreview(null)
                          })
                        }
                      >
                        Unpublish
                      </Button>
                    )}
                  </div>
                  {history?.gameUrl && (
                    <p className="select-all break-all text-sm text-muted-foreground">
                      {history.gameUrl}
                    </p>
                  )}
                  {!history?.releases.length && (
                    <p className="text-sm text-muted-foreground">
                      No releases yet. Build and preview this saved round to
                      begin.
                    </p>
                  )}
                  {history?.releases.map((release) => (
                    <div
                      key={release.id}
                      className="space-y-3 rounded-lg border bg-card p-4"
                    >
                      <div className="flex flex-wrap justify-between gap-3">
                        <h3 className="font-medium">{release.title}</h3>
                        {history.currentReleaseId === release.id && (
                          <Badge>Current</Badge>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {release.round
                          ? `Round ${release.round} · ${release.revision?.slice(0, 12)} · `
                          : ''}
                        {release.status}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {new Date(release.createdAt).toLocaleString()}
                      </p>
                      <Button
                        data-testid={`publishing-preview-${release.id}`}
                        variant="outline"
                        disabled={busy || release.status !== 'ready'}
                        onClick={() =>
                          void work(async () => {
                            const result =
                              await window.publishing.previewRelease({
                                loopId,
                                releaseId: release.id,
                              })
                            if (!result.ok) throw new Error(result.error)
                            setPreview(result.value)
                          })
                        }
                      >
                        Preview
                        {history.currentReleaseId !== release.id
                          ? ' / publish'
                          : ''}
                      </Button>
                    </div>
                  ))}
                </section>
              )}
              {preview && (
                <section className="space-y-4 rounded-lg border bg-card p-4">
                  <p className="text-sm text-muted-foreground">
                    The private preview opened in your browser. Publish only
                    after checking this version.
                  </p>
                  <div className="flex gap-3">
                    <Button
                      data-testid="publishing-promote"
                      disabled={busy}
                      onClick={() => void work(publish)}
                    >
                      {busy ? 'Publishing…' : 'Publish this version'}
                    </Button>
                    <Button
                      data-testid="publishing-edit"
                      variant="outline"
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
        </div>
      </SheetContent>
    </Sheet>
  )
}
