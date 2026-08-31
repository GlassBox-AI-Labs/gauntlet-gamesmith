import { useEffect, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import type { CritiqueRound } from '../../../shared/loop'

function makeMediaUrl(base: string | null, loopId: string, rel: string): string {
  if (!base) return ''
  return `${base}/${loopId}/${rel.split('/').map(encodeURIComponent).join('/')}`
}

function Winner({ active }: { active: boolean }): React.JSX.Element | null {
  if (!active) return null
  return <Badge className="absolute right-1.5 top-1.5 border border-emerald-500/50 bg-emerald-500/20 px-1.5 py-0 text-[10px] text-emerald-300">wins</Badge>
}

export function CritiquePanel({ loopId, refreshKey }: { loopId: string; refreshKey: number }): React.JSX.Element {
  const [rounds, setRounds] = useState<CritiqueRound[]>([])
  const [selected, setSelected] = useState<number | null>(null)
  const [thoughtsOpen, setThoughtsOpen] = useState(false)
  const [zoom, setZoom] = useState<string | null>(null)
  const [mediaBase, setMediaBase] = useState<string | null>(null)
  const mediaUrl = (id: string, rel: string): string => makeMediaUrl(mediaBase, id, rel)

  useEffect(() => {
    void window.loops.mediaBase().then(setMediaBase)
  }, [])

  useEffect(() => {
    void window.loops.critique(loopId).then((data) => {
      setRounds(data)
      setSelected((current) => current ?? data.at(-1)?.round ?? null)
    })
  }, [loopId, refreshKey])

  const round = rounds.find((r) => r.round === selected) ?? rounds.at(-1) ?? null

  if (!round) {
    return (
      <div className="mb-5 rounded-lg border border-[#332e2e] bg-[#151111] p-4 text-xs text-[#96908d]">
        No critique yet — the critic runs after each implement round finishes.
      </div>
    )
  }

  return (
    <div className="mb-5 grid gap-4 rounded-lg border border-[#332e2e] bg-[#151111] p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[11px] uppercase tracking-wide text-[#68615f]">Critique round</span>
        {rounds.map((r) => (
          <button
            key={r.round}
            type="button"
            onClick={() => setSelected(r.round)}
            className={`rounded-full border px-2.5 py-0.5 text-[11px] ${
              r.round === round.round ? 'border-[#f2d98c]/50 bg-[#f2d98c]/10 text-[#f2d98c]' : 'border-[#494343] text-[#96908d] hover:text-[#ded9d6]'
            }`}
          >
            {r.round}
            {r.verdict ? ` · ${r.verdict.score.toFixed(2)}` : ''}
          </button>
        ))}
        {round.verdict && (
          <span className="ml-auto text-xs text-[#c9c3c0]">
            <span className="font-mono text-[#f2d98c]">★ {round.verdict.score.toFixed(2)}</span>
            {round.verdict.pass ? <span className="text-emerald-300"> PASS</span> : ' — not there yet'}
          </span>
        )}
      </div>

      {round.verdict && <p className="text-xs leading-relaxed text-[#c9c3c0]">{round.verdict.summary}</p>}

      {round.thoughts.length > 0 && (
        <div>
          <button
            type="button"
            onClick={() => setThoughtsOpen((open) => !open)}
            className="text-xs text-[#a99bc4] hover:text-[#c4b8dd]"
          >
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
        <div className="grid gap-2">
          <span className="text-[11px] uppercase tracking-wide text-[#68615f]">Gameplay recording</span>
          {round.videos.map((video) => (
            <video key={video} controls muted className="max-h-[320px] w-full rounded-lg border border-[#332e2e] bg-black" src={mediaUrl(loopId, video)} />
          ))}
        </div>
      )}

      {round.pairs && round.pairs.length > 0 ? (
        <div className="grid gap-3">
          <span className="text-[11px] uppercase tracking-wide text-[#68615f]">Blind side-by-side ({round.pairs.length} pairs)</span>
          {round.pairs.map((pair, index) => (
            <div key={index} className="grid gap-1.5">
              <div className="grid grid-cols-2 gap-2">
                <figure className="relative">
                  <Winner active={pair.winner === 'shot'} />
                  <img
                    src={mediaUrl(loopId, pair.shot)}
                    alt="this build"
                    className="w-full cursor-zoom-in rounded-md border border-[#332e2e] bg-black object-contain"
                    onClick={() => setZoom(mediaUrl(loopId, pair.shot))}
                  />
                  <figcaption className="mt-0.5 text-[10px] text-[#68615f]">this build</figcaption>
                </figure>
                <figure className="relative">
                  <Winner active={pair.winner === 'ref'} />
                  <img
                    src={mediaUrl(loopId, pair.ref)}
                    alt="AAA reference"
                    className="w-full cursor-zoom-in rounded-md border border-[#332e2e] bg-black object-contain"
                    onClick={() => setZoom(mediaUrl(loopId, pair.ref))}
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
                <img key={shot} src={mediaUrl(loopId, shot)} alt="" className="w-full cursor-zoom-in rounded-md border border-[#332e2e] bg-black" onClick={() => setZoom(mediaUrl(loopId, shot))} />
              ))}
            </div>
            <div className="grid content-start gap-2">
              <span className="text-[11px] uppercase tracking-wide text-[#68615f]">AAA reference ({round.refs.length})</span>
              {round.refs.map((ref) => (
                <img key={ref} src={mediaUrl(loopId, ref)} alt="" className="w-full cursor-zoom-in rounded-md border border-[#332e2e] bg-black" onClick={() => setZoom(mediaUrl(loopId, ref))} />
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
        <div className="grid gap-1 text-[11px] leading-relaxed">
          <span className="text-[11px] uppercase tracking-wide text-[#68615f]">Findings</span>
          {round.verdict.findings.map((finding, index) => (
            <span key={index} className="text-[#c9c3c0]">
              <span className="text-[#f2d98c]">[{finding.severity}]</span> {finding.text}
            </span>
          ))}
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
