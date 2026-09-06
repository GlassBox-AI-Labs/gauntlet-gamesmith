import { useEffect, useMemo, useState } from 'react'
import { ChevronLeft, ChevronRight, FolderOpen, ImageOff, LoaderCircle, Search } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useMediaBase } from '@/lib/use-media-base'
import type { GameAssetGalleryItem } from '../../../shared/loop'

const PAGE_SIZE = 24

function mediaUrl(base: string | null, loopId: string, relative: string | null): string {
  if (!base || !relative) return ''
  return `${base}/${loopId}/${relative.split('/').map(encodeURIComponent).join('/')}`
}

export function AssetGallery({ loopId, onOpenEvidence }: { loopId: string; onOpenEvidence: () => void }): React.JSX.Element {
  const { base, error: mediaError, retry } = useMediaBase()
  const [items, setItems] = useState<GameAssetGalleryItem[]>([])
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(0)
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let disposed = false
    setBusy(true)
    setError(null)
    void window.loops.assetGallery(loopId).then((result) => {
      if (disposed) return
      if (!result.ok) {
        setError(result.error)
        return
      }
      setItems(result.value)
      setSelectedSlug((current) => current && result.value.some((item) => item.slug === current) ? current : result.value[0]?.slug ?? null)
    }).catch((cause: unknown) => {
      if (!disposed) setError(cause instanceof Error ? cause.message : 'Could not load generated assets.')
    }).finally(() => {
      if (!disposed) setBusy(false)
    })
    return () => { disposed = true }
  }, [loopId])

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return needle ? items.filter((item) => item.label.toLowerCase().includes(needle) || item.slug.includes(needle)) : items
  }, [items, query])
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const visiblePage = Math.min(page, pages - 1)
  const visible = filtered.slice(visiblePage * PAGE_SIZE, (visiblePage + 1) * PAGE_SIZE)
  const selected = items.find((item) => item.slug === selectedSlug) ?? null
  const previews = items.filter((item) => item.previewPath).length

  const changeQuery = (value: string): void => {
    setQuery(value)
    setPage(0)
  }

  return (
    <section className="border-t border-[#2f2a2b]">
      <div className="flex flex-wrap items-center gap-3 px-4 py-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-medium text-[#ded9d6]">Visual asset review</h2>
          <p className="mt-1 text-[11px] text-[#77706d]">Review safe rendered evidence without executing project code. Select a card for a larger inspection view.</p>
        </div>
        {!busy && !error && <span className="font-mono text-[10px] text-[#77706d]">{items.length} factories · {previews} previews</span>}
        <Button variant="outline" className="border-[#494343] bg-transparent text-[#aaa4a1] hover:bg-white/5 hover:text-white" onClick={onOpenEvidence}><FolderOpen /> Evidence folder</Button>
      </div>

      {busy && <div className="flex items-center gap-2 px-4 py-10 text-xs text-[#77706d]"><LoaderCircle className="size-3.5 animate-spin" /> Indexing generated assets…</div>}
      {error && <p role="alert" className="m-4 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] leading-relaxed text-amber-200">{error}</p>}
      {mediaError && <p role="alert" className="mx-4 mb-4 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] leading-relaxed text-amber-200">{mediaError}{' '}<button type="button" className="underline hover:text-white" onClick={retry}>Retry previews</button></p>}

      {!busy && !error && items.length === 0 && <div className="px-4 py-10 text-center text-xs text-[#77706d]">No procedural asset factories were found in <span className="font-mono">src/assets</span>.</div>}
      {!busy && !error && items.length > 0 && (
        <div className="grid gap-4 border-t border-[#292425] p-4">
          {selected && (
            <div className="grid min-w-0 grid-cols-[minmax(0,1.4fr)_minmax(220px,0.6fr)] overflow-hidden rounded-lg border border-[#332e2e] bg-[#100d0e] max-md:grid-cols-1">
              <div className="grid min-h-72 place-items-center overflow-hidden bg-[radial-gradient(circle_at_center,#282323_0%,#0b090a_70%)] p-3">
                {selected.previewPath && base ? (
                  <img src={mediaUrl(base, loopId, selected.previewPath)} alt={`${selected.label} generated model preview`} className="max-h-[520px] w-full object-contain" />
                ) : (
                  <div className="flex flex-col items-center gap-2 text-[#5d5653]"><ImageOff className="size-8" /><span className="text-xs">No rendered preview</span></div>
                )}
              </div>
              <div className="min-w-0 border-l border-[#292425] p-4 max-md:border-l-0 max-md:border-t">
                <div className="text-lg font-medium text-[#eeeae7]">{selected.label}</div>
                <div className="mt-1 font-mono text-[10px] text-sky-300/80">{selected.slug}</div>
                <dl className="mt-5 grid gap-3 text-[11px]">
                  <div><dt className="text-[#68615f]">Factory</dt><dd className="mt-0.5 break-all font-mono text-[#aaa4a1]">{selected.factoryPath}</dd></div>
                  <div><dt className="text-[#68615f]">Sculptor evidence</dt><dd className="mt-0.5 break-all font-mono text-[#aaa4a1]">{selected.evidencePath ?? 'not recorded'}</dd></div>
                  <div><dt className="text-[#68615f]">Evidence items</dt><dd className="mt-0.5 font-mono text-[#aaa4a1]">{selected.evidenceCount}</dd></div>
                </dl>
              </div>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-3">
            <label className="relative min-w-56 flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-[#68615f]" aria-hidden="true" />
              <span className="sr-only">Filter generated assets</span>
              <input value={query} onChange={(event) => changeQuery(event.target.value)} placeholder="Filter heroes, creeps, structures…" className="h-9 w-full rounded-md border border-[#3b3535] bg-[#100d0e] pl-9 pr-3 text-xs text-[#ded9d6] outline-none placeholder:text-[#5d5653] focus:border-sky-500/60" />
            </label>
            <span className="font-mono text-[10px] text-[#77706d]">{filtered.length} shown</span>
          </div>

          {visible.length > 0 ? (
            <div className="grid grid-cols-6 gap-2 max-xl:grid-cols-4 max-md:grid-cols-2">
              {visible.map((item) => {
                const active = item.slug === selected?.slug
                return (
                  <button key={item.slug} type="button" aria-pressed={active} onClick={() => setSelectedSlug(item.slug)} className={`min-w-0 overflow-hidden rounded-md border text-left transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400 ${active ? 'border-sky-400/70 bg-sky-500/[0.08]' : 'border-[#332e2e] bg-[#100d0e] hover:border-[#5a5150]'}`}>
                    <div className="grid aspect-square place-items-center overflow-hidden bg-[#0b090a]">
                      {item.previewPath && base ? <img loading="lazy" src={mediaUrl(base, loopId, item.previewPath)} alt="" className="size-full object-cover" /> : <ImageOff className="size-5 text-[#514b49]" />}
                    </div>
                    <div className="truncate px-2 py-1.5 text-[10px] text-[#b8b0ac]" title={item.label}>{item.label}</div>
                  </button>
                )
              })}
            </div>
          ) : <div className="py-10 text-center text-xs text-[#77706d]">No assets match “{query}”.</div>}

          {pages > 1 && (
            <div className="flex items-center justify-center gap-3">
              <Button variant="outline" aria-label="Previous asset page" disabled={visiblePage === 0} onClick={() => setPage((current) => Math.max(0, current - 1))}><ChevronLeft /></Button>
              <span className="font-mono text-[10px] text-[#77706d]">Page {visiblePage + 1} of {pages}</span>
              <Button variant="outline" aria-label="Next asset page" disabled={visiblePage >= pages - 1} onClick={() => setPage((current) => Math.min(pages - 1, current + 1))}><ChevronRight /></Button>
            </div>
          )}
        </div>
      )}
    </section>
  )
}
