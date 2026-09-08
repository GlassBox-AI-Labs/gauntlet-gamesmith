import { useEffect, useState } from 'react'
import { Button } from '@gauntlet/ui/button'
import { Settings2, Upload } from 'lucide-react'
import type { ReleaseHistory } from '../../../shared/publishing'
import { roundPublication } from '@/lib/round-publication'
export function RoundPublication({
  buildId,
  round,
  revision,
  onAction,
  actionTestId,
}: {
  buildId: string
  round: number
  revision: string | null
  onAction: (tab: 'build' | 'releases') => void
  actionTestId: string
}) {
  const [data, setData] = useState<ReleaseHistory | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    let generation = 0
    async function refresh() {
      const request = ++generation
      setData(null)
      setError('')
      try {
        const result = await window.publishing.history(buildId)
        if (request !== generation) return
        if (!result.ok) throw new Error(result.error)
        setData(result.value)
      } catch (cause) {
        if (request === generation)
          setError(
            cause instanceof Error ? cause.message : 'Publication unavailable.',
          )
      }
    }
    void refresh()
    const remove = window.publishing.onChanged(() => {
      void refresh()
    })
    const focused = () => {
      void refresh()
    }
    window.addEventListener('focus', focused)
    return () => {
      generation++
      remove()
      window.removeEventListener('focus', focused)
    }
  }, [buildId])
  const [openError, setOpenError] = useState('')
  const status = roundPublication(data, buildId, round, revision, error)
  return (
    <span className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
      <span
        role="status"
        title={error || undefined}
        data-testid="round-publication"
      >
        {status.text}
      </span>
      {status.gameId && (
        <button
          type="button"
          className="underline underline-offset-4"
          onClick={() => {
            setOpenError('')
            void window.publishing
              .openGame(status.gameId!)
              .then((result) => {
                if (!result.ok) setOpenError(result.error)
              })
              .catch(() => setOpenError('Could not open the published game.'))
          }}
        >
          Open game
        </button>
      )}
      {openError && <span role="alert">{openError}</span>}
      <Button
        variant="outline"
        data-testid={actionTestId}
        disabled={status.loading || !revision}
        onClick={() =>
          onAction(status.action === 'manage' ? 'releases' : 'build')
        }
      >
        {status.action === 'manage' ? <Settings2 /> : <Upload />}
        {status.action === 'manage' ? 'Manage game' : `Publish round ${round}`}
      </Button>
    </span>
  )
}
