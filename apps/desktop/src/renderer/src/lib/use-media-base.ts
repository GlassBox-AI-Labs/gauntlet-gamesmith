import { useCallback, useEffect, useState } from 'react'

let pending: ReturnType<typeof window.loops.mediaBase> | null = null

function requestMediaBase(): ReturnType<typeof window.loops.mediaBase> {
  pending ??= window.loops.mediaBase().catch((error: unknown) => {
    pending = null
    throw error
  })
  return pending
}

function message(error: unknown): string {
  return error instanceof Error && error.message ? error.message : 'IPC request failed.'
}

/** Share media-server discovery while exposing failure and an explicit retry. */
export function useMediaBase(): { base: string | null; error: string | null; retry: () => void } {
  const [base, setBase] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let disposed = false
    void requestMediaBase().then((result) => {
      if (disposed) return
      setBase(result.ok ? result.value : null)
      setError(result.ok ? null : result.error)
    }).catch((cause: unknown) => {
      if (!disposed) setError(`Could not connect to the media server: ${message(cause)}`)
    })
    return () => { disposed = true }
  }, [attempt])

  const retry = useCallback(() => {
    pending = null
    setError(null)
    setAttempt((current) => current + 1)
  }, [])

  return { base, error, retry }
}
