import { useEffect, useState } from 'react'
import type { LoopRecord, RunRecord } from '../../../shared/loop'
import { LEAD_NOTEBOOK_FIELDS, LEAD_NOTEBOOK_LABELS, type LeadState } from '../../../shared/lead'
import { modelLabel } from '../../../shared/models'

function activity(loop: LoopRecord, active?: RunRecord | null): string {
  if (loop.status === 'passed') return 'Run passed'
  if (loop.status === 'exhausted') return 'Round limit reached'
  if (loop.status === 'failed') return 'Needs attention'
  if (loop.status !== 'running') return 'Paused'
  if (active?.role === 'reference') return 'Awaiting Reference Study'
  if (active?.role === 'critique') return 'Awaiting independent critique'
  return active?.status === 'running' ? `Implementing round ${active.round}` : 'Awaiting implementation'
}

/** One run-wide identity and an inspectable memory history; phase attempts retain their own logs. */
export function LeadPanel({ loop, active }: { loop: LoopRecord; active?: RunRecord | null }): React.JSX.Element | null {
  const [state, setState] = useState<LeadState | null>(null)
  const [error, setError] = useState('')
  const [offset, setOffset] = useState(0)
  const [selected, setSelected] = useState<string | null>(null)
  const [refresh, setRefresh] = useState(0)
  useEffect(() => {
    let alive = true, sequence = 0
    const load = async (): Promise<void> => {
      const request = ++sequence
      try {
        const result = await window.loops.lead(loop.id, offset)
        if (!alive || request !== sequence) return
        if (!result.ok) throw new Error(result.error)
        setState(result.value); setError('')
      } catch (failure) {
        if (alive && request === sequence) setError(failure instanceof Error ? failure.message : 'Could not load lead memory.')
      }
    }
    void load()
    const off = window.loops.onUpdate(snapshot => { if (snapshot.loop.id === loop.id) void load() })
    return () => { alive = false; off() }
  }, [loop.id, offset, refresh])
  if (!error && !state?.enabled) return null
  const checkpoint = state?.checkpoints.find(item => item.runId === selected) ?? state?.checkpoints[0]
  return <div className="mb-5 border-b border-[#332e2e] pb-3 text-xs text-[#aaa09a]">
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <span className="font-medium text-[#ddd5cf]">Run lead · {modelLabel(loop.models.orchestratorModel)}</span>
      <span>{activity(loop, active)}</span>
      {state?.dispatch && <span className="text-[#8d837d]">{state.dispatch.mode === 'continued' ? 'Continuing session' : state.dispatch.mode === 'recovered' ? 'Fresh session · restored memory' : 'Initial session'}</span>}
    </div>
    {error && <p role="alert" className="mt-2 text-amber-200">{error} <button type="button" className="underline" onClick={() => setRefresh(value => value + 1)}>Retry</button></p>}
    <details className="mt-2">
      <summary className="cursor-pointer text-[#c6b8ae]">Lead notebook{checkpoint ? ` · round ${checkpoint.round}` : ' · awaiting first checkpoint'}</summary>
      <div className="mt-3 max-w-3xl space-y-3">
        {state?.dispatch && <p>{state.dispatch.reason}</p>}
        <p className="text-[#8d837d]">The lead’s saved working notes may be stale. Your included directions take precedence. Steering uses these notes to answer questions; verification remains recorded with each round.</p>
        {!!state?.checkpoints.length && <label className="flex flex-wrap items-center gap-2">Saved attempt
          <select aria-label="Lead notebook version" value={checkpoint?.runId ?? ''} onChange={event => setSelected(event.target.value)} className="max-w-full rounded border border-[#49413c] bg-[#181414] p-1.5 text-[#ddd5cf]">
            {state.checkpoints.map(item => <option key={item.runId} value={item.runId}>Round {item.round} · {new Date(item.createdAt).toLocaleString()} · {item.runId.slice(0, 8)}</option>)}
          </select>
        </label>}
        {checkpoint?.warning && <p className="text-amber-200">{checkpoint.warning}</p>}
        {checkpoint?.notebook ? <dl className="space-y-3">
          {LEAD_NOTEBOOK_FIELDS.map(field => <div key={field}><dt className="mb-1 font-medium text-[#ddd5cf]">{LEAD_NOTEBOOK_LABELS[field]}</dt><dd className="whitespace-pre-wrap break-words leading-relaxed">{checkpoint.notebook![field] || 'Not recorded'}</dd></div>)}
        </dl> : checkpoint?.report ? <p className="whitespace-pre-wrap break-words">{checkpoint.report}</p> : <p>No working notes have been returned for this attempt.</p>}
        {state && state.totalCheckpoints > 20 && <div className="flex gap-3">
          {offset > 0 && <button type="button" className="underline" onClick={() => { setOffset(Math.max(0, offset - 20)); setSelected(null) }}>Newer notes</button>}
          {offset + state.checkpoints.length < state.totalCheckpoints && <button type="button" className="underline" onClick={() => { setOffset(offset + 20); setSelected(null) }}>Older notes</button>}
          <span>{offset + 1}–{offset + state.checkpoints.length} of {state.totalCheckpoints}</span>
        </div>}
      </div>
    </details>
  </div>
}
