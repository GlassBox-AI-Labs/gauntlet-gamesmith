import { useEffect, useState } from 'react'
import { Check, LoaderCircle, X } from 'lucide-react'
import { ALL_LOG_FILTER, lineMatchesFilter, LogFilterStrip, type LogFilterState } from '@/components/LogFilter'
import type { ReferenceStudy } from '../../../shared/loop'

let mediaBasePromise: Promise<string | null> | null = null

function useMediaBase(): string | null {
  const [base, setBase] = useState<string | null>(null)
  useEffect(() => {
    mediaBasePromise ??= window.loops.mediaBase()
    void mediaBasePromise.then(setBase)
  }, [])
  return base
}

function time(iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? '' : date.toTimeString().slice(0, 8)
}

/** Drill-down for the first-class, per-loop Reference Study attempt. */
export function ReferenceStudyPanel({ loopId, study }: { loopId: string; study: ReferenceStudy }): React.JSX.Element {
  const base = useMediaBase()
  const [zoom, setZoom] = useState<string | null>(null)
  const [manifestOpen, setManifestOpen] = useState(false)
  const [logFilter, setLogFilter] = useState<LogFilterState>(ALL_LOG_FILTER)
  const visibleLogs = study.logs.filter((line) => lineMatchesFilter(line, logFilter))
  const mediaUrl = (relative: string): string =>
    base ? `${base}/${loopId}/${relative.split('/').map(encodeURIComponent).join('/')}` : ''
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
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="text-[11px] font-medium uppercase tracking-wide text-amber-300">Reference Pack</span>
        <span className="min-w-0 truncate font-mono text-[10px] text-[#716a67]">{study.pack.root}/</span>
        {study.status === 'running' && <LoaderCircle className="size-3 animate-spin text-amber-300" />}
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
            {study.pack.journey.map((file) => (
              <button key={file} type="button" onClick={() => setZoom(mediaUrl(file))} className="min-w-0 max-w-full overflow-hidden rounded-md border border-[#332e2e] bg-black text-left">
                <img src={mediaUrl(file)} alt="" className="aspect-video w-full min-w-0 max-w-full object-cover" />
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
            {study.pack.images.map((file) => (
              <button key={file} type="button" onClick={() => setZoom(mediaUrl(file))} className="min-w-0 max-w-full overflow-hidden rounded-md border border-[#332e2e] bg-black text-left">
                <img src={mediaUrl(file)} alt="" className="aspect-video w-full min-w-0 max-w-full object-cover" />
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
            {study.pack.motion.map((file) => (
              <img key={file} src={mediaUrl(file)} alt="" onClick={() => setZoom(mediaUrl(file))} className="aspect-video w-full min-w-0 max-w-full cursor-zoom-in rounded border border-[#332e2e] bg-black object-cover" />
            ))}
          </div>
        </section>
      )}

      {study.pack.videos.length > 0 && (
        <section className="min-w-0">
          <div className="mb-2 text-[10px] uppercase tracking-wide text-[#716a67]">Gameplay video</div>
          {study.pack.videos.map((file) => <video key={file} controls muted className="max-h-80 w-full min-w-0 max-w-full rounded-md border border-[#332e2e] bg-black" src={mediaUrl(file)} />)}
        </section>
      )}

      {study.pack.manifest && (
        <section className="min-w-0">
          <button type="button" onClick={() => setManifestOpen((open) => !open)} className="text-[11px] text-[#96908d] hover:text-[#c9c3c0]">
            Source manifest {manifestOpen ? '▾' : '▸'}
          </button>
          {manifestOpen && <pre className="mt-2 max-h-64 min-w-0 overflow-y-auto whitespace-pre-wrap break-words rounded-md border border-[#332e2e] bg-[#100d0e] p-3 font-mono text-[10px] leading-relaxed text-[#96908d]">{study.pack.manifest}</pre>}
        </section>
      )}

      <section className="min-w-0">
        <div className="mb-2 text-[10px] uppercase tracking-wide text-[#716a67]">Reference Study log ({study.logs.length})</div>
        <LogFilterStrip lines={study.logs} filter={logFilter} onChange={setLogFilter} showRounds={false} primaryLabel="researcher" />
        <div className="max-h-64 min-w-0 overflow-y-auto rounded-md border border-[#332e2e] bg-[#100d0e] p-3 font-mono text-[10px] leading-relaxed">
          {visibleLogs.map((line, index) => (
            <div key={`${line.ts}-${index}`} className={`whitespace-pre-wrap break-words ${line.kind === 'error' || line.kind === 'stderr' ? 'text-red-300/80' : line.kind === 'search' ? 'text-sky-300/80' : line.kind === 'prompt' ? 'text-amber-100/90' : line.kind === 'shot' ? 'text-amber-200' : 'text-[#8f8885]'}`}>
              <span className="mr-2 text-[#4f4947]">{time(line.ts)}</span>
              {line.agentId && <span className="text-[#c0aee6]">[{line.agentId}] </span>}
              {line.text}
            </div>
          ))}
          {visibleLogs.length === 0 && <div className="text-[#68615f]">Waiting for Reference Study activity…</div>}
        </div>
      </section>

      {zoom && (
        <div className="fixed inset-0 z-50 grid cursor-zoom-out place-items-center bg-black/85 p-8" onClick={() => setZoom(null)}>
          <img src={zoom} alt="" className="max-h-full max-w-full rounded-lg" />
        </div>
      )}
    </div>
  )
}
