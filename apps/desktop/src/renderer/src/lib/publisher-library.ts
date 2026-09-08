import { useCallback, useEffect, useRef, useState } from 'react'
import type { PublisherLibrary } from '../../../shared/publishing'

export function usePublisherLibrary() {
  const [data, setData] = useState<PublisherLibrary | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const generation = useRef(0)
  const refresh = useCallback(async (clear = false) => {
    const request = ++generation.current
    if (clear) setData(null)
    setLoading(true)
    setError('')
    try {
      const result = await window.publishing.library()
      if (request !== generation.current) return
      if (!result.ok) throw new Error(result.error)
      setData(result.value)
    } catch (cause) {
      if (request !== generation.current) return
      setData(null)
      setError(
        cause instanceof Error
          ? cause.message
          : 'Publication information is unavailable.',
      )
    } finally {
      if (request === generation.current) setLoading(false)
    }
  }, [])
  useEffect(() => {
    void refresh(true)
    const remove = window.publishing.onChanged((kind) => {
      void refresh(kind === 'account')
    })
    const focused = () => {
      void refresh()
    }
    window.addEventListener('focus', focused)
    return () => {
      generation.current++
      remove()
      window.removeEventListener('focus', focused)
    }
  }, [refresh])
  return { data, error, loading, refresh }
}
