import { useEffect, useRef } from 'react'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import { Check, LoaderCircle, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { HarnessKind, LoginPhase } from '../../../shared/harness'

interface TerminalPanelProps {
  kind: HarnessKind
  phase: LoginPhase
  transcript: string
  onCancel: () => void
  onClose: () => void
  registerWriter: (kind: HarnessKind, writer: ((data: string) => void) | null) => void
}

export function TerminalPanel({
  kind,
  phase,
  transcript,
  onCancel,
  onClose,
  registerWriter,
}: TerminalPanelProps): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const running = phase === 'signing_in' || phase === 'awaiting_browser'

  useEffect(() => {
    if (!hostRef.current) return

    const terminal = new Terminal({
      cursorBlink: true,
      fontFamily: 'SFMono-Regular, Menlo, Monaco, Consolas, monospace',
      fontSize: 13,
      lineHeight: 1.35,
      scrollback: 1_000,
      theme: {
        background: '#0e0c0c',
        foreground: '#e8e3df',
        cursor: '#e8e3df',
        selectionBackground: '#6f655d',
      },
    })
    const fit = new FitAddon()
    terminal.loadAddon(fit)
    terminal.open(hostRef.current)
    if (transcript) terminal.write(transcript)
    terminal.onData((data) => window.harnesses.writeTerminal(kind, data))
    registerWriter(kind, (data) => terminal.write(data))

    const resize = (): void => {
      fit.fit()
      window.harnesses.resizeTerminal(kind, terminal.cols, terminal.rows)
    }
    const observer = new ResizeObserver(resize)
    observer.observe(hostRef.current)
    requestAnimationFrame(() => {
      resize()
      terminal.focus()
    })

    return () => {
      observer.disconnect()
      registerWriter(kind, null)
      terminal.dispose()
    }
  }, [kind])

  return (
    <section className="mt-6 overflow-hidden rounded-lg border border-[#443e3b] bg-[#2a2725]">
      <header className="flex h-11 items-center gap-2.5 border-b border-[#46403d] px-3 text-xs text-[#aaa29f]">
        {phase === 'logged_in' ? (
          <span className="grid size-4 place-items-center rounded-full border border-emerald-400 text-emerald-400">
            <Check className="size-2.5" />
          </span>
        ) : (
          <LoaderCircle className="size-4 animate-spin" />
        )}
        <span>
          {phase === 'logged_in'
            ? `Finished ${kind} login. You can close this terminal.`
            : `Running ${kind} login.`}
        </span>
        <Button
          variant="ghost"
          size="icon-xs"
          className="ml-auto text-[#bbb4b1] hover:bg-white/5 hover:text-white"
          onClick={running ? onCancel : onClose}
          aria-label={running ? 'Cancel login' : 'Close terminal'}
        >
          <X />
        </Button>
      </header>
      <div ref={hostRef} className="m-3 h-[290px] bg-[#0e0c0c] p-2.5" />
    </section>
  )
}
