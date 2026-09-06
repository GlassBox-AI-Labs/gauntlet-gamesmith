import { useEffect, useRef, useState } from 'react'
import { ArrowUp, File, Paperclip, PanelRightClose, PanelRightOpen, LoaderCircle, X } from 'lucide-react'
import type { SteeringState, SteeringAttachment } from '../../../shared/steering'
import { DEFAULT_STEERING_MODEL, STEERING_MODEL_CHOICES, MAX_STEERING_MESSAGE, MAX_STEERING_FILES } from '../../../shared/steering'
import type { RunAttachment } from '../../../shared/attachments'
import './steering.css'

function Attachment({ file, runId, onRemove }: { file: RunAttachment | SteeringAttachment; runId?: string; onRemove?: () => void }) {
  const [preview, setPreview] = useState('')
  useEffect(() => {
    if (file.kind !== 'image') return
    let alive = true
    const request = runId ? window.steering.preview({ loopId: runId, attachmentId: file.id }) : window.attachments.preview(file.id)
    void request.then(result => { if (alive && result.ok) setPreview(result.value) }).catch(() => {})
    return () => { alive = false }
  }, [file.id, file.kind, runId])
  return <div className="steering-attachment" title={file.name}>
    {preview ? <img src={preview} alt={file.name} /> : <File size={18} aria-hidden="true" />}
    <div><span>{file.name}</span><small>{file.bytes >= 1048576 ? `${(file.bytes / 1048576).toFixed(1)} MB` : `${Math.ceil(file.bytes / 1024)} KB`}</small></div>
    {onRemove && <button type="button" aria-label={`Remove ${file.name}`} onClick={onRemove}><X size={14} /></button>}
  </div>
}

export function SteeringSidebar({ loopStatus, runName, runId, round }: { loopStatus: string; runName: string; runId: string; round: number }) {
  const [collapsed, setCollapsed] = useState(false)
  const [state, setState] = useState<SteeringState>({ loopId: runId, model: DEFAULT_STEERING_MODEL, messages: [], directives: [], busy: false })
  const [draft, setDraft] = useState('')
  const [files, setFiles] = useState<RunAttachment[]>([])
  const [attaching, setAttaching] = useState(false)
  const [sending, setSending] = useState(false)
  const [savingModel, setSavingModel] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState('')
  const [loadVersion, setLoadVersion] = useState(0)
  const retry = useRef<{ key: string; id: string } | null>(null)
  const bottom = useRef<HTMLDivElement>(null)
  const updated = useRef(0)
  const mounted = useRef(true)
  const draftFiles = useRef<RunAttachment[]>([])
  const release = (ids: string[]) => { for (const id of ids) void window.attachments.remove(id).catch(() => {}) }
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; release(draftFiles.current.map(file => file.id)) }
  }, [runId])
  useEffect(() => {
    let alive = true
    setError('')
    const off = window.steering.onUpdate(next => { if (next.loopId === runId) { updated.current++; setState(next); setLoaded(true) } })
    const version = updated.current
    void window.steering.history(runId).then(result => {
      if (!result.ok) throw new Error(result.error)
      if (alive) { if (updated.current === version) setState(result.value); setLoaded(true) }
    }).catch(error => { if (alive) setError(String(error)) })
    return () => { alive = false; off() }
  }, [runId, loadVersion])
  useEffect(() => { bottom.current?.scrollIntoView({ block: 'nearest' }) }, [state.messages.length, state.busy, collapsed])
  const busy = state.busy || sending

  async function attach(dropped?: globalThis.File[]) {
    if (attaching || sending) return
    setAttaching(true); setError('')
    try {
      const result = await (dropped ? window.attachments.addFiles(dropped) : window.attachments.pick())
      if (!result.ok) throw new Error(result.error)
      if (!mounted.current) { release(result.value.map(file => file.id)); return }
      const next = [...draftFiles.current, ...result.value]
      if (next.reduce((sum, file) => sum + file.files, 0) > MAX_STEERING_FILES) {
        release(result.value.map(file => file.id)); throw new Error('Attach up to 10 files per message.')
      }
      draftFiles.current = next; setFiles(next)
    } catch (error) { if (mounted.current) setError(error instanceof Error ? error.message : 'Could not attach files.') }
    finally { if (mounted.current) setAttaching(false) }
  }
  function remove(id: string) {
    if (sending) return
    draftFiles.current = draftFiles.current.filter(file => file.id !== id)
    setFiles(draftFiles.current); release([id])
  }
  async function selectModel(model: string) {
    if (savingModel || sending || !loaded) return
    const version = updated.current
    setSavingModel(true); setError('')
    try {
      const result = await window.steering.setModel({ loopId: runId, model })
      if (!result.ok) throw new Error(result.error)
      if (mounted.current && updated.current === version) setState(result.value)
    } catch (error) { if (mounted.current) setError(error instanceof Error ? error.message : 'Could not save the steering model.') }
    finally { if (mounted.current) setSavingModel(false) }
  }
  async function send() {
    if ((!draft.trim() && !files.length) || busy || attaching || savingModel || !loaded) return
    const content = draft.trim(), version = updated.current, attachmentIds = files.map(file => file.id)
    const key = JSON.stringify({ content, attachmentIds })
    if (retry.current?.key !== key) retry.current = { key, id: crypto.randomUUID() }
    setSending(true); setError('')
    try {
      const result = await window.steering.send({ loopId: runId, messageId: retry.current.id, content, attachmentIds })
      if (!result.ok) throw new Error(result.error)
      if (mounted.current) {
        if (updated.current === version) setState(result.value)
        setDraft(''); setFiles([]); draftFiles.current = []; retry.current = null
      }
      release(attachmentIds)
    } catch (error) { if (mounted.current) setError(error instanceof Error ? error.message : 'Could not send your message.') }
    finally { if (mounted.current) setSending(false) }
  }
  async function cancel() {
    try { const result = await window.steering.cancel(runId); if (!result.ok) throw new Error(result.error) }
    catch (error) { if (mounted.current) setError(String(error)) }
  }
  async function withdraw(id: string) {
    try { const result = await window.steering.withdraw({ loopId: runId, directiveId: id }); if (!result.ok) throw new Error(result.error) }
    catch (error) { if (mounted.current) setError(String(error)) }
  }
  const timing = loopStatus === 'running' ? 'New directions enter the next implementation attempt' : ['stopped', 'failed'].includes(loopStatus) ? 'Resume includes queued directions when retrying implementation' : 'Directions wait for another implementation attempt'
  return <aside className={`steering-run-sidebar ${collapsed ? 'is-collapsed' : ''}`} aria-label={`Steering for ${runName}`} onDragOver={event => { if (event.dataTransfer.types.includes('Files')) event.preventDefault() }} onDrop={event => { event.preventDefault(); if (event.dataTransfer.files.length) void attach(Array.from(event.dataTransfer.files)) }}>
    <div className="steering-sidebar-header">
      <button aria-label={collapsed ? 'Expand steering' : 'Collapse steering'} aria-expanded={!collapsed} onClick={() => setCollapsed(!collapsed)}>{collapsed ? <PanelRightOpen size={18} /> : <PanelRightClose size={18} />}</button>
      {!collapsed && <div><h2>Steering</h2><p>{runName} · Round {round}</p></div>}
    </div>
    {collapsed && <button className="steering-rail-label" onClick={() => setCollapsed(false)}>Steering{busy ? ' · Thinking' : ''}</button>}
    <div className="steering-sidebar-expanded" hidden={collapsed}>
      <div className="steering-chat" role="log" aria-label="Run conversation" aria-live="polite">
        {!loaded && !error && <span className="steering-thinking">Loading conversation…</span>}
        {state.messages.map(message => <div key={message.id} className={`steering-message ${message.role}`}>
          {message.role !== 'system' && <span>{message.role === 'user' ? 'You' : 'Steering assistant'}</span>}
          {!!message.attachments?.length && <div className="steering-attachments">{message.attachments.map(file => <Attachment key={file.id} file={file} runId={runId} />)}</div>}
          {message.content && <p>{message.content}</p>}
          {state.directives.filter(d => d.messageId === message.id).map(d => <div className="steering-direction-status" key={d.id} title={d.text}>
            <span>{d.withdrawn ? 'Withdrawn' : d.firstRound != null ? `Included in round ${d.firstRound} · persists` : 'Queued · ' + timing.toLowerCase()}</span>
            {!d.withdrawn && !d.firstRunId && <button onClick={() => void withdraw(d.id)} aria-label={`Withdraw direction: ${d.text}`}>Withdraw</button>}
          </div>)}
        </div>)}
        {busy && <div className="steering-thinking"><LoaderCircle size={14} className="animate-spin" />Thinking…</div>}
        {error && <p className="steering-error" role="alert">{error}{!loaded && <button type="button" onClick={() => setLoadVersion(value => value + 1)}>Retry</button>}</p>}
        <div ref={bottom} />
      </div>
      <form className="steering-compose" onSubmit={event => { event.preventDefault(); void send() }}>
        {!!files.length && <div className="steering-attachments">{files.map(file => <Attachment key={file.id} file={file} onRemove={sending ? undefined : () => remove(file.id)} />)}</div>}
        <textarea aria-label="Message steering" placeholder="Message…" value={draft} maxLength={MAX_STEERING_MESSAGE} disabled={sending} onChange={event => setDraft(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send() } }} />
        <div className="steering-compose-actions">
          <button type="button" className="steering-attach-button" aria-label="Attach files or images" title="Attach files or images, or drop them here" disabled={attaching || sending} onClick={() => void attach()}>{attaching ? <LoaderCircle size={16} className="animate-spin" /> : <Paperclip size={16} />}</button>
          <select aria-label="Steering model" title="Codex model for the next reply · saved for this run" value={state.model} disabled={!loaded || savingModel || sending} onChange={event => void selectModel(event.target.value)}>
            {STEERING_MODEL_CHOICES.map(model => <option key={model.id} value={model.id}>{model.label.replace('Codex · ', '')}</option>)}
          </select>
          {busy ? <button type="button" onClick={() => void cancel()}>Stop response</button> : <button type="submit" aria-label="Send message" disabled={!loaded || attaching || savingModel || (!draft.trim() && !files.length)}><ArrowUp size={17} /></button>}
        </div>
      </form>
      <p className="steering-footnote">{timing}</p>
      <p className="steering-footnote">Steering answers questions separately from the run lead. Included directions persist and override earlier decisions.</p>
    </div>
  </aside>
}
