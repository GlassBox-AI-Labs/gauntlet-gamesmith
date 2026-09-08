import { useState, type ReactNode } from 'react'
import { Button } from '@gauntlet/ui/button'
import { PublisherAccountForm } from './PublisherAccountForm'
import { usePublisherLibrary } from '@/lib/publisher-library'
import type { PublisherLibrary } from '../../../shared/publishing'

export function PublisherWorkspace({
  children,
}: {
  children: (
    library: PublisherLibrary,
    refresh: () => Promise<void>,
  ) => ReactNode
}) {
  const { data, error, loading, refresh } = usePublisherLibrary()
  const [accountBusy, setAccountBusy] = useState(false)
  const [accountError, setAccountError] = useState('')
  async function signOut() {
    setAccountBusy(true)
    setAccountError('')
    try {
      const result = await window.publishing.signOut()
      if (!result.ok) throw new Error(result.error)
      await refresh(true)
    } catch (cause) {
      setAccountError(
        cause instanceof Error ? cause.message : 'Sign-out failed.',
      )
    } finally {
      setAccountBusy(false)
    }
  }
  return (
    <div className="space-y-5">
      {(error || accountError) && (
        <p role="alert" className="text-sm text-destructive">
          {error || accountError}
        </p>
      )}
      {loading && !data && (
        <p role="status" className="text-sm text-muted-foreground">
          Loading publisher account…
        </p>
      )}
      {(data?.status.connected || error) && (
        <div className="flex flex-wrap items-center gap-3">
          <span className="mr-auto text-sm text-muted-foreground">
            {data?.status.publisherName ?? 'Publisher account unavailable'}
          </span>
          <Button
            variant="outline"
            disabled={loading || accountBusy}
            onClick={() => void refresh()}
          >
            Refresh
          </Button>
          <Button
            variant="ghost"
            data-testid="publishing-sign-out"
            disabled={accountBusy}
            onClick={() => void signOut()}
          >
            Sign out
          </Button>
        </div>
      )}
      {data && !data.status.connected && (
        <PublisherAccountForm
          onBusyChange={setAccountBusy}
          onConnected={async () => {
            await refresh(true)
          }}
        />
      )}
      {data?.status.connected && children(data, () => refresh())}
    </div>
  )
}
