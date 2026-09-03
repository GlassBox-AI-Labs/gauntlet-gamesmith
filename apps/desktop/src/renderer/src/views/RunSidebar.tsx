import { BarChart3, Check, ChevronDown, ChevronRight, Download, Minus, Pencil, Plus, Sparkles, Trash2 } from 'lucide-react'
import type { LoopSnapshot } from '../../../shared/loop'
import type { ReportRecord } from '../../../shared/reports'

export const RUN_ROUNDS_PAGE_SIZE = 3

function projectName(workspaceDir: string): string {
  return workspaceDir.split(/[\\/]/).filter(Boolean).at(-1) ?? 'Choose project'
}

function roundNumbers(snapshot: LoopSnapshot): number[] {
  return [...new Set(snapshot.runs.filter((run) => run.round > 0).map((run) => run.round))]
    .sort((a, b) => b - a)
}

function RunCheckbox({ checked, mixed = false, label, onToggle }: { checked: boolean; mixed?: boolean; label: string; onToggle: () => void }): React.JSX.Element {
  const filled = checked || mixed
  return (
    <button type="button" role="checkbox" aria-checked={mixed ? 'mixed' : checked} aria-label={label} onClick={onToggle} style={{ borderColor: filled ? '#c2bbb7' : '#8a827f' }} className={`grid size-4 shrink-0 place-items-center rounded border transition-colors ${filled ? 'bg-[#c2bbb7] text-[#1c1716]' : 'text-transparent'}`}>
      {mixed ? <Minus className="size-3" strokeWidth={3} /> : <Check className="size-3" strokeWidth={3} />}
    </button>
  )
}

export interface RunSidebarProps {
  snapshots: LoopSnapshot[]
  reports: ReportRecord[]
  selectedLoopId: string | null
  selectedReportId: string | null
  selectedRound: number | null
  expandedRuns: Set<string>
  visibleRounds: Record<string, number>
  editing: boolean
  checkedRuns: Set<string>
  onNewRun: () => void
  onImportRun: () => void
  onSelectRun: (snapshot: LoopSnapshot) => void
  onSelectRound: (snapshot: LoopSnapshot, round: number) => void
  onToggleRun: (loopId: string) => void
  onLoadMore: (loopId: string) => void
  onOpenAgents: () => void
  onToggleEditing: () => void
  onToggleChecked: (loopId: string) => void
  onToggleAllChecked: () => void
  onDeleteChecked: () => void
  onCreateReport: () => void
  onSelectReport: (report: ReportRecord) => void
  onImportReport: () => void
  onLoadOlderHistories: () => void
  onLoadNewestHistories: () => void
  busy: boolean
  historyWarning: string | null
  hasMoreHistories: boolean
  hasNewerHistories: boolean
}

export function RunSidebar({
  snapshots,
  reports,
  selectedLoopId,
  selectedReportId,
  selectedRound,
  expandedRuns,
  visibleRounds,
  editing,
  checkedRuns,
  onNewRun,
  onImportRun,
  onSelectRun,
  onSelectRound,
  onToggleRun,
  onLoadMore,
  onOpenAgents,
  onToggleEditing,
  onToggleChecked,
  onToggleAllChecked,
  onDeleteChecked,
  onCreateReport,
  onSelectReport,
  onImportReport,
  onLoadOlderHistories,
  onLoadNewestHistories,
  busy,
  historyWarning,
  hasMoreHistories,
  hasNewerHistories,
}: RunSidebarProps): React.JSX.Element {
  const checkedCount = checkedRuns.size
  const allChecked = snapshots.length > 0 && checkedCount === snapshots.length
  return (
    <aside className="flex h-screen w-[252px] shrink-0 flex-col border-r border-[#2a2626] bg-[#141112]">
      <div className="px-3 pb-3 pt-5">
        <button type="button" onClick={onNewRun} disabled={busy} className="flex w-full items-center gap-2 rounded-lg px-3 py-2.5 text-left text-[14px] font-medium text-[#ded9d6] transition-colors hover:bg-white/[0.05] hover:text-white disabled:cursor-not-allowed disabled:opacity-40">
          <Plus className="size-4" /> Run
        </button>
        <button type="button" onClick={onImportRun} disabled={busy} className="mt-1 flex w-full items-center gap-2 rounded-lg px-3 py-2.5 text-left text-[13px] text-[#918a87] transition-colors hover:bg-white/[0.05] hover:text-[#ded9d6] disabled:cursor-not-allowed disabled:opacity-40">
          <Download className="size-4" /> Import run
        </button>
      </div>
      <div className="border-t border-[#2f2a2b]" />
      <div className="min-h-0 flex-1 overflow-y-auto px-2.5 py-4">
        {editing ? (
          <div className="mb-2 flex items-center gap-1">
            <span className="pl-2 pr-1"><RunCheckbox checked={allChecked} mixed={checkedCount > 0 && !allChecked} label={allChecked ? 'Select none' : 'Select all runs'} onToggle={onToggleAllChecked} /></span>
            <button type="button" onClick={onDeleteChecked} disabled={checkedCount === 0} className="flex flex-1 items-center justify-center gap-1 rounded-md px-1.5 py-1.5 text-[11px] text-[#f0b8aa] hover:bg-[#3a2622] disabled:cursor-not-allowed disabled:text-[#5e5654] disabled:hover:bg-transparent"><Trash2 className="size-3.5" /> Delete</button>
            <button type="button" onClick={onCreateReport} disabled={checkedCount === 0} className="flex flex-1 items-center justify-center gap-1 rounded-md px-1.5 py-1.5 text-[11px] text-[#a8c8e0] hover:bg-white/[0.05] disabled:cursor-not-allowed disabled:text-[#5e5654] disabled:hover:bg-transparent"><BarChart3 className="size-3.5" /> Report</button>
            <button type="button" onClick={onToggleEditing} className="flex flex-1 items-center justify-center gap-1 rounded-md px-1.5 py-1.5 text-[11px] text-[#c2bbb7] hover:bg-white/[0.05] hover:text-white"><Check className="size-3.5" /> Done</button>
          </div>
        ) : (
          <div className="mb-2 flex items-center justify-between pl-2">
            <span className="text-[13px] font-medium text-[#8d8784]">Runs</span>
            <button type="button" onClick={onToggleEditing} disabled={snapshots.length === 0} aria-label="Edit runs" title="Select runs to delete or turn into a report" className="grid size-6 place-items-center rounded-md text-[#68615f] hover:bg-white/[0.05] hover:text-[#ded9d6] disabled:cursor-not-allowed disabled:text-[#463f3e]"><Pencil className="size-3.5" /></button>
          </div>
        )}
        {historyWarning && <p className="mb-2 px-2 text-[11px] leading-relaxed text-amber-300/80">{historyWarning}</p>}
        <div className="grid gap-1">
          {snapshots.map((item) => {
            const loopId = item.loop.id
            const rounds = roundNumbers(item)
            const limit = visibleRounds[loopId] ?? RUN_ROUNDS_PAGE_SIZE
            const open = expandedRuns.has(loopId)
            const selected = selectedLoopId === loopId
            const label = projectName(item.loop.workspaceDir)
            return (
              <div key={loopId}>
                <div className={`group flex items-center rounded-lg pr-1 transition-colors ${selected ? 'bg-[#302b2b] text-[#eeeae7]' : 'text-[#aaa4a1] hover:bg-white/[0.035] hover:text-[#ded9d6]'}`}>
                  {editing && <span className="pl-2 pr-1"><RunCheckbox checked={checkedRuns.has(loopId)} label={`Select ${label}`} onToggle={() => onToggleChecked(loopId)} /></span>}
                  <button type="button" onClick={() => onToggleRun(loopId)} className="grid size-8 shrink-0 place-items-center rounded-md text-[#716b68] hover:text-[#c9c3c0]" aria-expanded={open} aria-controls={`sidebar-rounds-${loopId}`} aria-label={`${open ? 'Collapse' : 'Expand'} ${label}`}>
                    {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
                  </button>
                  <button type="button" onClick={() => onSelectRun(item)} title={item.loop.workspaceDir} className="min-w-0 flex-1 truncate py-2 pr-2 text-left text-[13px]">{label}</button>
                  {item.loop.status === 'running' && <span className="mr-2 flex shrink-0 items-center gap-1 text-[10px] text-amber-300"><span className="size-1.5 animate-pulse rounded-full bg-amber-400" aria-hidden="true" /> running</span>}
                </div>
                {open && (
                  <div id={`sidebar-rounds-${loopId}`} className="ml-8 border-l border-[#332f2f] pb-1 pl-2 pt-1">
                    {rounds.slice(0, limit).map((round) => {
                      const records = item.runs.filter((run) => run.round === round)
                      const score = records.find((run) => run.verdict)?.verdict?.score
                      const active = records.some((run) => run.status === 'running' || run.status === 'queued')
                      return (
                        <button type="button" key={round} onClick={() => onSelectRound(item, round)} className={`flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-[12px] hover:bg-white/[0.035] hover:text-[#c9c3c0] ${selectedLoopId === loopId && selectedRound === round ? 'bg-white/[0.055] text-[#ded9d6]' : 'text-[#88817e]'}`}>
                          <span>Round {round}</span><span className={active ? 'text-amber-300' : 'font-mono text-[10px] text-[#68615f]'}>{active ? 'active' : score != null ? score.toFixed(2) : ''}</span>
                        </button>
                      )
                    })}
                    {rounds.length > limit && <button type="button" onClick={() => onLoadMore(loopId)} className="mt-1 w-full rounded-md px-2 py-1.5 text-left text-[12px] text-[#77706d] hover:bg-white/[0.035] hover:text-[#c9c3c0]">Load more</button>}
                  </div>
                )}
              </div>
            )
          })}
          {snapshots.length === 0 && <p className="px-2 py-3 text-xs leading-relaxed text-[#68615f]">Your runs will appear here.</p>}
        </div>
        {(hasNewerHistories || hasMoreHistories) && <div className="mt-3 grid gap-2">
          {hasNewerHistories && <button type="button" onClick={onLoadNewestHistories} disabled={busy} className="w-full rounded-md border border-[#332f2f] px-2 py-2 text-[12px] text-[#88817e] hover:bg-white/[0.035] hover:text-[#c9c3c0] disabled:cursor-not-allowed disabled:opacity-40">Newest histories</button>}
          {hasMoreHistories && <button type="button" onClick={onLoadOlderHistories} disabled={busy} className="w-full rounded-md border border-[#332f2f] px-2 py-2 text-[12px] text-[#88817e] hover:bg-white/[0.035] hover:text-[#c9c3c0] disabled:cursor-not-allowed disabled:opacity-40">Older histories</button>}
        </div>}
        <div className="mb-2 mt-6 flex items-center justify-between pl-2">
          <span className="text-[13px] font-medium text-[#8d8784]">Reports</span>
          <button type="button" onClick={onImportReport} aria-label="Import a report" title="Open a report a teammate sent you" className="grid size-6 place-items-center rounded-md text-[#68615f] hover:bg-white/[0.05] hover:text-[#ded9d6]"><Download className="size-3.5" /></button>
        </div>
        <div className="grid gap-1">
          {reports.map((report) => (
            <button key={report.id} type="button" onClick={() => onSelectReport(report)} className={`flex items-center gap-2 rounded-lg px-2 py-2 text-left text-[13px] ${selectedReportId === report.id ? 'bg-[#302b2b] text-[#eeeae7]' : 'text-[#aaa4a1] hover:bg-white/[0.035] hover:text-[#ded9d6]'}`}>
              <BarChart3 className="size-3.5 shrink-0 text-[#716b68]" /><span className="min-w-0 flex-1 truncate">{report.name}</span><span className="shrink-0 font-mono text-[10px] text-[#68615f]">{report.rows.length}</span>
            </button>
          ))}
          {reports.length === 0 && <p className="px-2 py-3 text-xs leading-relaxed text-[#68615f]">Compare runs side by side: select runs with the pencil, then choose Report.</p>}
        </div>
      </div>
      <div className="border-t border-[#2f2a2b] p-3">
        <button type="button" onClick={onOpenAgents} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-[13px] text-[#88817e] hover:bg-white/[0.04] hover:text-[#ded9d6]"><Sparkles className="size-3.5" /> Agents</button>
      </div>
    </aside>
  )
}
