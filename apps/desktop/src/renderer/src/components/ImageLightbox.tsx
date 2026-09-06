import { useEffect, useState } from 'react'
import { Dialog } from 'radix-ui'
import { X } from 'lucide-react'

/** Accessible, reusable local-image viewer. Object URLs live only while the viewer is mounted. */
export function ImageLightbox({ file, name, load, children }: { file?: File; name?: string; load?: () => Promise<string>; children: React.ReactNode }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [src, setSrc] = useState('')
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    if (!open) return
    let disposed = false
    const url = file ? URL.createObjectURL(file) : null
    setSrc('')
    setFailed(false)
    if (url) setSrc(url)
    else if (load) void load().then((value) => { if (!disposed) setSrc(value) }).catch(() => { if (!disposed) setFailed(true) })
    else setFailed(true)
    return () => { disposed = true; if (url) URL.revokeObjectURL(url) }
  }, [file, load, open])
  const imageName = name ?? file?.name ?? 'Attached image'
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>{children}</Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[60] bg-black/85 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-[61] flex max-h-[92vh] w-[min(1100px,92vw)] -translate-x-1/2 -translate-y-1/2 flex-col gap-4 rounded-xl border border-white/15 bg-[#171313] p-5 shadow-2xl">
          <Dialog.Title className="break-all pr-10 text-sm font-medium text-[#eee8e4]">{imageName}</Dialog.Title>
          <Dialog.Description className="sr-only">Image attached to this build’s context. Press Escape to close.</Dialog.Description>
          {failed ? <p role="status" className="py-16 text-center text-sm text-[#bdb2ac]">This image format could not be previewed. The original file is still in context.</p> : src ? <img src={src} alt={imageName} onError={() => setFailed(true)} className="min-h-0 max-h-[76vh] w-full object-contain" /> : <p role="status" className="py-16 text-center text-sm text-[#bdb2ac]">Loading image…</p>}
          <Dialog.Close aria-label="Close image preview" className="absolute right-3 top-3 rounded-md p-2 text-[#bbb1ab] hover:bg-white/10 focus-visible:outline focus-visible:outline-2"><X className="size-4" /></Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
