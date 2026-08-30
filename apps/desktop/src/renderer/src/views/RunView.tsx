import { useEffect, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, Eye, FileText, FolderOpen, LoaderCircle, Play, Plus, Square } from 'lucide-react'
import { CritiquePanel } from '@/views/CritiquePanel'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import type { LoopLogLine, LoopSnapshot, PlayState, RunRecord } from '../../../shared/loop'

const LOG_LIMIT = 1500

const KIND_COLORS: Record<string, string> = {
  system: 'text-[#8f8a87]',
  claude: 'text-[#e9c9bc]',
  agent: 'text-[#cfae9d]',
  spawn: 'text-[#c0aee6]',
  tool: 'text-[#7d7772]',
  codex: 'text-[#9ad1c6]',
  thought: 'text-[#a99bc4] italic',
  cmd: 'text-[#7fa8a0]',
  search: 'text-[#8fc7e6]',
  shot: 'text-[#e6b8d4]',
  stderr: 'text-[#a08b6f]',
  error: 'text-[#f0aaaa]',
  metric: 'text-[#9fb2c8]',
  verdict: 'text-[#f2d98c]',
  done: 'text-[#a9e5b8]',
}

const STATUS_STYLES: Record<string, string> = {
  running: 'bg-amber-500/15 text-amber-300 border-amber-500/40',
  passed: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40',
  exhausted: 'bg-[#3a3535] text-[#c9c3c0] border-[#4a4444]',
  stopped: 'bg-[#3a3535] text-[#c9c3c0] border-[#4a4444]',
  failed: 'bg-red-500/15 text-red-300 border-red-500/40',
  succeeded: 'bg-emerald-500/10 text-emerald-300/90 border-transparent',
  queued: 'bg-[#2c2828] text-[#96908d] border-transparent',
  cancelled: 'bg-[#2c2828] text-[#96908d] border-transparent',
  interrupted: 'bg-[#2c2828] text-[#96908d] border-transparent',
}

function fmtTokens(n: number | null | undefined): string {
  if (n == null) return '—'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

function fmtDuration(ms: number | null | undefined): string {
  if (ms == null) return '—'
  const totalSec = Math.round(ms / 1000)
  const m = Math.floor(totalSec / 60)
  const s = totalSec % 60
  return m >= 60 ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m` : `${m}m${String(s).padStart(2, '0')}s`
}

function fmtTs(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toTimeString().slice(0, 8)
}

function RunRow({ run, expanded, onToggle }: { run: RunRecord; expanded: boolean; onToggle: () => void }): React.JSX.Element {
  const hasDetail = Boolean(run.metrics && run.metrics.agents.length > 0)
  const score = run.verdict ? run.verdict.score.toFixed(2) : run.role === 'critique' ? '—' : ''
  return (
    <>
      <TableRow
        className={`border-[#3b3636] ${hasDetail ? 'cursor-pointer hover:bg-white/[0.03]' : 'hover:bg-transparent'}`}
        onClick={hasDetail ? onToggle : undefined}
      >
        <TableCell className="w-8 px-2 py-2.5 text-[#68615f]">
          {hasDetail ? (expanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />) : null}
        </TableCell>
        <TableCell className="px-2 py-2.5 text-[#ded9d6]">{run.round}</TableCell>
        <TableCell className="px-2 py-2.5">
          <span className={run.role === 'implement' ? 'text-[#e9c9bc]' : 'text-[#9ad1c6]'}>{run.role}</span>
        </TableCell>
        <TableCell className="px-2 py-2.5 font-mono text-[11px] text-[#96908d]">{run.model ?? '—'}</TableCell>
        <TableCell className="px-2 py-2.5">
          {run.status === 'running' ? (
            <span className="flex items-center gap-1.5 text-amber-300">
              <LoaderCircle className="size-3 animate-spin" /> running
            </span>
          ) : (
            <span className={STATUS_STYLES[run.status]?.split(' ')[1] ?? 'text-[#96908d]'}>{run.status}</span>
          )}
        </TableCell>
        <TableCell className="px-2 py-2.5 font-mono text-[#f2d98c]">
          {score}
          {run.verdict?.pass ? ' ✓' : ''}
        </TableCell>
        <TableCell className="px-2 py-2.5 font-mono text-[#9fb2c8]">{run.costUsd != null ? `$${run.costUsd.toFixed(2)}` : '—'}</TableCell>
        <TableCell className="px-2 py-2.5 font-mono text-[11px] text-[#96908d]">
          {fmtTokens(run.inputTokens)} / {fmtTokens(run.outputTokens)}
        </TableCell>
        <TableCell className="px-2 py-2.5 font-mono text-[11px] text-[#96908d]">{fmtDuration(run.durationMs)}</TableCell>
      </TableRow>
      {expanded && run.metrics && (
        <TableRow className="border-[#3b3636] hover:bg-transparent">
          <TableCell colSpan={9} className="bg-[#151111] px-4 py-3">
            <div className="grid gap-1.5 font-mono text-[11px]">
              {run.metrics.agents.map((agent) => (
                <div key={agent.id} className={agent.id === 'orchestrator' || agent.id === 'critic' ? 'text-[#ded9d6]' : 'pl-5 text-[#a89f9a]'}>
                  {agent.id !== 'orchestrator' && agent.id !== 'critic' ? '↳ ' : ''}
                  {agent.label}
                  <span className="text-[#68615f]"> ({agent.model ?? '?'})</span> · {agent.messages} msgs · in {fmtTokens(agent.tokens.input)} · out{' '}
                  {fmtTokens(agent.tokens.output)} · cache r/w {fmtTokens(agent.tokens.cacheRead)}/{fmtTokens(agent.tokens.cacheWrite)}
                </div>
              ))}
              {Object.entries(run.metrics.perModel).map(([model, mu]) => (
                <div key={model} className="text-[#9fb2c8]">
                  {model}: {mu.costUsd != null ? `$${mu.costUsd.toFixed(2)}` : '$—'} · in {fmtTokens(mu.tokens.input)} · out {fmtTokens(mu.tokens.output)}
                </div>
              ))}
            </div>
          </TableCell>
        </TableRow>
      )}
    </>
  )
}

export function RunView(): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<LoopSnapshot | null>(null)
  const [lines, setLines] = useState<LoopLogLine[]>([])
  const [composing, setComposing] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [prompt, setPrompt] = useState('')
  const [workspaceDir, setWorkspaceDir] = useState('')
  const [maxRounds, setMaxRounds] = useState('10')
  const [budget, setBudget] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [reportOpen, setReportOpen] = useState(false)
  const [reportMd, setReportMd] = useState('')
  const [critiqueOpen, setCritiqueOpen] = useState(false)
  const [play, setPlay] = useState<PlayState>({ running: false, url: null, error: null })
  const loopIdRef = useRef<string | null>(null)
  const logRef = useRef<HTMLDivElement | null>(null)
  const stickRef = useRef(true)

  useEffect(() => {
    const removeUpdate = window.loops.onUpdate((snap) => {
      if (!loopIdRef.current || snap.loop.id === loopIdRef.current) {
        loopIdRef.current = snap.loop.id
        setSnapshot(snap)
      }
    })
    const removeLog = window.loops.onLog((line) => {
      if (line.loopId !== loopIdRef.current) return
      setLines((current) => {
        const next = [...current, line]
        return next.length > LOG_LIMIT ? next.slice(next.length - LOG_LIMIT) : next
      })
    })
    void (async () => {
      const [snap, defaultDir] = await Promise.all([window.loops.active(), window.loops.defaultWorkspace()])
      setWorkspaceDir((current) => current || defaultDir)
      if (snap) {
        loopIdRef.current = snap.loop.id
        setSnapshot(snap)
        setPrompt(snap.loop.prompt)
        setLines(await window.loops.log(snap.loop.id))
      } else {
        setComposing(true)
      }
      setLoaded(true)
    })()
    return () => {
      removeUpdate()
      removeLog()
    }
  }, [])

  useEffect(() => {
    if (stickRef.current && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [lines])

  useEffect(() => {
    if (!reportOpen || !snapshot) return
    void window.loops.report(snapshot.loop.id).then(setReportMd)
  }, [reportOpen, snapshot])

  const activeLoopId = snapshot?.loop.id ?? null
  useEffect(() => {
    if (!activeLoopId) return
    void window.loops.playState(activeLoopId).then(setPlay)
    return window.loops.onPlayState((state) => {
      if (state.loopId === activeLoopId) setPlay(state)
    })
  }, [activeLoopId])

  const loop = snapshot?.loop ?? null
  const running = loop?.status === 'running'
  const liveRun = snapshot?.runs.find((r) => r.status === 'running') ?? null

  const start = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const result = await window.loops.start({
        prompt,
        workspaceDir,
        maxRounds: Number(maxRounds) || 10,
        budgetUsd: budget.trim() ? Number(budget) : null,
      })
      if (!result.ok) {
        setError(result.error ?? 'Failed to start.')
        return
      }
      loopIdRef.current = result.loopId ?? null
      setLines([])
      setExpanded(new Set())
      setComposing(false)
      const snap = await window.loops.active()
      if (snap) setSnapshot(snap)
    } finally {
      setBusy(false)
    }
  }

  if (!loaded) {
    return (
      <main className="mx-auto w-[min(980px,calc(100%-48px))] py-12">
        <LoaderCircle className="size-5 animate-spin text-[#68615f]" />
      </main>
    )
  }

  return (
    <main className="mx-auto w-[min(980px,calc(100%-48px))] py-12 max-sm:w-[calc(100%-28px)] max-sm:py-7">
      <h1 className="mb-8 text-[27px] font-semibold tracking-[-0.02em]">Run</h1>

      {composing || !loop ? (
        <Card className="gap-5 border-[#332e2e] bg-[#1a1616] p-5 shadow-none">
          <textarea
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            rows={12}
            spellCheck={false}
            placeholder={'Paste your goal prompt.\n\ne.g. "I want you to build a first-person shooter at the level of the most recent Call of Duty games. It should be utterly perfect, visually beautiful, with every single thing done at AAA quality…"'}
            className="w-full resize-y rounded-lg border border-[#393433] bg-[#141010] p-3.5 text-[13px] leading-relaxed text-[#eeeae7] outline-none placeholder:text-[#68615f] focus:border-[#5a524f]"
          />
          <div className="grid grid-cols-[1fr_auto_110px_130px] items-end gap-3 max-sm:grid-cols-1">
            <label className="grid gap-1.5 text-xs text-[#96908d]">
              Workspace (created if missing)
              <input
                value={workspaceDir}
                onChange={(event) => setWorkspaceDir(event.target.value)}
                spellCheck={false}
                className="h-9 rounded-lg border border-[#393433] bg-[#141010] px-3 font-mono text-xs text-[#eeeae7] outline-none focus:border-[#5a524f]"
              />
            </label>
            <Button
              variant="outline"
              className="h-9 border-[#494343] bg-transparent text-[#b5afac] hover:bg-white/5 hover:text-white"
              onClick={() => void window.loops.pickWorkspace().then((dir) => dir && setWorkspaceDir(dir))}
            >
              <FolderOpen /> Browse
            </Button>
            <label className="grid gap-1.5 text-xs text-[#96908d]">
              Max rounds
              <input
                value={maxRounds}
                onChange={(event) => setMaxRounds(event.target.value)}
                inputMode="numeric"
                className="h-9 rounded-lg border border-[#393433] bg-[#141010] px-3 text-xs text-[#eeeae7] outline-none focus:border-[#5a524f]"
              />
            </label>
            <label className="grid gap-1.5 text-xs text-[#96908d]">
              Budget $ (equiv, opt.)
              <input
                value={budget}
                onChange={(event) => setBudget(event.target.value)}
                inputMode="decimal"
                placeholder="none"
                className="h-9 rounded-lg border border-[#393433] bg-[#141010] px-3 text-xs text-[#eeeae7] outline-none placeholder:text-[#68615f] focus:border-[#5a524f]"
              />
            </label>
          </div>
          <p className="text-xs leading-relaxed text-[#7d7772]">
            Claude (claude-fable-5, high effort) orchestrates opus implementer subagents at medium effort with permissions bypassed inside the
            workspace. Codex (gpt-5.6-sol, medium) judges with fresh eyes each round; its verdict is written to the SQLite ledger and seeds the next
            round. Costs shown are equivalent API cost estimates — runs use your subscription logins.
          </p>
          {error && <p className="rounded-lg border border-[#603f3f] bg-[#251718] px-3 py-2.5 text-xs text-[#f0aaaa]">{error}</p>}
          <div className="flex items-center gap-3">
            <Button
              className="bg-[#e9c9bc] text-[#1c1412] hover:bg-[#f2d6ca]"
              disabled={busy || !prompt.trim()}
              onClick={() => void start()}
            >
              {busy ? <LoaderCircle className="animate-spin" /> : <Play className="fill-current" />} Start loop
            </Button>
            {snapshot && (
              <Button variant="ghost" className="text-[#96908d] hover:bg-white/5 hover:text-white" onClick={() => setComposing(false)}>
                Back to last run
              </Button>
            )}
          </div>
        </Card>
      ) : (
        <>
          <div className="mb-5 flex flex-wrap items-center gap-3">
            <Badge className={`border px-2.5 py-1 text-[11px] uppercase tracking-wide ${STATUS_STYLES[loop.status] ?? ''}`}>{loop.status}</Badge>
            <span className="text-sm text-[#ded9d6]">
              round {loop.round}/{loop.maxRounds}
            </span>
            <span className="font-mono text-sm text-[#9fb2c8]">
              ${snapshot!.runs.reduce((sum, r) => sum + (r.costUsd ?? 0), 0).toFixed(2)} equiv
            </span>
            <span className="max-w-[320px] truncate font-mono text-[11px] text-[#68615f]" title={loop.workspaceDir}>
              {loop.workspaceDir}
            </span>
            <div className="ml-auto flex items-center gap-2">
              {play.running && play.url && (
                <button
                  type="button"
                  onClick={() => void window.loops.playStart(loop.id)}
                  className="rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2.5 py-1 font-mono text-[11px] text-emerald-300 hover:bg-emerald-500/20"
                  title="Open in browser"
                >
                  {play.url}
                </button>
              )}
              {play.running ? (
                <Button
                  variant="outline"
                  className="border-[#494343] bg-transparent text-[#96908d] hover:bg-white/5 hover:text-white"
                  onClick={() => void window.loops.playStop(loop.id)}
                >
                  <Square /> Stop game
                </Button>
              ) : (
                <Button
                  variant="outline"
                  className="border-emerald-600/50 bg-transparent text-emerald-300 hover:bg-emerald-500/10 hover:text-emerald-200"
                  onClick={() => void window.loops.playStart(loop.id).then(setPlay)}
                >
                  <Play className="fill-current" /> Play
                </Button>
              )}
              <Button
                variant="outline"
                className={`border-[#494343] bg-transparent hover:bg-white/5 hover:text-white ${critiqueOpen ? 'text-[#f2d98c]' : 'text-[#96908d]'}`}
                onClick={() => setCritiqueOpen((open) => !open)}
              >
                <Eye /> Critique
              </Button>
              <Button
                variant="outline"
                className={`border-[#494343] bg-transparent hover:bg-white/5 hover:text-white ${reportOpen ? 'text-[#e9c9bc]' : 'text-[#96908d]'}`}
                onClick={() => setReportOpen((open) => !open)}
              >
                <FileText /> Report
              </Button>
              {running ? (
                <Button
                  variant="outline"
                  className="border-[#6b4a44] bg-transparent text-[#f0b8aa] hover:bg-[#3a2622] hover:text-[#f7cec2]"
                  onClick={() => void window.loops.stop(loop.id)}
                >
                  <Square className="fill-current" /> Stop
                </Button>
              ) : (
                <Button
                  variant="outline"
                  className="border-[#494343] bg-transparent text-[#eeeae7] hover:bg-white/5 hover:text-white"
                  onClick={() => setComposing(true)}
                >
                  <Plus /> New run
                </Button>
              )}
            </div>
          </div>

          {loop.stopReason && !running && (
            <p className="mb-5 rounded-lg border border-[#3f3a39] bg-[#1d1918] px-3 py-2.5 text-xs text-[#c9c3c0]">{loop.stopReason}</p>
          )}

          {play.error && (
            <p className="mb-5 rounded-lg border border-[#603f3f] bg-[#251718] px-3 py-2.5 text-xs text-[#f0aaaa]">Play: {play.error}</p>
          )}

          {liveRun?.metrics && liveRun.metrics.agents.length > 0 && (
            <div className="mb-5 flex flex-wrap items-center gap-2">
              <span className="mr-1 text-[11px] uppercase tracking-wide text-[#68615f]">Agents</span>
              {liveRun.metrics.agents.map((agent) => {
                const active = !agent.done && agent.lastTs != null && Date.now() - new Date(agent.lastTs).getTime() < 90_000
                return (
                  <span
                    key={agent.id}
                    className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] ${
                      agent.done ? 'border-[#332e2e] text-[#68615f]' : 'border-[#494343] text-[#ded9d6]'
                    }`}
                  >
                    <span
                      className={`size-1.5 rounded-full ${
                        agent.done ? 'bg-[#68615f]' : active ? 'animate-pulse bg-emerald-400' : 'bg-amber-400/70'
                      }`}
                    />
                    {agent.label}
                    <span className="font-mono text-[10px] text-[#9fb2c8]">
                      {fmtTokens(agent.tokens.input + agent.tokens.cacheRead + agent.tokens.cacheWrite)}/{fmtTokens(agent.tokens.output)}
                    </span>
                    {agent.done && '✓'}
                  </span>
                )
              })}
            </div>
          )}

          {critiqueOpen && <CritiquePanel loopId={loop.id} refreshKey={snapshot!.runs.filter((r) => r.role === 'critique' && r.status !== 'running').length} />}

          {reportOpen && (
            <pre className="mb-5 max-h-[360px] overflow-y-auto whitespace-pre-wrap rounded-lg border border-[#332e2e] bg-[#151111] p-4 font-mono text-[11px] leading-[1.65] text-[#c9c3c0]">
              {reportMd || 'Building report…'}
            </pre>
          )}

          <div className="mb-5 overflow-hidden rounded-lg border border-[#332e2e]">
            <Table>
              <TableHeader>
                <TableRow className="border-[#3b3636] hover:bg-transparent">
                  <TableHead className="w-8 px-2 text-[11px] text-[#68615f]" />
                  <TableHead className="px-2 text-[11px] text-[#68615f]">Round</TableHead>
                  <TableHead className="px-2 text-[11px] text-[#68615f]">Role</TableHead>
                  <TableHead className="px-2 text-[11px] text-[#68615f]">Model</TableHead>
                  <TableHead className="px-2 text-[11px] text-[#68615f]">Status</TableHead>
                  <TableHead className="px-2 text-[11px] text-[#68615f]">Score</TableHead>
                  <TableHead className="px-2 text-[11px] text-[#68615f]">Cost</TableHead>
                  <TableHead className="px-2 text-[11px] text-[#68615f]">Tokens in/out</TableHead>
                  <TableHead className="px-2 text-[11px] text-[#68615f]">Time</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody className="text-xs">
                {snapshot!.runs.map((run) => (
                  <RunRow
                    key={run.id}
                    run={run}
                    expanded={expanded.has(run.id)}
                    onToggle={() =>
                      setExpanded((current) => {
                        const next = new Set(current)
                        if (next.has(run.id)) next.delete(run.id)
                        else next.add(run.id)
                        return next
                      })
                    }
                  />
                ))}
              </TableBody>
            </Table>
          </div>

          <div
            ref={logRef}
            onScroll={() => {
              const el = logRef.current
              if (el) stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
            }}
            className="h-[420px] overflow-y-auto rounded-lg border border-[#332e2e] bg-[#0d0a0b] p-3.5 font-mono text-[11px] leading-[1.7]"
          >
            {lines.length === 0 && <span className="text-[#68615f]">Waiting for output…</span>}
            {lines.map((line, index) => (
              <div key={index} className="flex gap-2 whitespace-pre-wrap break-all">
                <span className="shrink-0 text-[#4d4744]">{fmtTs(line.ts)}</span>
                <span className={KIND_COLORS[line.kind] ?? 'text-[#b5afac]'}>{line.text}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </main>
  )
}
