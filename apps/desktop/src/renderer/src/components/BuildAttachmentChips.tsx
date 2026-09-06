import { FileImage, FileText, FolderOpen, X } from 'lucide-react'
import { ImageLightbox } from './ImageLightbox'
import type { BuildAttachment } from '../../../shared/attachments'
export function BuildAttachmentChips({ items, disabled, onRemove, onError }: { items: BuildAttachment[]; disabled: boolean; onRemove: (id: string) => void; onError: (message: string) => void }): React.JSX.Element {
  return <div className="flex flex-wrap gap-1.5">{items.map((item) => {
    const Icon = item.kind === 'folder' ? FolderOpen : item.kind === 'image' ? FileImage : FileText
    const label = <><Icon className="size-3.5 shrink-0 text-[#b98f7d]" /><span className="max-w-[190px] truncate">{item.name}</span><span className="text-[10px] text-[#958b85]">{item.kind === 'folder' ? `${item.files} files` : `${Math.max(1, Math.round(item.bytes / 1024))} KB`}</span></>
    const className = 'inline-flex min-w-0 items-center gap-1.5 rounded px-2 py-1.5 hover:bg-white/5 focus-visible:outline focus-visible:outline-2'
    return <span key={item.id} className="inline-flex max-w-full items-center rounded-lg border border-[#423b39] bg-[#221d1c] text-[11px] text-[#c6bcb7]">
      {item.kind === 'image' ? <ImageLightbox name={item.name} load={async () => { const result = await window.attachments.preview(item.id); if (!result.ok) throw new Error(result.error); return result.value }}><button type="button" className={className} aria-label={`Preview ${item.name}`}>{label}</button></ImageLightbox>
        : item.kind === 'folder' ? <button type="button" className={className} aria-label={`Open ${item.name} in Finder`} onClick={() => { void window.attachments.openFolder(item.id).then((result) => { if (!result.ok) onError(result.error) }).catch(() => onError('Could not open the folder.')) }}>{label}</button>
          : <span className={className}>{label}</span>}
      <button type="button" aria-label={`Remove ${item.name}`} disabled={disabled} onClick={() => onRemove(item.id)} className="mr-1 grid size-6 place-items-center rounded text-[#958b85] hover:bg-white/5 disabled:opacity-40"><X className="size-3" /></button>
    </span>
  })}</div>
}
