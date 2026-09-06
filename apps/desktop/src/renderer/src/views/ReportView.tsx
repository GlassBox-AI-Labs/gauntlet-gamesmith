import { useState } from 'react'
import { Check, ChevronDown, ChevronRight, FileText, LoaderCircle, Pencil, Plus, RefreshCw, Trash2, Upload, X } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { fmtSpan, fmtTokens, fmtUsd } from '@/lib/format'
import type { BuildSnapshot } from '../../../shared/build'
import { modelLabel } from '../../../shared/models'
import { hasMixedPrompts, reportTotals, shortHash, type ReportRecord, type ReportBuildRow } from '../../../shared/reports'

const REPORT_STATUS_STYLES: Record<string, string> = {
  running: 'bg-amber-500/15 text-amber-300 border-amber-500/40',
  passed: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40',
  exhausted: 'bg-[#3a3535] text-[#c9c3c0] border-[#4a4444]',
  stopped: 'bg-[#3a3535] text-[#c9c3c0] border-[#4a4444]',
  failed: 'bg-red-500/15 text-red-300 border-red-500/40',
}

/**
 * The box itself. Rendered as a span so it can sit inside a larger clickable
 * row. Its border colour is inline for the same reason as the sidebar's — the
 * unlayered `*` rule in globals.css outranks any `border-[…]` utility.
 */
function CheckMark({ checked }: { checked: boolean }): React.JSX.Element {
  return (
    <span
      style={{ borderColor: checked ? '#c2bbb7' : '#8a827f' }}
      className={`grid size-4 shrink-0 place-items-center rounded border transition-colors ${
        checked ? 'bg-[#c2bbb7] text-[#1c1716]' : 'text-transparent'
      }`}
    >
      <Check className="size-3" strokeWidth={3} />
    </span>
  )
}

function Checkbox({ checked, label, onChange }: { checked: boolean; label: string; onChange: () => void }): React.JSX.Element {
  return (
    <button type="button" role="checkbox" aria-checked={checked} aria-label={label} onClick={onChange} className="group grid place-items-center">
      <CheckMark checked={checked} />
    </button>
  )
}

/** A plain centered panel. The app has no dialog primitive, so this is the pattern. */
function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-6">
      <div className="flex max-h-[80vh] w-[min(640px,100%)] flex-col overflow-hidden rounded-xl border border-[#3d3737] bg-[#1a1616] shadow-2xl shadow-black/50">
        <div className="flex items-center justify-between border-b border-[#332e2e] px-4 py-3">
          <h2 className="text-[14px] font-medium text-[#eeeae7]">{title}</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="grid size-7 place-items-center rounded-md text-[#77706d] hover:bg-white/[0.05] hover:text-white">
            <X className="size-4" />
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}

function setupLines(row: ReportBuildRow): string[] {
  return [
    `${modelLabel(row.models.orchestratorModel)} · ${row.models.orchestratorEffort}`,
    row.models.subagentModel ? `${modelLabel(row.models.subagentModel)} · ${row.models.subagentEffort}` : 'solo, no subagents',
    `${modelLabel(row.models.criticModel)} · ${row.models.criticEffort}`,
  ]
}

function RoundBreakdown({ row }: { row: ReportBuildRow }): React.JSX.Element {
  if (row.rounds.length === 0) {
    return (
      <div className="px-4 py-3 text-[11px] text-[#68615f]">
        This attempt has no finished rounds.{row.stopReason ? ` ${row.stopReason}` : ''}
      </div>
    )
  }
  return (
    <div className="px-4 py-3">
      {row.stopReason && <p className="mb-2 text-[11px] text-[#8f8885]">{row.stopReason}</p>}
      <div className="mb-2 grid grid-cols-[52px_64px_72px_72px_110px_72px_78px_1fr] gap-2 text-[10px] uppercase tracking-wide text-[#68615f]">
        <span>Round</span>
        <span>Score</span>
        <span>Cost</span>
        <span>Tokens</span>
        <span>In / Out</span>
        <span>Active</span>
        <span>Elapsed</span>
        <span>Revision</span>
      </div>
      {row.rounds.map((round) => (
        <div key={round.round} className="grid grid-cols-[52px_64px_72px_72px_110px_72px_78px_1fr] gap-2 border-t border-[#2a2626] py-1.5 font-mono text-[11px] text-[#c2bbb7]">
          <span className="text-[#8f8885]">
            {round.round}
            {round.attempts > 2 && <span className="ml-1 text-[9px] text-[#68615f]">×{round.attempts}</span>}
          </span>
          <span className="text-[#f2d98c]">{round.score?.toFixed(2) ?? '—'}{round.pass ? ' ✓' : ''}</span>
          <span className="text-[#b7cbe0]">{fmtUsd(round.costUsd)}</span>
          <span>{fmtTokens(round.inputTokens + round.outputTokens)}</span>
          <span className="text-[#8f8885]">{fmtTokens(round.inputTokens)} / {fmtTokens(round.outputTokens)}</span>
          <span>{fmtSpan(round.activeMs)}</span>
          <span className="text-[#b8aaa4]">{round.elapsedMs == null ? '—' : `+${fmtSpan(round.elapsedMs)}`}</span>
          <span className="truncate text-[#68615f]">{round.revision?.slice(0, 12) ?? '—'}</span>
        </div>
      ))}
      {row.cacheReadTokens != null && (
        <p className="mt-2 text-[10px] text-[#68615f]">
          Cache read {fmtTokens(row.cacheReadTokens)} · cache written {fmtTokens(row.cacheWriteTokens)} — both already counted inside the input column.
        </p>
      )}
    </div>
  )
}

function AddBuildsModal({
  snapshots,
  present,
  busy,
  onClose,
  onAdd,
}: {
  snapshots: BuildSnapshot[]
  present: Set<string>
  busy: boolean
  onClose: () => void
  onAdd: (buildIds: string[]) => void
}): React.JSX.Element {
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const available = snapshots.filter((item) => !present.has(item.build.id))
  return (
    <Modal title="Add builds to this report" onClose={onClose}>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {available.length === 0 && <p className="p-4 text-[12px] text-[#88817e]">Every build on this machine is already in the report.</p>}
        {available.map((item) => {
          const checked = picked.has(item.build.id)
          return (
            <button
              key={item.build.id}
              type="button"
              onClick={() =>
                setPicked((current) => {
                  const next = new Set(current)
                  if (next.has(item.build.id)) next.delete(item.build.id)
                  else next.add(item.build.id)
                  return next
                })
              }
              role="checkbox"
              aria-checked={checked}
              className="group flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left hover:bg-white/[0.04]"
            >
              <CheckMark checked={checked} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] text-[#ded9d6]">{item.build.title}</span>
                <span className="block truncate text-[11px] text-[#68615f]">{item.build.workspaceDir}</span>
              </span>
              <span className="shrink-0 font-mono text-[10px] uppercase text-[#77706d]">{item.build.status}</span>
            </button>
          )
        })}
      </div>
      <div className="flex justify-end gap-2 border-t border-[#332e2e] px-4 py-3">
        <Button variant="outline" className="border-[#494343] bg-transparent text-[#96908d] hover:bg-white/5 hover:text-white" onClick={onClose}>
          Cancel
        </Button>
        <Button
          className="bg-[#eeeae7] text-[#1c1716] hover:bg-white"
          disabled={busy || picked.size === 0}
          onClick={() => onAdd([...picked])}
        >
          {busy ? <LoaderCircle className="animate-spin" /> : null} Add {picked.size > 0 ? picked.size : ''}
        </Button>
      </div>
    </Modal>
  )
}

export function ReportPanel({
  report,
  snapshots,
  onReplace,
  onDeleted,
  onNotice,
  onError,
}: {
  report: ReportRecord
  snapshots: BuildSnapshot[]
  onReplace: (report: ReportRecord) => void
  onDeleted: (reportId: string) => void
  onNotice: (text: string) => void
  onError: (text: string) => void
}): React.JSX.Element {
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [checked, setChecked] = useState<Set<string>>(new Set())
  const [renaming, setRenaming] = useState(false)
  const [nameDraft, setNameDraft] = useState(report.name)
  const [adding, setAdding] = useState(false)
  const [busy, setBusy] = useState(false)

  const totals = reportTotals(report.rows)
  const mixed = hasMixedPrompts(report.rows)
  const scored = report.rows.map((row) => row.bestScore).filter((score): score is number => score != null)
  const bestOverall = scored.length > 0 ? Math.max(...scored) : null

  const attempt = async (action: () => Promise<ReportRecord | null>, success?: string): Promise<void> => {
    setBusy(true)
    try {
      const next = await action()
      if (!next) {
        onError('That report is no longer available.')
        return
      }
      onReplace(next)
      if (success) onNotice(success)
    } finally {
      setBusy(false)
    }
  }

  const saveName = async (): Promise<void> => {
    const name = nameDraft.trim()
    setRenaming(false)
    if (!name || name === report.name) {
      setNameDraft(report.name)
      return
    }
    await attempt(() => window.reports.rename(report.id, name))
  }

  const removeChecked = async (): Promise<void> => {
    const ids = [...checked]
    setChecked(new Set())
    await attempt(() => window.reports.removeBuilds(report.id, ids), `Removed ${ids.length} ${ids.length === 1 ? 'build' : 'builds'} from the report.`)
  }

  const deleteReport = async (): Promise<void> => {
    setBusy(true)
    try {
      if (await window.reports.remove(report.id)) onDeleted(report.id)
      else onError('That report is no longer available.')
    } finally {
      setBusy(false)
    }
  }

  const exportFile = async (kind: 'json' | 'markdown'): Promise<void> => {
    setBusy(true)
    try {
      const result = kind === 'json' ? await window.reports.exportJson(report.id) : await window.reports.exportMarkdown(report.id)
      if (result.canceled) return
      if (!result.ok) onError(result.error ?? 'Could not save the report.')
      else onNotice(`Saved the report to ${result.filePath}.`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <div className="mb-2 flex max-w-3xl items-center gap-2">
        {renaming ? (
          <>
            <input
              value={nameDraft}
              onChange={(event) => setNameDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void saveName()
                if (event.key === 'Escape') {
                  setNameDraft(report.name)
                  setRenaming(false)
                }
              }}
              autoFocus
              maxLength={80}
              aria-label="Report name"
              className="h-10 min-w-0 flex-1 rounded-lg border border-[#514947] bg-[#181414] px-3 text-[20px] font-semibold text-[#eeeae7] outline-none focus:border-[#716763]"
            />
            <button type="button" onClick={() => void saveName()} aria-label="Save report name" className="grid size-9 place-items-center rounded-lg text-[#9f9895] hover:bg-white/[0.05] hover:text-white">
              <Check className="size-4" />
            </button>
          </>
        ) : (
          <>
            <h1 className="line-clamp-2 text-[22px] font-semibold leading-tight tracking-[-0.02em] text-[#eeeae7]">{report.name}</h1>
            <button
              type="button"
              onClick={() => {
                setNameDraft(report.name)
                setRenaming(true)
              }}
              aria-label="Rename report"
              className="grid size-8 shrink-0 place-items-center rounded-lg text-[#68615f] hover:bg-white/[0.05] hover:text-[#ded9d6]"
            >
              <Pencil className="size-3.5" />
            </button>
          </>
        )}
      </div>

      <p className="mb-5 text-[11px] text-[#68615f]">
        {report.rows.length} {report.rows.length === 1 ? 'build' : 'builds'} · numbers captured {new Date(report.capturedAt).toLocaleString()}
      </p>

      <div className="mb-5 flex flex-wrap gap-2">
        <Button variant="outline" className="border-[#494343] bg-transparent text-[#96908d] hover:bg-white/5 hover:text-white" disabled={busy} onClick={() => setAdding(true)}>
          <Plus /> Add attempts
        </Button>
        <Button
          variant="outline"
          className="border-[#494343] bg-transparent text-[#96908d] hover:bg-white/5 hover:text-white"
          disabled={busy}
          title="Pull today's numbers for any build still on this machine"
          onClick={() => void attempt(() => window.reports.refresh(report.id), 'Pulled fresh numbers from the ledger.')}
        >
          <RefreshCw /> Refresh from ledger
        </Button>
        <Button variant="outline" className="border-[#494343] bg-transparent text-[#96908d] hover:bg-white/5 hover:text-white" disabled={busy} onClick={() => void exportFile('json')}>
          <Upload /> Export
        </Button>
        <Button variant="outline" className="border-[#494343] bg-transparent text-[#96908d] hover:bg-white/5 hover:text-white" disabled={busy} onClick={() => void exportFile('markdown')}>
          <FileText /> Markdown
        </Button>
        {checked.size > 0 && (
          <Button
            variant="outline"
            className="border-[#6b4a44] bg-transparent text-[#f0b8aa] hover:bg-[#3a2622] hover:text-[#f7cec2]"
            disabled={busy}
            onClick={() => void removeChecked()}
          >
            <X /> Remove {checked.size}
          </Button>
        )}
        <Button
          variant="outline"
          className="ml-auto border-[#6b4a44] bg-transparent text-[#f0b8aa] hover:bg-[#3a2622] hover:text-[#f7cec2]"
          disabled={busy}
          title="Delete this report. The builds themselves are not touched."
          onClick={() => void deleteReport()}
        >
          <Trash2 /> Delete report
        </Button>
      </div>

      {mixed && (
        <p className="mb-5 rounded-lg border border-amber-700/40 bg-amber-950/20 px-3 py-2.5 text-xs leading-relaxed text-amber-300">
          These attempts did not all use the same prompt — the hash column differs. Compare the rows one at a time; the totals row is not a like-for-like race.
        </p>
      )}

      {report.rows.length === 0 ? (
        <p className="rounded-lg border border-[#332e2e] bg-[#151212] px-4 py-6 text-center text-[12px] text-[#88817e]">
          This report has no attempts yet. Use <span className="text-[#c2bbb7]">Add builds</span> to put some in.
        </p>
      ) : (
        <div className="mb-5 overflow-hidden rounded-lg border border-[#332e2e]">
          <Table>
            <TableHeader>
              <TableRow className="border-[#3b3636] hover:bg-transparent">
                <TableHead className="w-8 px-2" />
                <TableHead className="w-8 px-2" />
                <TableHead className="px-2 text-[11px] text-[#68615f]">Build</TableHead>
                <TableHead className="px-2 text-[11px] text-[#68615f]">Orchestrator / Implementer / Critic</TableHead>
                <TableHead className="px-2 text-[11px] text-[#68615f]">Outcome</TableHead>
                <TableHead className="px-2 text-[11px] text-[#68615f]">Score</TableHead>
                <TableHead className="px-2 text-[11px] text-[#68615f]">Rounds</TableHead>
                <TableHead className="px-2 text-[11px] text-[#68615f]">Cost</TableHead>
                <TableHead className="px-2 text-[11px] text-[#68615f]">Tokens</TableHead>
                <TableHead className="px-2 text-[11px] text-[#68615f]" title="Wall clock from first start to last finish, and the attempt durations added up">Time</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody className="text-xs">
              {report.rows.map((row) => {
                const open = expanded.has(row.buildId)
                return [
                  <TableRow key={row.buildId} className="border-[#2a2626] hover:bg-white/[0.02]">
                    <TableCell className="px-2 py-3">
                      <Checkbox
                        checked={checked.has(row.buildId)}
                        label={`Select ${row.title}`}
                        onChange={() =>
                          setChecked((current) => {
                            const next = new Set(current)
                            if (next.has(row.buildId)) next.delete(row.buildId)
                            else next.add(row.buildId)
                            return next
                          })
                        }
                      />
                    </TableCell>
                    <TableCell className="px-2 py-3">
                      <button
                        type="button"
                        aria-label={`${open ? 'Hide' : 'Show'} rounds for ${row.title}`}
                        onClick={() =>
                          setExpanded((current) => {
                            const next = new Set(current)
                            if (next.has(row.buildId)) next.delete(row.buildId)
                            else next.add(row.buildId)
                            return next
                          })
                        }
                        className="grid size-5 place-items-center rounded text-[#716b68] hover:text-[#c9c3c0]"
                      >
                        {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
                      </button>
                    </TableCell>
                    <TableCell className="max-w-[200px] px-2 py-3">
                      <div className="truncate text-[#ded9d6]" title={row.title}>{row.title}</div>
                      <div className="truncate text-[10px] text-[#68615f]" title={row.workspaceDir}>{row.workspaceDir}</div>
                      <div
                        className="font-mono text-[10px] text-[#9fb2c8]"
                        title={`Prompt hash — same brief, same hash.\n\n${row.prompt.slice(0, 500)}`}
                      >
                        {shortHash(row.promptHash)}
                      </div>
                    </TableCell>
                    <TableCell className="px-2 py-3 text-[10px] leading-[1.5] text-[#8f8885]">
                      {setupLines(row).map((line) => <div key={line}>{line}</div>)}
                    </TableCell>
                    <TableCell className="px-2 py-3" title={row.stopReason ?? undefined}>
                      <Badge className={`border px-2 py-0.5 text-[10px] uppercase tracking-wide ${REPORT_STATUS_STYLES[row.status] ?? ''}`}>{row.status}</Badge>
                    </TableCell>
                    <TableCell className="px-2 py-3 font-mono text-[11px] text-[#f2d98c]">
                      {row.bestScore?.toFixed(2) ?? '—'}
                      {row.passedAtRound != null && <div className="text-[10px] text-emerald-300/80">passed r{row.passedAtRound}</div>}
                    </TableCell>
                    <TableCell className="px-2 py-3 font-mono text-[11px] text-[#c2bbb7]">{row.roundsUsed} / {row.maxRounds}</TableCell>
                    <TableCell className="px-2 py-3 font-mono text-[#b7cbe0]">
                      {fmtUsd(row.costUsd)}
                      {row.budgetUsd != null && <div className="text-[10px] text-[#68615f]">of {fmtUsd(row.budgetUsd)}</div>}
                    </TableCell>
                    <TableCell
                      className="px-2 py-3 font-mono text-[11px] text-[#c2bbb7]"
                      title={`${(row.inputTokens + row.outputTokens).toLocaleString()} combined · ${row.inputTokens.toLocaleString()} input (cache included) / ${row.outputTokens.toLocaleString()} output`}
                    >
                      {fmtTokens(row.inputTokens + row.outputTokens)}
                      <div className="text-[10px] text-[#77706d]">{fmtTokens(row.inputTokens)} / {fmtTokens(row.outputTokens)}</div>
                    </TableCell>
                    <TableCell className="px-2 py-3 font-mono text-[11px] text-[#b8aaa4]" title="Wall clock, then time actually spent inside attempts">
                      {fmtSpan(row.wallClockMs)}
                      <div className="text-[10px] text-[#77706d]">{fmtSpan(row.activeMs)} active</div>
                    </TableCell>
                  </TableRow>,
                  open ? (
                    <TableRow key={`${row.buildId}-rounds`} className="border-[#2a2626] bg-[#131010] hover:bg-[#131010]">
                      <TableCell colSpan={10} className="p-0">
                        <RoundBreakdown row={row} />
                      </TableCell>
                    </TableRow>
                  ) : null,
                ]
              })}
              <TableRow className="border-t-2 border-[#4a4342] bg-[#181414] font-medium hover:bg-[#181414]">
                <TableCell colSpan={5} className="px-4 py-3 text-[11px] uppercase tracking-wide text-[#8f8885]">
                  Total · {totals.attempts} {totals.attempts === 1 ? 'build' : 'builds'}
                </TableCell>
                <TableCell className="px-2 py-3 font-mono text-[11px] text-[#f2d98c]">{bestOverall == null ? '—' : `best ${bestOverall.toFixed(2)}`}</TableCell>
                <TableCell className="px-2 py-3 font-mono text-[11px] text-[#c2bbb7]">{totals.rounds}</TableCell>
                <TableCell className="px-2 py-3 font-mono text-[#b7cbe0]">{fmtUsd(totals.costUsd)}</TableCell>
                <TableCell className="px-2 py-3 font-mono text-[11px] text-[#c2bbb7]">
                  {fmtTokens(totals.inputTokens + totals.outputTokens)}
                  <div className="text-[10px] text-[#77706d]">{fmtTokens(totals.inputTokens)} / {fmtTokens(totals.outputTokens)}</div>
                </TableCell>
                <TableCell className="px-2 py-3 font-mono text-[11px] text-[#b8aaa4]">
                  {fmtSpan(totals.wallClockMs)}
                  <div className="text-[10px] text-[#77706d]">{fmtSpan(totals.activeMs)} active</div>
                </TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </div>
      )}

      <p className="text-[11px] leading-relaxed text-[#68615f]">
        Input tokens include cache reads and writes, so the total is input plus output. Costs are equivalent API cost estimates; the attempts themselves used
        subscription logins. Numbers are frozen at capture time — use Refresh from ledger to pull them again.
      </p>

      {adding && (
        <AddBuildsModal
          snapshots={snapshots}
          present={new Set(report.rows.map((row) => row.buildId))}
          busy={busy}
          onClose={() => setAdding(false)}
          onAdd={(buildIds) => {
            setAdding(false)
            void attempt(() => window.reports.addBuilds(report.id, buildIds), `Added ${buildIds.length} ${buildIds.length === 1 ? 'build' : 'builds'} to the report.`)
          }}
        />
      )}
    </>
  )
}

export function DeleteBuildsDialog({
  count,
  deleteFiles,
  busy,
  onToggleFiles,
  onCancel,
  onConfirm,
}: {
  count: number
  deleteFiles: boolean
  busy: boolean
  onToggleFiles: () => void
  onCancel: () => void
  onConfirm: () => void
}): React.JSX.Element {
  const [typed, setTyped] = useState('')
  const armed = !deleteFiles || typed.trim().toUpperCase() === 'DELETE'
  return (
    <Modal title={`Delete ${count} ${count === 1 ? 'build' : 'builds'}?`} onClose={onCancel}>
      <div className="grid gap-3 p-4">
        <p className="text-[12px] leading-relaxed text-[#b5afac]">
          The {count === 1 ? 'build disappears' : 'builds disappear'} from this list. By default the project {count === 1 ? 'folder stays' : 'folders stay'} on
          disk, so <span className="text-[#ded9d6]">Import build</span> can bring {count === 1 ? 'it' : 'them'} back later.
        </p>
        <button
          type="button"
          role="checkbox"
          aria-checked={deleteFiles}
          onClick={onToggleFiles}
          className="group flex items-start gap-2.5 rounded-lg border border-[#3d3737] bg-[#151212] p-3 text-left hover:border-[#514947]"
        >
          <span className="mt-0.5">
            <CheckMark checked={deleteFiles} />
          </span>
          <span>
            <span className="block text-[12px] text-[#ded9d6]">Also delete the project folders on disk</span>
            <span className="block text-[11px] leading-relaxed text-[#88817e]">
              Removes the generated code, Git history, and critic screenshots. This cannot be undone.
            </span>
          </span>
        </button>
        {deleteFiles && (
          <label className="grid gap-1.5 text-[11px] text-[#f0b8aa]">
            Type DELETE to confirm
            <input
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              autoFocus
              className="h-9 rounded-lg border border-[#6b4a44] bg-[#141010] px-3 text-xs text-[#eeeae7] outline-none focus:border-[#8a5c53]"
            />
          </label>
        )}
      </div>
      <div className="flex justify-end gap-2 border-t border-[#332e2e] px-4 py-3">
        <Button variant="outline" className="border-[#494343] bg-transparent text-[#96908d] hover:bg-white/5 hover:text-white" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          variant="outline"
          className="border-[#6b4a44] bg-transparent text-[#f0b8aa] hover:bg-[#3a2622] hover:text-[#f7cec2]"
          disabled={busy || !armed}
          onClick={onConfirm}
        >
          {busy ? <LoaderCircle className="animate-spin" /> : <Trash2 />} {deleteFiles ? 'Delete builds and files' : 'Delete builds'}
        </Button>
      </div>
    </Modal>
  )
}

export function NameReportDialog({
  defaultName,
  busy,
  count,
  onCancel,
  onConfirm,
}: {
  defaultName: string
  busy: boolean
  count: number
  onCancel: () => void
  onConfirm: (name: string) => void
}): React.JSX.Element {
  const [name, setName] = useState(defaultName)
  return (
    <Modal title={`New report from ${count} ${count === 1 ? 'build' : 'builds'}`} onClose={onCancel}>
      <div className="grid gap-2 p-4">
        <label className="grid gap-1.5 text-[11px] text-[#96908d]">
          Report name
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && name.trim()) onConfirm(name.trim())
            }}
            autoFocus
            maxLength={80}
            className="h-9 rounded-lg border border-[#393433] bg-[#141010] px-3 text-xs text-[#eeeae7] outline-none focus:border-[#5a524f]"
          />
        </label>
        <p className="text-[11px] leading-relaxed text-[#68615f]">
          The report copies each attempt's numbers as they stand right now, so it still reads correctly after you send it to someone else.
        </p>
      </div>
      <div className="flex justify-end gap-2 border-t border-[#332e2e] px-4 py-3">
        <Button variant="outline" className="border-[#494343] bg-transparent text-[#96908d] hover:bg-white/5 hover:text-white" onClick={onCancel}>
          Cancel
        </Button>
        <Button className="bg-[#eeeae7] text-[#1c1716] hover:bg-white" disabled={busy || !name.trim()} onClick={() => onConfirm(name.trim())}>
          {busy ? <LoaderCircle className="animate-spin" /> : null} Create report
        </Button>
      </div>
    </Modal>
  )
}
