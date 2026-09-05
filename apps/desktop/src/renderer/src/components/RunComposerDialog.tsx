import { Dialog } from 'radix-ui'
import { X } from 'lucide-react'

export function RunComposerDialog({ open, busy, onOpenChange, children }: { open: boolean; busy: boolean; onOpenChange: (open: boolean) => void; children: React.ReactNode }): React.JSX.Element {
  return <Dialog.Root open={open} onOpenChange={(next) => { if (!busy) onOpenChange(next) }}>
    <Dialog.Portal>
      <Dialog.Overlay className="fixed inset-0 z-40 bg-black/70 backdrop-blur-[3px] data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 duration-200" />
      <Dialog.Content className="fixed left-1/2 top-1/2 z-50 max-h-[calc(100dvh-40px)] w-[min(920px,calc(100vw-40px))] -translate-x-1/2 -translate-y-1/2 overflow-y-auto bg-transparent px-5 pb-2 pt-10 outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 duration-200 max-sm:px-1">
        <Dialog.Title className="sr-only">New run</Dialog.Title>
        <Dialog.Description className="sr-only">Describe the game, attach context, and configure its agents. Closing this dialog keeps your draft.</Dialog.Description>
        <Dialog.Close disabled={busy} aria-label="Close run composer" className="absolute right-5 top-0 z-10 grid size-7 place-items-center rounded text-[#a49791] hover:bg-white/10 focus-visible:outline focus-visible:outline-2 disabled:opacity-40"><X className="size-4" /></Dialog.Close>
        {children}
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>
}
