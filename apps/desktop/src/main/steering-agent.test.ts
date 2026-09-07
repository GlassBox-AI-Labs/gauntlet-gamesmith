import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createConsultAgent } from './steering-agent'
import { readProcessIdentity } from './attempt-process'

const fixture = vi.hoisted(() => ({ program: '' }))
vi.mock('./cli-executable', () => ({ cliExecutable: () => process.execPath }))
vi.mock('./harness-plans', () => ({ consultPlan: () => ['-e', fixture.program] }))
let root: string
function setup(program: string) {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'steering-process-'))
  fixture.program = program
  const privateDir = path.join(root, 'private')
  return { privateDir, agent: createConsultAgent(privateDir, () => ({ PATH: process.env.PATH! })) }
}
afterEach(() => { if (root) fs.rmSync(root, { recursive: true, force: true }) })

it('preserves actual raw streams, translates events, and reads a final JSON line without a newline', async () => {
  const reply = JSON.stringify({ reply: 'Use touch controls.', directives: [] })
  const fixtureEvents = [
    { type: 'thread.started', thread_id: 'fixture-session' },
    { type: 'error', message: 'Reconnecting... 5/5 (websocket closed)' },
    { type: 'item.completed', item: { type: 'agent_message', text: reply } },
    { type: 'future.event', value: 'preserve unknown events' },
    { type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 25, output_tokens: 20 } },
  ].map(event => JSON.stringify(event)).join('\n')
  const { agent, privateDir } = setup(`process.stdin.resume(); process.stdin.on('end',()=>{process.stdout.write(${JSON.stringify(fixtureEvents)});});`)
  const attemptId = crypto.randomUUID(), events: string[] = []
  const result = await agent({ attemptId, workspaceDir: root, prompt: 'question', model: 'gpt-5.6-sol', signal: new AbortController().signal, onEvent: event => events.push(event.text) })
  expect(result).toEqual({ text: reply, sessionId: 'fixture-session', tokens: { input: 75, cacheRead: 25, cacheWrite: 0, output: 20 }, cumulativeTokens: { input: 75, cacheRead: 25, cacheWrite: 0, output: 20 } })
  expect(events.some(text => text.includes('future.event'))).toBe(true)
  expect(events.some(text => text.includes('Reconnecting... 5/5'))).toBe(true)
  expect(events.some(text => text.includes('completed after recovering'))).toBe(true)
  expect(fs.existsSync(path.join(privateDir, `${attemptId}.process.json`))).toBe(false)
  const streams = path.join(root, '.gauntlet-gamesmith', 'runs')
  expect(fs.readFileSync(path.join(streams, `${attemptId}.out.ndjson`), 'utf8')).toBe(fixtureEvents)
})

it.each([
  { event: { type: 'error', message: 'unresolved disconnect' }, completion: false, exitCode: 0, error: 'unresolved disconnect' },
  { event: { type: 'turn.failed', error: { message: 'terminal failure' } }, completion: true, exitCode: 0, error: 'terminal failure' },
  { event: { type: 'error', message: 'reconnecting' }, completion: true, exitCode: 1, error: 'exit 1' },
])('rejects a chat with $error despite a reply', async ({ event, completion, exitCode, error }) => {
  const events = [event, { type: 'item.completed', item: { type: 'agent_message', text: 'A reply' } }, ...(completion ? [{ type: 'turn.completed' }] : [])]
    .map(event => JSON.stringify(event)).join('\n')
  const { agent } = setup(`process.stdin.resume(); process.stdin.on('end',()=>{process.stdout.write(${JSON.stringify(events)});process.exitCode=${exitCode};});`)
  await expect(agent({ attemptId: crypto.randomUUID(), workspaceDir: root, prompt: 'question', model: 'gpt-5.6-sol', signal: new AbortController().signal }))
    .rejects.toThrow(error)
})

it('settles a captured process on cancellation and removes its ownership record', async () => {
  const { agent, privateDir } = setup("process.stdin.resume(); setInterval(()=>{}, 1000)")
  const controller = new AbortController(), attemptId = crypto.randomUUID()
  let pid = 0
  const response = agent({ attemptId, workspaceDir: root, prompt: 'question', model: 'gpt-5.6-sol', signal: controller.signal, onStarted: () => {
    pid = JSON.parse(fs.readFileSync(path.join(privateDir, `${attemptId}.process.json`), 'utf8')).pid
    controller.abort()
  } })
  await expect(response).rejects.toThrow('Response stopped')
  expect(pid).toBeGreaterThan(1)
  expect(readProcessIdentity(pid)).toBeNull()
  expect(await agent.recover!(attemptId)).toBe(true)
}, 20000)

it('quarantines an incomplete ownership marker instead of claiming it was stopped', async () => {
  const { agent, privateDir } = setup('')
  fs.mkdirSync(privateDir)
  const attemptId = crypto.randomUUID()
  fs.writeFileSync(path.join(privateDir, `${attemptId}.process.json`), '{"state":"starting"}')
  expect(await agent.recover!(attemptId)).toBe(false)
})

it.each([false, true])('accounts for a resumed Codex Chat turn without charging prior usage (new session=%s)', async changed => {
  const events = [
    { type: 'thread.started', thread_id: changed ? 'new-session' : 'prior-session' },
    { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify({ reply: 'Answer', directives: [] }) } },
    ...Array.from({ length: 2 }, () => ({ type: 'turn.completed', usage: { input_tokens: 550, cached_input_tokens: 400, output_tokens: 65 } })),
  ].map(event => JSON.stringify(event)).join('\n')
  const { agent } = setup(`process.stdin.resume(); process.stdin.on('end',()=>process.stdout.write(${JSON.stringify(events)}));`)
  const onSession = vi.fn()
  const result = await agent({ attemptId: crypto.randomUUID(), workspaceDir: root, prompt: 'question', model: 'gpt-5.6-sol',
    resumeId: 'prior-session', usageBaseline: { input: 100, cacheRead: 300, cacheWrite: 0, output: 40 }, onSession, signal: new AbortController().signal })
  expect(onSession).toHaveBeenCalledWith(changed ? 'new-session' : 'prior-session')
  expect(result.tokens).toEqual(changed ? { input: 150, cacheRead: 400, cacheWrite: 0, output: 65 } : { input: 50, cacheRead: 100, cacheWrite: 0, output: 25 })
})

it('reads Claude structured replies, per-turn usage, and its continuing session while preserving every event', async () => {
  const structured = { reply: 'I retained the fixed timestep.', directives: [] }
  const events = [
    { type: 'system', subtype: 'init', session_id: 'claude-session', tools: ['Read'], model: 'claude-fable-5' },
    { type: 'assistant', message: { id: 'message-1', content: [{ type: 'text', text: 'Checking my decision.' }], usage: { input_tokens: 5, output_tokens: 2 } } },
    { type: 'future.event', value: 'preserved' },
    { type: 'result', subtype: 'success', is_error: false, result: '', structured_output: structured,
      usage: { input_tokens: 12, output_tokens: 8, cache_read_input_tokens: 30, cache_creation_input_tokens: 4 } },
  ].map(event => JSON.stringify(event)).join('\n')
  const { agent } = setup(`process.stdin.resume(); process.stdin.on('end',()=>process.stdout.write(${JSON.stringify(events)}));`)
  const onSession = vi.fn(), seen: string[] = []
  const result = await agent({ attemptId: crypto.randomUUID(), workspaceDir: root, prompt: 'question', model: 'claude-fable-5',
    resumeId: 'claude-session', signal: new AbortController().signal, onSession, onEvent: event => seen.push(event.text) })
  expect(result).toEqual({ text: JSON.stringify(structured), sessionId: 'claude-session', tokens: { input: 12, output: 8, cacheRead: 30, cacheWrite: 4 } })
  expect(onSession).toHaveBeenCalledWith('claude-session')
  expect(seen.some(text => text.includes('future.event'))).toBe(true)
})
