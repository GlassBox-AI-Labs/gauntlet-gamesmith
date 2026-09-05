import { useEffect, useRef, useState } from 'react'
import { Check, LoaderCircle, X } from 'lucide-react'
import { ALL_LOG_FILTER, lineMatchesFilter, LogFilterStrip, type LogFilterState } from '@/components/LogFilter'
import { logEmptyMessage } from '@/lib/run-visibility'
import { useMediaBase } from '@/lib/use-media-base'
import { useStickToBottom } from '@/lib/use-stick-to-bottom'
import type { ReferenceStudy } from '../../../shared/loop'

function time(iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? '' : date.toTimeString().slice(0, 8)
}

/** Drill-down for the first-class, per-loop Reference Study attempt. */
export function ReferenceStudyPanel({ loopId, study }: { loopId: string; study: ReferenceStudy }): React.JSX.Element {
  const { base, error: mediaError, retry: retryMedia } = useMediaBase()
  const [zoom, setZoom] = useState<{ src: string; alt: string } | null>(null)
  const zoomTrigger = useRef<HTMLButtonElement | null>(null)
  const closeZoomRef = useRef<HTMLButtonElement | null>(null)
  const [manifestOpen, setManifestOpen] = useState(false)
  const [logFilter, setLogFilter] = useState<LogFilterState>(ALL_LOG_FILTER)
  const log = useStickToBottom(study.logs)
  const visibleLogs = study.logs.filter((line) => lineMatchesFilter(line, logFilter))
  const mediaUrl = (relative: string): string =>
    base ? `${base}/${loopId}/${relative.split('/').map(encodeURIComponent).join('/')}` : ''
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
  const checks = [
    { label: 'stills', value: study.pack.images.length, target: 8 },
    { label: 'motion frames', value: study.pack.motion.length, target: 8 },
    { label: 'journey shots', value: study.pack.journey.length, target: 4 },
    { label: 'video', value: study.pack.videos.length, target: 1 },
    { label: 'research', value: study.pack.researchMd ? 1 : 0, target: 1 },
    { label: 'journey', value: study.pack.journeyMd ? 1 : 0, target: 1 },
    { label: 'story', value: study.pack.storyMd ? 1 : 0, target: 1 },
    { label: 'brief', value: study.pack.readme ? 1 : 0, target: 1 },
    { label: 'sources', value: study.pack.manifest ? 1 : 0, target: 1 },
  ]

  return (
    <div className="grid min-w-0 max-w-full gap-4 overflow-hidden">
      {mediaError && (
        <p role="alert" className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] leading-relaxed text-amber-200">
          {mediaError}{' '}<button type="button" onClick={retryMedia} className="underline hover:text-white">Retry media</button>
        </p>
      )}
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="text-[11px] font-medium uppercase tracking-wide text-amber-300">Reference Pack</span>
        <span className="min-w-0 truncate font-mono text-[10px] text-[#716a67]">{study.pack.root}/</span>
        {study.status === 'running' && <span className="flex items-center gap-1 text-[11px] text-amber-300"><LoaderCircle className="size-3 animate-spin" aria-hidden="true" /> running</span>}
        {study.pack.ready && <span className="ml-auto flex items-center gap-1 text-[11px] text-emerald-300"><Check className="size-3" /> ready</span>}
      </div>

      <div className="grid min-w-0 grid-cols-9 gap-2 max-md:grid-cols-3">
        {checks.map((check) => {
          const ready = check.value >= check.target
          return (
            <div key={check.label} className="min-w-0 rounded-md border border-[#332e2e] bg-[#181414] px-2.5 py-2">
              <div className={`font-mono text-sm ${ready ? 'text-emerald-300' : 'text-amber-300'}`}>{check.value}/{check.target}</div>
              <div className="text-[10px] text-[#716a67]">{check.label}</div>
            </div>
          )
        })}
      </div>

      {study.pack.issues.length > 0 && (
        <div className="grid min-w-0 gap-1 rounded-md border border-amber-500/25 bg-amber-500/[0.06] px-3 py-2 text-[11px] text-amber-200/80">
          {study.pack.issues.map((issue) => <div key={issue} className="flex min-w-0 items-center gap-1.5 break-words"><X className="size-3 shrink-0" /> {issue}</div>)}
        </div>
      )}
      {(study.pack.warnings?.length ?? 0) > 0 && (
        <div role="status" className="grid min-w-0 gap-1 rounded-md border border-sky-500/25 bg-sky-500/[0.06] px-3 py-2 text-[11px] text-sky-200/80">
          {study.pack.warnings!.map((warning) => <div key={warning} className="min-w-0 break-words">{warning}</div>)}
        </div>
      )}

      {study.pack.readme && (
        <section className="min-w-0">
          <div className="mb-2 text-[10px] uppercase tracking-wide text-[#716a67]">Target brief</div>
          <pre className="max-h-64 min-w-0 overflow-y-auto whitespace-pre-wrap break-words rounded-md border border-[#332e2e] bg-[#100d0e] p-3 font-mono text-[10px] leading-relaxed text-[#b8b0ac]">
            {study.pack.readme}
          </pre>
        </section>
      )}

      {study.pack.journey.length > 0 && (
        <section className="min-w-0">
          <div className="mb-2 text-[10px] uppercase tracking-wide text-[#716a67]">First-play journey ({study.pack.journey.length})</div>
          <div className="grid min-w-0 grid-cols-4 gap-2 max-md:grid-cols-2">
            {study.pack.journey.map((file, index) => (
              <button key={file} type="button" aria-label={`Expand first-play journey screenshot ${index + 1}`} onClick={(event) => openZoom(mediaUrl(file), `First-play journey screenshot ${index + 1}`, event.currentTarget)} className="min-w-0 max-w-full overflow-hidden rounded-md border border-[#332e2e] bg-black text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#c9b5aa]">
                <img loading="lazy" src={mediaUrl(file)} alt={`First-play journey screenshot ${index + 1}`} className="aspect-video w-full min-w-0 max-w-full object-cover" />
                <div className="truncate px-2 py-1 font-mono text-[9px] text-[#716a67]">{file.split('/').at(-1)}</div>
              </button>
            ))}
          </div>
        </section>
      )}

      {study.pack.researchMd && (
        <section className="min-w-0">
          <div className="mb-2 text-[10px] uppercase tracking-wide text-[#716a67]">Deep research</div>
          <pre className="max-h-64 min-w-0 overflow-y-auto whitespace-pre-wrap break-words rounded-md border border-[#332e2e] bg-[#100d0e] p-3 font-mono text-[10px] leading-relaxed text-[#b8b0ac]">
            {study.pack.researchMd}
          </pre>
        </section>
      )}

      {study.pack.journeyMd && (
        <section className="min-w-0">
          <div className="mb-2 text-[10px] uppercase tracking-wide text-[#716a67]">Journey walkthrough</div>
          <pre className="max-h-64 min-w-0 overflow-y-auto whitespace-pre-wrap break-words rounded-md border border-[#332e2e] bg-[#100d0e] p-3 font-mono text-[10px] leading-relaxed text-[#b8b0ac]">
            {study.pack.journeyMd}
          </pre>
        </section>
      )}

      {study.pack.storyMd && (
        <section className="min-w-0">
          <div className="mb-2 text-[10px] uppercase tracking-wide text-[#716a67]">Story &amp; dialog</div>
          <pre className="max-h-64 min-w-0 overflow-y-auto whitespace-pre-wrap break-words rounded-md border border-[#332e2e] bg-[#100d0e] p-3 font-mono text-[10px] leading-relaxed text-[#b8b0ac]">
            {study.pack.storyMd}
          </pre>
        </section>
      )}

      {study.pack.images.length > 0 && (
        <section className="min-w-0">
          <div className="mb-2 text-[10px] uppercase tracking-wide text-[#716a67]">Reference stills ({study.pack.images.length})</div>
          <div className="grid min-w-0 grid-cols-4 gap-2 max-md:grid-cols-2">
            {study.pack.images.map((file, index) => (
              <button key={file} type="button" aria-label={`Expand reference still ${index + 1}`} onClick={(event) => openZoom(mediaUrl(file), `Reference still ${index + 1}`, event.currentTarget)} className="min-w-0 max-w-full overflow-hidden rounded-md border border-[#332e2e] bg-black text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#c9b5aa]">
                <img loading="lazy" src={mediaUrl(file)} alt={`Reference still ${index + 1}`} className="aspect-video w-full min-w-0 max-w-full object-cover" />
                <div className="truncate px-2 py-1 font-mono text-[9px] text-[#716a67]">{file.split('/').at(-1)}</div>
              </button>
            ))}
          </div>
        </section>
      )}

      {study.pack.motion.length > 0 && (
        <section className="min-w-0">
          <div className="mb-2 text-[10px] uppercase tracking-wide text-[#716a67]">Motion frames ({study.pack.motion.length})</div>
          <div className="grid min-w-0 grid-cols-6 gap-1.5 max-md:grid-cols-3">
            {study.pack.motion.map((file, index) => (
              <button key={file} type="button" aria-label={`Expand reference motion frame ${index + 1}`} onClick={(event) => openZoom(mediaUrl(file), `Reference motion frame ${index + 1}`, event.currentTarget)} className="min-w-0 max-w-full cursor-zoom-in rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#c9b5aa]">
                <img loading="lazy" src={mediaUrl(file)} alt={`Reference motion frame ${index + 1}`} className="aspect-video w-full min-w-0 max-w-full rounded border border-[#332e2e] bg-black object-cover" />
              </button>
            ))}
          </div>
        </section>
      )}

      {study.pack.videos.length > 0 && (
        <section className="min-w-0">
          <div className="mb-2 text-[10px] uppercase tracking-wide text-[#716a67]">Gameplay video</div>
          {study.pack.videos.map((file) => <video key={file} controls muted preload="metadata" className="max-h-80 w-full min-w-0 max-w-full rounded-md border border-[#332e2e] bg-black" src={mediaUrl(file)} />)}
        </section>
      )}

      {study.pack.manifest && (
        <section className="min-w-0">
          <button type="button" aria-expanded={manifestOpen} aria-controls={`reference-manifest-${study.runId}`} onClick={() => setManifestOpen((open) => !open)} className="text-[11px] text-[#96908d] hover:text-[#c9c3c0]">
            Source manifest {manifestOpen ? '▾' : '▸'}
          </button>
          {manifestOpen && <pre id={`reference-manifest-${study.runId}`} className="mt-2 max-h-64 min-w-0 overflow-y-auto whitespace-pre-wrap break-words rounded-md border border-[#332e2e] bg-[#100d0e] p-3 font-mono text-[10px] leading-relaxed text-[#96908d]">{study.pack.manifest}</pre>}
        </section>
      )}

      <section className="min-w-0">
        <div className="mb-2 text-[10px] uppercase tracking-wide text-[#716a67]">Reference Study log ({study.logs.length})</div>
        <LogFilterStrip lines={study.logs} filter={logFilter} onChange={setLogFilter} showRounds={false} primaryLabel="researcher" />
        <div ref={log.ref} onScroll={log.onScroll} className="max-h-64 min-w-0 overflow-y-auto rounded-md border border-[#332e2e] bg-[#100d0e] p-3 font-mono text-[10px] leading-relaxed">
          {visibleLogs.map((line, index) => (
            <div key={`${line.ts}-${index}`} className={`whitespace-pre-wrap break-words ${line.kind === 'error' || line.kind === 'stderr' ? 'text-red-300/80' : line.kind === 'search' ? 'text-sky-300/80' : line.kind === 'prompt' ? 'text-amber-100/90' : line.kind === 'shot' ? 'text-amber-200' : 'text-[#8f8885]'}`}>
              <span className="mr-2 text-[#4f4947]">{time(line.ts)}</span>
              {line.agentId && <span className="text-[#c0aee6]">[{line.agentId}] </span>}
              {line.text}
            </div>
          ))}
          {logEmptyMessage(study.logs, visibleLogs) && <div className="text-[#68615f]">{logEmptyMessage(study.logs, visibleLogs)}</div>}
        </div>
      </section>

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
