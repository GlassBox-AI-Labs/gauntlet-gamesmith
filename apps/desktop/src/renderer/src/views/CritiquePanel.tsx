import { useEffect, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import type { CritiqueRound } from '../../../shared/loop'

let mediaBasePromise: Promise<string | null> | null = null

function useMediaBase(): string | null {
  const [base, setBase] = useState<string | null>(null)
  useEffect(() => {
    mediaBasePromise ??= window.loops.mediaBase()
    void mediaBasePromise.then(setBase)
  }, [])
  return base
}

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
export function CritiqueRoundView({ loopId, round }: { loopId: string; round: CritiqueRound }): React.JSX.Element {
  const [thoughtsOpen, setThoughtsOpen] = useState(false)
  const [zoom, setZoom] = useState<string | null>(null)
  const base = useMediaBase()
  const mediaUrl = (rel: string): string => (base ? `${base}/${loopId}/${rel.split('/').map(encodeURIComponent).join('/')}` : '')

  return (
    <div className="grid grid-cols-1 gap-4">
      {round.verdict && (
        <p className="text-xs leading-relaxed text-[#c9c3c0]">
          <span className="font-mono text-[#f2d98c]">★ {round.verdict.score.toFixed(2)}</span>
          {round.verdict.pass ? <span className="text-emerald-300"> PASS</span> : ' — not there yet'} · {round.verdict.summary}
        </p>
      )}

      {round.thoughts.length > 0 && (
        <div>
          <button type="button" onClick={() => setThoughtsOpen((open) => !open)} className="text-xs text-[#a99bc4] hover:text-[#c4b8dd]">
            𝜓 thought process ({round.thoughts.length}) {thoughtsOpen ? '▾' : '▸'}
          </button>
          {thoughtsOpen && (
            <ol className="mt-2 grid gap-1.5 border-l border-[#3a3444] pl-3 text-[11px] italic leading-relaxed text-[#a99bc4]">
              {round.thoughts.map((thought, index) => (
                <li key={index}>{thought}</li>
              ))}
            </ol>
          )}
        </div>
      )}

      {round.videos.length > 0 && (
        <div className="grid grid-cols-1 gap-2">
          <span className="text-[11px] uppercase tracking-wide text-[#68615f]">Gameplay recording</span>
          {round.videos.map((video) => (
            <video key={video} controls muted className="max-h-[320px] w-full rounded-lg border border-[#332e2e] bg-black" src={mediaUrl(video)} />
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
                  <img
                    src={mediaUrl(pair.shot)}
                    alt="this build"
                    className="w-full cursor-zoom-in rounded-md border border-[#332e2e] bg-black object-contain"
                    onClick={() => setZoom(mediaUrl(pair.shot))}
                  />
                  <figcaption className="mt-0.5 text-[10px] text-[#68615f]">this build</figcaption>
                </figure>
                <figure className="relative">
                  <Winner active={pair.winner === 'ref'} />
                  <img
                    src={mediaUrl(pair.ref)}
                    alt="AAA reference"
                    className="w-full cursor-zoom-in rounded-md border border-[#332e2e] bg-black object-contain"
                    onClick={() => setZoom(mediaUrl(pair.ref))}
                  />
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
              {round.shots.map((shot) => (
                <img key={shot} src={mediaUrl(shot)} alt="" className="w-full cursor-zoom-in rounded-md border border-[#332e2e] bg-black" onClick={() => setZoom(mediaUrl(shot))} />
              ))}
            </div>
            <div className="grid content-start gap-2">
              <span className="text-[11px] uppercase tracking-wide text-[#68615f]">AAA reference ({round.refs.length})</span>
              {round.refs.map((ref) => (
                <img key={ref} src={mediaUrl(ref)} alt="" className="w-full cursor-zoom-in rounded-md border border-[#332e2e] bg-black" onClick={() => setZoom(mediaUrl(ref))} />
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
        <div className="fixed inset-0 z-50 grid cursor-zoom-out place-items-center bg-black/85 p-8" onClick={() => setZoom(null)}>
          <img src={zoom} alt="" className="max-h-full max-w-full rounded-lg" />
        </div>
      )}
    </div>
  )
}
