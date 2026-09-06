import { useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { thoughtAvailabilityMessage } from '@/lib/build-visibility'
import { useMediaBase } from '@/lib/use-media-base'
import type { CritiqueRound } from '../../../shared/build'

function Winner({ active }: { active: boolean }): React.JSX.Element | null {
  if (!active) return null
  return <Badge className="absolute right-1.5 top-1.5 border border-emerald-500/50 bg-emerald-500/20 px-1.5 py-0 text-[10px] text-emerald-300">wins</Badge>
}

const FINDING_STYLES: Record<string, string> = {
  critical: 'border-red-500/35 bg-red-500/10 text-red-300',
  major: 'border-amber-500/35 bg-amber-500/10 text-amber-300',
  minor: 'border-sky-500/35 bg-sky-500/10 text-sky-300',
}

/** Full drill-down for one critique round: verdict, thoughts, video, side-by-sides. */
export function CritiqueRoundView({ buildId, round }: { buildId: string; round: CritiqueRound }): React.JSX.Element {
  const [thoughtsOpen, setThoughtsOpen] = useState(false)
  const [zoom, setZoom] = useState<{ src: string; alt: string } | null>(null)
  const zoomTrigger = useRef<HTMLButtonElement | null>(null)
  const closeZoomRef = useRef<HTMLButtonElement | null>(null)
  const { base, error: mediaError, retry: retryMedia } = useMediaBase()
  const mediaUrl = (rel: string): string => (base ? `${base}/${buildId}/${rel.split('/').map(encodeURIComponent).join('/')}` : '')
  const openZoom = (src: string, alt: string, trigger: HTMLButtonElement): void => {
    zoomTrigger.current = trigger
    setZoom({ src, alt })
  }

  useEffect(() => {
    if (!zoom) return
    const trigger = zoomTrigger.current
    closeZoomRef.current?.focus()
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setZoom(null)
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      trigger?.focus()
    }
  }, [zoom])

  const unavailableThoughts = thoughtAvailabilityMessage(round.thoughts)

  return (
    <div className="grid grid-cols-1 gap-4">
      {mediaError && (
        <p role="alert" className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] leading-relaxed text-amber-200">
          {mediaError}{' '}<button type="button" onClick={retryMedia} className="underline hover:text-white">Retry media</button>
        </p>
      )}
      {round.truncated && (
        <p role="status" className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] leading-relaxed text-amber-200">
          This view shows a bounded subset of the saved evidence because the artifact safety limit was reached.
        </p>
      )}
      {round.verdict && (
        <p className="text-xs leading-relaxed text-[#c9c3c0]">
          <span className="font-mono text-[#f2d98c]">★ {round.verdict.score.toFixed(2)}</span>
          {round.verdict.pass ? <span className="text-emerald-300"> PASS</span> : ' — not there yet'} · {round.verdict.summary}
        </p>
      )}

      {round.thoughts.length > 0 ? (
        <div>
          <button
            type="button"
            aria-expanded={thoughtsOpen}
            aria-controls={`critique-thoughts-${round.attemptId}`}
            onClick={() => setThoughtsOpen((open) => !open)}
            className="text-xs text-[#a99bc4] hover:text-[#c4b8dd]"
          >
            𝜓 thought process ({round.thoughts.length}) {thoughtsOpen ? '▾' : '▸'}
          </button>
          {thoughtsOpen && (
            <ol id={`critique-thoughts-${round.attemptId}`} className="mt-2 grid gap-1.5 border-l border-[#3a3444] pl-3 text-[11px] italic leading-relaxed text-[#a99bc4]">
              {round.thoughts.map((thought, index) => (
                <li key={index}>{thought}</li>
              ))}
            </ol>
          )}
        </div>
      ) : (
        <p className="text-[11px] text-[#77706d]">{unavailableThoughts}</p>
      )}

      {round.videos.length > 0 && (
        <div className="grid grid-cols-1 gap-2">
          <span className="text-[11px] uppercase tracking-wide text-[#68615f]">Gameplay recording</span>
          {round.videos.map((video) => (
            <video key={video} controls muted preload="metadata" className="max-h-[320px] w-full rounded-lg border border-[#332e2e] bg-black" src={mediaUrl(video)} />
          ))}
        </div>
      )}

      {round.pairs && round.pairs.length > 0 ? (
        <div className="grid grid-cols-1 gap-3">
          <span className="text-[11px] uppercase tracking-wide text-[#68615f]">Blind side-by-side ({round.pairs.length} pairs)</span>
          {round.pairs.map((pair, index) => (
            <div key={index} className="grid grid-cols-1 gap-1.5">
              <div className="grid grid-cols-2 gap-2">
                <figure className="relative">
                  <Winner active={pair.winner === 'shot'} />
                  <button
                    type="button"
                    aria-label={`Expand this build screenshot, comparison ${index + 1}`}
                    className="block w-full cursor-zoom-in rounded-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#c9b5aa]"
                    onClick={(event) => openZoom(mediaUrl(pair.shot), `This build screenshot, comparison ${index + 1}`, event.currentTarget)}
                  >
                    <img loading="lazy" src={mediaUrl(pair.shot)} alt={`This build screenshot, comparison ${index + 1}`} className="w-full rounded-md border border-[#332e2e] bg-black object-contain" />
                  </button>
                  <figcaption className="mt-0.5 text-[10px] text-[#68615f]">this build</figcaption>
                </figure>
                <figure className="relative">
                  <Winner active={pair.winner === 'ref'} />
                  <button
                    type="button"
                    aria-label={`Expand AAA reference screenshot, comparison ${index + 1}`}
                    className="block w-full cursor-zoom-in rounded-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#c9b5aa]"
                    onClick={(event) => openZoom(mediaUrl(pair.ref), `AAA reference screenshot, comparison ${index + 1}`, event.currentTarget)}
                  >
                    <img loading="lazy" src={mediaUrl(pair.ref)} alt={`AAA reference screenshot, comparison ${index + 1}`} className="w-full rounded-md border border-[#332e2e] bg-black object-contain" />
                  </button>
                  <figcaption className="mt-0.5 text-[10px] text-[#68615f]">AAA reference{pair.winner === 'tie' ? ' · tie' : ''}</figcaption>
                </figure>
              </div>
              <p className="text-[11px] leading-relaxed text-[#96908d]">{pair.why}</p>
            </div>
          ))}
        </div>
      ) : (
        (round.shots.length > 0 || round.refs.length > 0) && (
          <div className="grid grid-cols-2 gap-3">
            <div className="grid content-start gap-2">
              <span className="text-[11px] uppercase tracking-wide text-[#68615f]">This build ({round.shots.length})</span>
              {round.shots.map((shot, index) => (
                <button
                  type="button"
                  key={shot}
                  aria-label={`Expand this build screenshot ${index + 1}`}
                  className="block w-full cursor-zoom-in rounded-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#c9b5aa]"
                  onClick={(event) => openZoom(mediaUrl(shot), `This build critique screenshot ${index + 1}`, event.currentTarget)}
                >
                  <img loading="lazy" src={mediaUrl(shot)} alt={`This build critique screenshot ${index + 1}`} className="w-full rounded-md border border-[#332e2e] bg-black" />
                </button>
              ))}
            </div>
            <div className="grid content-start gap-2">
              <span className="text-[11px] uppercase tracking-wide text-[#68615f]">AAA reference ({round.refs.length})</span>
              {round.refs.map((ref, index) => (
                <button
                  type="button"
                  key={ref}
                  aria-label={`Expand AAA reference screenshot ${index + 1}`}
                  className="block w-full cursor-zoom-in rounded-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#c9b5aa]"
                  onClick={(event) => openZoom(mediaUrl(ref), `AAA reference screenshot ${index + 1}`, event.currentTarget)}
                >
                  <img loading="lazy" src={mediaUrl(ref)} alt={`AAA reference screenshot ${index + 1}`} className="w-full rounded-md border border-[#332e2e] bg-black" />
                </button>
              ))}
            </div>
          </div>
        )
      )}

      {round.pairsMd && !round.pairs && (
        <pre className="max-h-[240px] overflow-y-auto whitespace-pre-wrap rounded-md border border-[#332e2e] bg-[#100d0e] p-3 font-mono text-[10px] leading-relaxed text-[#96908d]">
          {round.pairsMd}
        </pre>
      )}

      {round.verdict && round.verdict.findings.length > 0 && (
        <div className="grid gap-2 text-[11px] leading-relaxed">
          <span className="text-[11px] uppercase tracking-wide text-[#68615f]">Findings</span>
          {round.verdict.findings.map((finding, index) => {
            const severity = finding.severity.toLowerCase()
            return (
              <div key={index} className="flex items-start gap-2 rounded-md border border-[#332e2e] bg-[#181414] px-2.5 py-2 text-[#c9c3c0]">
                <span
                  className={`mt-px shrink-0 rounded border px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wide ${
                    FINDING_STYLES[severity] ?? 'border-[#494343] bg-white/[0.03] text-[#96908d]'
                  }`}
                >
                  {finding.severity}
                </span>
                <span>{finding.text}</span>
              </div>
            )
          })}
        </div>
      )}

      {zoom && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={zoom.alt}
          className="fixed inset-0 z-50 grid place-items-center bg-black/85 p-8"
          onClick={(event) => {
            if (event.currentTarget === event.target) setZoom(null)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Tab') {
              event.preventDefault()
              closeZoomRef.current?.focus()
            }
          }}
        >
          <button
            ref={closeZoomRef}
            type="button"
            aria-label="Close expanded image"
            className="absolute right-5 top-5 grid size-10 place-items-center rounded-full border border-white/30 bg-black/60 text-white hover:bg-black focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
            onClick={() => setZoom(null)}
          >
            <X className="size-5" />
          </button>
          <img src={zoom.src} alt={zoom.alt} className="max-h-full max-w-full rounded-lg" />
        </div>
      )}
    </div>
  )
}
