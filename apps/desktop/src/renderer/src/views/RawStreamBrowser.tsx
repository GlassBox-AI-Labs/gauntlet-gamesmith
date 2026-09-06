import { useCallback, useEffect, useRef, useState } from 'react'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import type { RawStreamLink } from '@/lib/build-visibility'
import type { RawStreamChunk, ReadRawStreamInput } from '../../../shared/build'
import type { OperationResult } from '../../../shared/result'

export interface RawStreamBrowserProps {
  stream: RawStreamLink | null
  onRead: (input: ReadRawStreamInput) => Promise<OperationResult<RawStreamChunk>>
  onClose: () => void
}

function bytesFromBase64(value: string): Uint8Array {
  const binary = window.atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / (1024 * 1024)).toFixed(1)} MB`
}

/** Bounded, transient reader opened only from a timestamped event-log link. */
export function RawStreamBrowser({ stream, onRead, onClose }: RawStreamBrowserProps): React.JSX.Element {
  const [content, setContent] = useState('')
  const [nextOffset, setNextOffset] = useState(0)
  const [totalBytes, setTotalBytes] = useState(0)
  const [identity, setIdentity] = useState<string | undefined>()
  const [complete, setComplete] = useState(false)
  const [reading, setReading] = useState(false)
  const [readError, setReadError] = useState<string | null>(null)
  const generation = useRef(0)
  const inFlightGeneration = useRef<number | null>(null)
  const decoder = useRef(new TextDecoder())

  const readChunk = useCallback(async (
    stream: RawStreamLink,
    offset: number,
    expectedIdentity: string | undefined,
    replace: boolean,
    requestGeneration: number,
  ): Promise<void> => {
    if (inFlightGeneration.current === requestGeneration) return
    inFlightGeneration.current = requestGeneration
    setReading(true)
    setReadError(null)
    try {
      const result = await onRead({ ...stream.input, offset, identity: expectedIdentity })
      if (generation.current !== requestGeneration) return
      if (!result.ok) {
        setReadError(result.error)
        return
      }
      const chunk = result.value
      const text = decoder.current.decode(bytesFromBase64(chunk.contentBase64), { stream: !chunk.complete })
      setContent((current) => replace ? text : current + text)
      setNextOffset(chunk.nextOffset)
      setTotalBytes(chunk.totalBytes)
      setIdentity(chunk.identity)
      setComplete(chunk.complete)
    } catch (cause) {
      if (generation.current === requestGeneration) {
        setReadError(cause instanceof Error ? cause.message : 'Could not read this raw stream.')
      }
    } finally {
      if (inFlightGeneration.current === requestGeneration) inFlightGeneration.current = null
      if (generation.current === requestGeneration) setReading(false)
    }
  }, [onRead])

  useEffect(() => {
    if (!stream) {
      generation.current += 1
      return
    }
    const requestGeneration = generation.current + 1
    generation.current = requestGeneration
    inFlightGeneration.current = null
    decoder.current = new TextDecoder()
    setContent('')
    setNextOffset(0)
    setTotalBytes(0)
    setIdentity(undefined)
    setComplete(false)
    void readChunk(stream, 0, undefined, true, requestGeneration)
  }, [readChunk, stream])

  return (
    <Sheet open={stream != null} onOpenChange={(nextOpen) => { if (!nextOpen) onClose() }}>
      <SheetContent side="right">
        <SheetHeader>
          <SheetTitle>{stream?.label ?? 'Complete agent stream'}</SheetTitle>
          <SheetDescription>
            Unfiltered CLI output for this event source. Raw output may include sensitive local text.
          </SheetDescription>
        </SheetHeader>
        <div className="grid min-h-0 flex-1 grid-rows-[auto_minmax(0,1fr)_auto] gap-3 px-6 pb-5">
          <div className="flex items-center justify-between text-[10px] text-[#68615f]">
            <span>{stream ? new Date(stream.ts).toLocaleString() : 'Raw stream'}</span>
            <span>{formatBytes(nextOffset)} / {formatBytes(totalBytes)}</span>
          </div>
          <pre
            aria-busy={reading}
            className="min-h-0 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-[#332e2e] bg-[#0d0a0b] p-4 font-mono text-[11px] leading-6 text-[#c9c3c0]"
          >
            {content || (reading ? 'Reading stream…' : complete ? 'This stream is empty.' : '')}
          </pre>
          <div className="min-h-8">
            {readError ? (
              <p role="alert" className="text-xs text-[#f0aaaa]">{readError}</p>
            ) : !complete && stream ? (
              <button
                type="button"
                disabled={reading}
                onClick={() => void readChunk(stream, nextOffset, identity, false, generation.current)}
                className="rounded-md border border-[#494343] px-3 py-1.5 text-xs text-[#9fb8ce] hover:bg-white/[0.05] hover:text-[#d0dfeb] disabled:cursor-not-allowed disabled:opacity-50"
              >
                Load more
              </button>
            ) : (
              <span className="text-[10px] text-[#5f5956]">Complete stream loaded</span>
            )}
          </div>
        </div>
      </SheetContent>
    </Sheet>
  )
}
