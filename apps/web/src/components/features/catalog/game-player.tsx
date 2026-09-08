'use client'
import { useEffect, useRef, useState } from 'react'
import Image from 'next/image'
import { Button } from '@gauntlet/ui/button'
import { GAME_FRAME_SANDBOX } from '@gauntlet/publishing'
import { captureClientError } from '@/lib/capture'
export function GamePlayer({ url, title, cover }: { url: string; title: string; cover?: string }) {
  const [playing, setPlaying] = useState(false),
    [expanded, setExpanded] = useState(false),
    [loading, setLoading] = useState(false),
    [error, setError] = useState(''),
    [restart, setRestart] = useState(0)
  const shell = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!expanded) return
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previous
    }
  }, [expanded])
  async function play() {
    setLoading(true)
    setError('')
    try {
      const response = await fetch(url, { method: 'HEAD', credentials: 'omit' })
      if (!response.ok) throw new Error('Game unavailable')
      setPlaying(true)
      setExpanded(true)
    } catch (error) {
      captureClientError(error, 'player.load')
      setError(
        'This release is unavailable. Refresh the page or request a new preview.',
      )
      setLoading(false)
    }
  }
  async function fullscreen() {
    setExpanded(true)
    try {
      await shell.current?.requestFullscreen()
    } catch (error) {
      captureClientError(error, 'player.fullscreen')
      setError(
        'Browser fullscreen is unavailable. The game still fills this window.',
      )
    }
  }
  async function back() {
    try {
      if (document.fullscreenElement === shell.current)
        await document.exitFullscreen()
      setExpanded(false)
    } catch (error) {
      captureClientError(error, 'player.exit-fullscreen')
      setError('Use Escape to leave browser fullscreen.')
    }
  }
  return (
    <div
      ref={shell}
      className={`player-shell${expanded ? ' player-expanded' : ''}`}
    >
      <div className="player">
        {playing ? (
          <>
            <iframe
              key={`${url}:${restart}`}
              src={url}
              title={title}
              referrerPolicy="no-referrer"
              sandbox={GAME_FRAME_SANDBOX}
              allow="fullscreen; gamepad"
              onLoad={(event) => {
                setLoading(false)
                event.currentTarget.focus()
              }}
            />
            {loading && (
              <p role="status" className="absolute left-4 top-4">
                Loading game…
              </p>
            )}
          </>
        ) : (
          <div data-testid="game-poster" className="absolute inset-0 flex flex-col items-center justify-center gap-6 overflow-hidden p-6">
            {cover && (
              <>
                <Image
                  src={cover}
                  alt=""
                  fill
                  sizes={expanded ? '100vw' : '(min-width: 1280px) 1200px, (min-width: 640px) calc(100vw - 80px), calc(100vw - 40px)'}
                  loading="lazy"
                  crossOrigin="anonymous"
                  referrerPolicy="no-referrer"
                  className="object-cover"
                />
                <div className="absolute inset-0 bg-background/60" />
              </>
            )}
            <h2 className="relative text-center text-2xl">{title}</h2>
            <Button
              className="relative"
              data-testid="game-play"
              disabled={loading}
              onClick={() => void play()}
            >
              {loading ? 'Loading…' : 'Play game'}
            </Button>
          </div>
        )}
      </div>
      {error && (
        <p role="alert" className="p-3 text-sm">
          {error}
        </p>
      )}
      <div className="player-tools">
        <span>{title}</span>
        <div>
          {expanded ? (
            <Button
              data-testid="game-back"
              size="sm"
              variant="ghost"
              onClick={() => void back()}
            >
              Back to page
            </Button>
          ) : (
            playing && (
              <Button
                data-testid="game-expand"
                size="sm"
                variant="ghost"
                onClick={() => setExpanded(true)}
              >
                Expand
              </Button>
            )
          )}
          <Button
            data-testid="game-restart"
            size="sm"
            variant="ghost"
            disabled={!playing}
            onClick={() => {
              setRestart((n) => n + 1)
              setLoading(true)
            }}
          >
            Restart
          </Button>
          <Button
            data-testid="game-fullscreen"
            size="sm"
            variant="ghost"
            onClick={() => void fullscreen()}
          >
            Fullscreen
          </Button>
        </div>
      </div>
    </div>
  )
}
