import { memo, useState } from 'react'
import { Check, Copy, FileText } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'

export interface PromptItem {
  id: string
  title: string
  description: string
  value: string
}

const MarkdownPrompt = memo(function MarkdownPrompt({ value }: { value: string }): React.JSX.Element {
  return (
    <ReactMarkdown
      components={{
        h1: ({ children }) => <h1 className="mb-4 mt-7 text-xl font-semibold tracking-tight text-[#eeeae7] first:mt-0">{children}</h1>,
        h2: ({ children }) => <h2 className="mb-3 mt-7 text-base font-semibold text-[#ded9d6] first:mt-0">{children}</h2>,
        h3: ({ children }) => <h3 className="mb-2 mt-5 text-sm font-semibold text-[#c9c3c0]">{children}</h3>,
        p: ({ children }) => <p className="my-3 text-[13px] leading-7 text-[#c9c3c0]">{children}</p>,
        ul: ({ children }) => <ul className="my-3 list-disc space-y-1.5 pl-5 text-[13px] leading-6 text-[#c9c3c0]">{children}</ul>,
        ol: ({ children }) => <ol className="my-3 list-decimal space-y-2 pl-5 text-[13px] leading-6 text-[#c9c3c0]">{children}</ol>,
        li: ({ children }) => <li className="pl-1 marker:text-[#8f8885]">{children}</li>,
        blockquote: ({ children }) => <blockquote className="my-4 border-l-2 border-[#645b57] pl-4 text-[#aaa4a1]">{children}</blockquote>,
        hr: () => <hr className="my-6 border-[#332e2e]" />,
        pre: ({ children }) => <pre className="my-4 overflow-x-auto rounded-lg border border-[#332e2e] bg-[#0d0a0b] p-4 font-mono text-[11px] leading-6 text-[#d7d0cc]">{children}</pre>,
        code: ({ children, className, ...props }) => (
          <code className={`${className ?? ''} rounded bg-white/[0.055] px-1 py-0.5 font-mono text-[11px] text-[#e9c9bc]`} {...props}>{children}</code>
        ),
        strong: ({ children }) => <strong className="font-semibold text-[#eeeae7]">{children}</strong>,
        // Prompt history can come from an imported, untrusted ledger. Keep
        // Markdown URLs inert so opening a prompt cannot contact loopback or
        // remote services through the renderer.
        a: ({ children, href }) => <span title={href} className="text-[#9fc9d7] underline decoration-[#46606a] underline-offset-2">{children}</span>,
        img: ({ alt }) => <span className="text-[#8f8885]">[image omitted{alt ? `: ${alt}` : ''}]</span>,
      }}
    >
      {value}
    </ReactMarkdown>
  )
})

/** Compact prompt tiles backed by one shadcn Sheet reader. */
export function PromptBrowser({ prompts }: { prompts: PromptItem[] }): React.JSX.Element {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const selected = prompts.find((prompt) => prompt.id === selectedId) ?? null

  const copyPrompt = async (prompt: PromptItem): Promise<void> => {
    if (!prompt.value) return
    try {
      await navigator.clipboard.writeText(prompt.value)
      setCopiedId(prompt.id)
      window.setTimeout(() => setCopiedId((current) => current === prompt.id ? null : current), 1500)
    } catch {
      // Clipboard access is best-effort in the renderer sandbox.
    }
  }

  return (
    <>
      <section aria-labelledby="run-prompts-title">
        <div className="mb-2 flex items-baseline justify-between">
          <h2 id="run-prompts-title" className="text-[11px] font-medium uppercase tracking-wide text-[#8f8885]">Prompts</h2>
          <span className="text-[10px] text-[#5f5956]">Open a tile to read the formatted prompt</span>
        </div>
        <div className="grid grid-cols-2 gap-2 max-md:grid-cols-1">
          {prompts.map((prompt) => {
            const available = Boolean(prompt.value)
            const copied = copiedId === prompt.id
            const preview = prompt.value.trim().replace(/\s+/g, ' ')
            return (
              <Card key={prompt.id} className={`grid min-w-0 grid-cols-[1fr_auto] gap-0 overflow-hidden border-[#332e2e] bg-[#151212] py-0 shadow-none ${available ? 'hover:border-[#4a4341]' : 'opacity-55'}`}>
                <button
                  type="button"
                  disabled={!available}
                  onClick={() => setSelectedId(prompt.id)}
                  className="group min-w-0 px-4 py-3.5 text-left outline-none focus-visible:bg-white/[0.035]"
                >
                  <span className="flex items-center gap-2 text-[12px] font-medium text-[#ded9d6] group-hover:text-white">
                    <FileText className="size-3.5 text-[#817975]" /> {prompt.title}
                  </span>
                  <span
                    className="mt-1 block truncate text-[11px] leading-relaxed text-[#77706d]"
                    title={available ? preview : undefined}
                  >
                    {available ? preview : 'Not recorded yet.'}
                  </span>
                </button>
                <div className="flex items-center border-l border-[#2e2929] px-2">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    disabled={!available}
                    onClick={() => void copyPrompt(prompt)}
                    aria-label={`${copied ? 'Copied' : 'Copy'} ${prompt.title.toLowerCase()} prompt`}
                    title={copied ? 'Copied' : `Copy ${prompt.title.toLowerCase()} prompt`}
                    className="text-[#716a67] hover:bg-white/[0.05] hover:text-[#c9c3c0]"
                  >
                    {copied ? <Check className="size-3.5 text-emerald-400" /> : <Copy className="size-3.5" />}
                  </Button>
                </div>
              </Card>
            )
          })}
        </div>
      </section>

      <Sheet open={selected != null} onOpenChange={(open) => !open && setSelectedId(null)}>
        <SheetContent side="right">
          {selected && (
            <>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                onClick={() => void copyPrompt(selected)}
                aria-label={`${copiedId === selected.id ? 'Copied' : 'Copy'} ${selected.title.toLowerCase()} prompt`}
                title={copiedId === selected.id ? 'Copied' : `Copy ${selected.title.toLowerCase()} prompt`}
                className="absolute right-14 top-4 z-10 text-[#77706d] hover:bg-white/[0.05] hover:text-[#ded9d6]"
              >
                {copiedId === selected.id ? <Check className="size-3.5 text-emerald-400" /> : <Copy className="size-3.5" />}
              </Button>
              <SheetHeader className="pr-24">
                <SheetTitle>{selected.title} prompt</SheetTitle>
                <SheetDescription>{selected.description}</SheetDescription>
              </SheetHeader>
              <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-10 pt-2">
                <MarkdownPrompt value={selected.value} />
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>
    </>
  )
}
