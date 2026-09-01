import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { agentsDir, childrenActive, readChildAgents } from './child-agents'

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'children-'))
fs.mkdirSync(agentsDir(workspace), { recursive: true })

function write(file: string, lines: unknown[]): void {
  fs.writeFileSync(path.join(agentsDir(workspace), file), lines.map((l) => JSON.stringify(l)).join('\n'))
}

afterAll(() => fs.rmSync(workspace, { recursive: true, force: true }))

describe('readChildAgents', () => {
  it('counts a claude worker once per message, not once per streamed update', () => {
    const usage = { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 900, cache_creation_input_tokens: 5 }
    write('renderer.claude.jsonl', [
      { type: 'assistant', message: { id: 'm1', model: 'claude-opus-5', usage } },
      { type: 'assistant', message: { id: 'm1', model: 'claude-opus-5', usage } },
      { type: 'assistant', message: { id: 'm2', model: 'claude-opus-5', usage } },
    ])
    const [agent] = readChildAgents(workspace, null)
    expect(agent.label).toBe('claude: renderer')
    expect(agent.model).toBe('claude-opus-5')
    expect(agent.tokens).toEqual({ input: 200, output: 40, cacheRead: 1_800, cacheWrite: 10 })
  })

  it('counts a codex worker per completed turn, without billing cached input twice', () => {
    write('physics.codex.jsonl', [
      { type: 'turn.completed', usage: { input_tokens: 1_000, cached_input_tokens: 400, output_tokens: 50 } },
      { type: 'turn.completed', usage: { input_tokens: 500, cached_input_tokens: 100, output_tokens: 10 } },
    ])
    const agent = readChildAgents(workspace, 'gpt-5.6-sol').find((a) => a.label === 'codex: physics')!
    expect(agent.tokens).toEqual({ input: 1_000, output: 60, cacheRead: 500, cacheWrite: 0 })
    expect(agent.model).toBe('gpt-5.6-sol')
    expect(agent.costUsd).toBeCloseTo((1_000 * 4 + 60 * 20 + 500 * 0.4) / 1_000_000, 10)
  })

  it('ignores files that are not a worker stream', () => {
    fs.writeFileSync(path.join(agentsDir(workspace), 'notes.md'), 'hello')
    expect(readChildAgents(workspace, null).map((a) => a.label).sort()).toEqual(['claude: renderer', 'codex: physics'])
  })
})

describe('finished workers', () => {
  it('stays lit while the stream is fresh, and reads done once it settles', () => {
    // The codex worker above ended its turn; the claude one never reported a result.
    const fresh = readChildAgents(workspace, null)
    expect(fresh.every((a) => a.done)).toBe(false)
    const later = readChildAgents(workspace, null, undefined, Date.now() + 30_000)
    expect(later.find((a) => a.label === 'codex: physics')!.done).toBe(true)
    // No end-of-run event, so this one waits out the longer silence.
    expect(later.find((a) => a.label === 'claude: renderer')!.done).toBe(false)
    const muchLater = readChildAgents(workspace, null, undefined, Date.now() + 5 * 60_000)
    expect(muchLater.every((a) => a.done)).toBe(true)
  })
})

describe('childrenActive', () => {
  it('is true while a stream is still being written and false once it goes quiet', () => {
    expect(childrenActive(workspace, 60_000)).toBe(true)
    expect(childrenActive(workspace, 60_000, Date.now() + 120_000)).toBe(false)
  })

  it('is false when nothing was ever delegated', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'nochildren-'))
    expect(childrenActive(empty, 60_000)).toBe(false)
    fs.rmSync(empty, { recursive: true, force: true })
  })
})
