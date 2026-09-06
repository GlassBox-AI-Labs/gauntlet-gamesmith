import { useEffect, useRef, useState } from 'react'
import type { PublicationPreview, PublisherStatus } from '../../../shared/publishing'
import { Button } from '@/components/ui/button'

export function PublishDialog({ loopId, round, title, onClose }: { loopId: string; round: number; title: string; onClose: () => void }): React.JSX.Element {
  const dialog = useRef<HTMLDialogElement>(null)
  const [status, setStatus] = useState<PublisherStatus | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const [preview, setPreview] = useState<PublicationPreview | null>(null), [published, setPublished] = useState('')
  const [draft, setDraft] = useState({ title, slug: title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 64), description: '', controls: '', coverPath: '', outputDir: 'dist' })
  useEffect(() => { dialog.current?.showModal(); void window.publishing.status().then(result => { if (result.ok) setStatus(result.value); else setError(result.error) }); return () => dialog.current?.close() }, [])
  async function run(fn: () => Promise<void>) { setBusy(true); setError(''); try { await fn() } catch (e) { setError(e instanceof Error ? e.message : 'Publishing failed.') } finally { setBusy(false) } }
  return <dialog ref={dialog} onCancel={e => { if (busy) e.preventDefault(); else onClose() }} className="m-auto max-h-[90vh] overflow-y-auto w-[min(560px,90vw)] rounded-xl border border-[#49433c] bg-[#211d19] p-6 text-[#eee8df] shadow-2xl backdrop:bg-black/60">
    <div className="mb-4 flex items-center justify-between"><h2 className="text-lg font-semibold">Publish round {round}</h2><button aria-label="Close publishing" disabled={busy} onClick={onClose}>✕</button></div>
    <p className="mb-4 text-xs text-[#b7aa9b]">Publish a frozen build to your local arcade. Build output and progress appear in the run log.</p>
    {error && <p role="alert" className="mb-4 rounded border border-red-800 p-3 text-sm text-red-200">{error}</p>}
    {!status?.connected ? <><Button disabled={busy} onClick={() => void run(async () => { const result = await window.publishing.signIn(); if (!result.ok) throw new Error(result.error); setStatus(result.value) })}>{busy ? 'Waiting for browser sign-in…' : 'Sign in to publish'}</Button>{busy && <Button variant="outline" className="ml-2" onClick={() => void window.publishing.cancelSignIn()}>Cancel sign-in</Button>}</> : <>
      <div className="mb-4 flex justify-between text-xs"><span>{status.publisherName} · {status.catalogUrl}</span><button disabled={busy} onClick={() => void run(async () => { const result = await window.publishing.signOut(); if (!result.ok) throw new Error(result.error); setStatus({ ...status, connected: false }) })}>Sign out</button></div>
      <form onSubmit={event => { event.preventDefault(); void run(async () => { const result = await window.publishing.prepare({ loopId, round, ...draft }); if (!result.ok) throw new Error(result.error); setPreview(result.value) }) }} className="grid gap-3">
        {([['title','Title'],['slug','Game URL slug'],['description','Description'],['controls','Controls'],['coverPath','Cover path inside build (optional)'],['outputDir','Build output folder']] as const).map(([key,label]) => <label key={key} className="grid gap-1 text-xs text-[#c7b9a8]">{label}<input required={['title','slug','description','outputDir'].includes(key)} disabled={busy || !!preview} value={draft[key]} onChange={e => setDraft({ ...draft, [key]: e.target.value })} className="rounded border border-[#544839] bg-[#181511] p-2 text-sm text-white" /></label>)}
        {!preview && <Button disabled={busy} type="submit" className="mt-3">{busy ? 'Building and uploading…' : 'Build & open private preview'}</Button>}
      </form>
      {preview && !published && <div className="mt-4"><p className="mb-3 text-xs text-[#c7b9a8]">The preview opened in your browser. Check this version before publishing. Only publish assets you have permission to share.</p><div className="flex gap-3"><Button disabled={busy} onClick={() => void run(async () => { const result = await window.publishing.publish({ loopId, releaseId: preview.releaseId, gameId: preview.gameId, generation: preview.generation }); if (!result.ok) throw new Error(result.error); setPublished(result.value) })}>{busy ? 'Publishing…' : 'Publish this version'}</Button><Button variant="outline" disabled={busy} onClick={() => setPreview(null)}>Edit draft</Button></div></div>}
      {published && <p role="status" className="mt-4 rounded border border-green-800 p-3 text-sm text-green-200">Published: <span className="select-all">{published}</span></p>}
    </>}
  </dialog>
}
