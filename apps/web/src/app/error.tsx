'use client'
import { useEffect } from 'react'
import { Button } from '@gauntlet/ui/button'
import { captureClientError } from '@/lib/capture'
export default function ErrorPage({
  error,
  reset,
}: {
  error: Error
  reset: () => void
}) {
  useEffect(() => captureClientError(error, 'catalog.render'), [error])
  return (
    <div className="space-y-5">
      <h1 className="text-3xl">The arcade is temporarily unavailable.</h1>
      <p className="text-muted-foreground">Please try again in a moment.</p>
      <Button data-testid="catalog-retry" onClick={reset}>
        Try again
      </Button>
    </div>
  )
}
