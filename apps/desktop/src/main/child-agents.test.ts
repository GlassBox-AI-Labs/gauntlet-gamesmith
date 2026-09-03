import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { agentsDir, CHILD_STARTUP_GRACE_MS, childStreamFailures, childrenActive, observeChildStreams, readChildAgents, safeAgentsDir } from './child-agents'
import { CHILD_PROCESS_EXIT_EVENT } from './child-process-exit'
import { captureWorkspaceIdentity } from './workspace-boundary'

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'children-'))
fs.mkdirSync(agentsDir(workspace), { recursive: true })
const boundary = observeChildStreams(workspace)

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
    const [agent] = readChildAgents(boundary, null)
    expect(agent.label).toBe('claude: renderer')
    expect(agent.model).toBe('claude-opus-5')
    expect(agent.tokens).toEqual({ input: 200, output: 40, cacheRead: 1_800, cacheWrite: 10 })
  })

  it('counts a codex worker per completed turn, without billing cached input twice', () => {
    write('physics.codex.jsonl', [
      { type: 'turn.completed', usage: { input_tokens: 1_000, cached_input_tokens: 400, output_tokens: 50 } },
      { type: 'turn.completed', usage: { input_tokens: 500, cached_input_tokens: 100, output_tokens: 10 } },
    ])
    const agent = readChildAgents(boundary, 'gpt-5.6-sol').find((a) => a.label === 'codex: physics')!
    expect(agent.tokens).toEqual({ input: 1_000, output: 60, cacheRead: 500, cacheWrite: 0 })
    expect(agent.model).toBe('gpt-5.6-sol')
    expect(agent.costUsd).toBeCloseTo((1_000 * 4 + 60 * 20 + 500 * 0.4) / 1_000_000, 10)
  })

  it('excludes hostile numeric values from delegated-worker accounting', () => {
    write('hostile.claude.jsonl', [
      {
        type: 'assistant',
        message: {
          id: 'hostile-message',
          model: 'claude-opus-5',
          usage: {
            input_tokens: -1,
            output_tokens: 1.5,
            cache_read_input_tokens: Number.MAX_SAFE_INTEGER + 1,
            cache_creation_input_tokens: 7,
          },
        },
      },
    ])
    write('hostile-codex.codex.jsonl', [
      {
        type: 'turn.completed',
        usage: { input_tokens: '1000', output_tokens: 9, cached_input_tokens: -10 },
      },
    ])

    const agents = readChildAgents(boundary, 'gpt-5.6-sol')
    expect(agents.find((agent) => agent.label === 'claude: hostile')?.tokens).toEqual({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 7,
    })
    expect(agents.find((agent) => agent.label === 'codex: hostile-codex')?.tokens).toEqual({
      input: 0,
      output: 9,
      cacheRead: 0,
      cacheWrite: 0,
    })
  })

  it('ignores files that are not a worker stream', () => {
    fs.writeFileSync(path.join(agentsDir(workspace), '../escape.claude.jsonl'), '{}')
    const outside = path.join(workspace, 'outside.jsonl')
    fs.writeFileSync(outside, JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 999 } }))

    for (const invalid of ['notes.md', 'UPPER.codex.jsonl', 'has space.claude.jsonl', 'nested.slug.codex.jsonl']) {
      fs.writeFileSync(path.join(agentsDir(workspace), invalid), '{}')
      expect(() => readChildAgents(boundary, null)).toThrow(/Unexpected entry/)
      fs.unlinkSync(path.join(agentsDir(workspace), invalid))
    }
    fs.symlinkSync(outside, path.join(agentsDir(workspace), 'symlink.codex.jsonl'))
    expect(() => readChildAgents(boundary, null)).toThrow(/singly linked regular file/)
    fs.unlinkSync(path.join(agentsDir(workspace), 'symlink.codex.jsonl'))
    fs.linkSync(outside, path.join(agentsDir(workspace), 'hardlink.codex.jsonl'))
    expect(() => readChildAgents(boundary, null)).toThrow(/singly linked regular file/)
    fs.unlinkSync(path.join(agentsDir(workspace), 'hardlink.codex.jsonl'))
    const oversized = path.join(agentsDir(workspace), 'oversized.codex.jsonl')
    fs.writeFileSync(oversized, '{}')
    fs.truncateSync(oversized, 64 * 1024 * 1024 + 1)
    expect(() => readChildAgents(boundary, null)).toThrow(/oversized.*accounting limit/)
    fs.unlinkSync(oversized)
    expect(readChildAgents(boundary, null).map((a) => a.label).sort()).toEqual([
      'claude: hostile', 'claude: renderer', 'codex: hostile-codex', 'codex: physics',
    ])
  })

  it('fails closed instead of ignoring a worker beyond the accounting limit', () => {
    const cappedWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'children-capped-'))
    fs.mkdirSync(agentsDir(cappedWorkspace), { recursive: true })
    try {
      const cappedBoundary = observeChildStreams(cappedWorkspace)
      for (let index = 0; index < 257; index += 1) {
        fs.writeFileSync(path.join(agentsDir(cappedWorkspace), `worker-${String(index).padStart(3, '0')}.codex.jsonl`), '')
      }
      expect(() => readChildAgents(cappedBoundary, 'gpt-5.6-sol')).toThrow(/incomplete accounting/)
      expect(() => childrenActive(cappedBoundary, 60_000)).toThrow(/inventory exceeded|incomplete accounting/)
    } finally {
      fs.rmSync(cappedWorkspace, { recursive: true, force: true })
    }
  })

  it('fails closed on a stream too large for complete accounting', () => {
    const cappedWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'children-byte-cap-'))
    fs.mkdirSync(agentsDir(cappedWorkspace), { recursive: true })
    try {
      const cappedBoundary = observeChildStreams(cappedWorkspace)
      const stream = path.join(agentsDir(cappedWorkspace), 'large.codex.jsonl')
      fs.writeFileSync(stream, '')
      fs.truncateSync(stream, 8 * 1024 * 1024 + 1)

      expect(() => readChildAgents(cappedBoundary, 'gpt-5.6-sol')).toThrow(/accounting limit/)
    } finally {
      fs.rmSync(cappedWorkspace, { recursive: true, force: true })
    }
  })

  it('enforces one aggregate accounting-read budget across the capped stream set', () => {
    const cappedWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'children-aggregate-cap-'))
    fs.mkdirSync(agentsDir(cappedWorkspace), { recursive: true })
    try {
      const cappedBoundary = observeChildStreams(cappedWorkspace)
      for (let index = 0; index < 5; index += 1) {
        const stream = path.join(agentsDir(cappedWorkspace), `worker-${index}.codex.jsonl`)
        fs.writeFileSync(stream, '')
        fs.truncateSync(stream, 8 * 1024 * 1024)
      }

      expect(() => readChildAgents(cappedBoundary, 'gpt-5.6-sol')).toThrow(/aggregate accounting limit/)
    } finally {
      fs.rmSync(cappedWorkspace, { recursive: true, force: true })
    }
  })

  it('uses the validated file snapshot size instead of reading a growing stream to EOF', () => {
    const wholeFileRead = vi.spyOn(fs, 'readFileSync')
    try {
      readChildAgents(boundary, null)
      expect(wholeFileRead).not.toHaveBeenCalled()
    } finally {
      wholeFileRead.mockRestore()
    }
  })

  it('ignores primitive and array JSONL records without crashing or hiding a real terminal event', () => {
    const malformedWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'children-primitives-'))
    fs.mkdirSync(agentsDir(malformedWorkspace), { recursive: true })
    try {
      const malformedBoundary = observeChildStreams(malformedWorkspace)
      fs.writeFileSync(path.join(agentsDir(malformedWorkspace), 'claude-worker.claude.jsonl'), [
        'null', '42', '"type"', '[{"type":"result"}]', JSON.stringify({ type: 'result' }), '',
      ].join('\n'))
      fs.writeFileSync(path.join(agentsDir(malformedWorkspace), 'codex-worker.codex.jsonl'), [
        'null', '42', '"turn.completed"', '[{"type":"turn.completed"}]', JSON.stringify({ type: 'turn.completed', usage: {} }), '',
      ].join('\n'))

      expect(() => readChildAgents(malformedBoundary, null, undefined, Date.now() + 60_000)).not.toThrow()
      expect(childrenActive(malformedBoundary, 15_000, Date.now() + 60_000)).toBe(false)
    } finally {
      fs.rmSync(malformedWorkspace, { recursive: true, force: true })
    }
  })
})

describe('finished workers', () => {
  it('stays lit while the stream is fresh, and reads done once it settles', () => {
    // The codex worker above ended its turn; the claude one never reported a result.
    const fresh = readChildAgents(boundary, null)
    expect(fresh.every((a) => a.done)).toBe(false)
    const later = readChildAgents(boundary, null, undefined, Date.now() + 30_000)
    expect(later.find((a) => a.label === 'codex: physics')!.done).toBe(true)
    // No end-of-run event, so this one waits out the longer silence.
    expect(later.find((a) => a.label === 'claude: renderer')!.done).toBe(false)
    const muchLater = readChildAgents(boundary, null, undefined, Date.now() + 5 * 60_000)
    expect(muchLater.find((a) => a.label === 'claude: renderer')!.done).toBe(false)
  })
})

describe('childrenActive', () => {
  it('keeps a quiet stream active until an exact terminal event is present', () => {
    expect(childrenActive(boundary, 60_000)).toBe(true)
    expect(childrenActive(boundary, 60_000, Date.now() + 12 * 60 * 60_000)).toBe(true)
    const terminalWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'terminal-children-'))
    fs.mkdirSync(agentsDir(terminalWorkspace), { recursive: true })
    const terminalBoundary = observeChildStreams(terminalWorkspace)
    fs.writeFileSync(path.join(agentsDir(terminalWorkspace), 'done.claude.jsonl'), JSON.stringify({ type: 'result' }))
    try {
      expect(childrenActive(terminalBoundary, 60_000, Date.now() + 120_000)).toBe(false)
    } finally {
      fs.rmSync(terminalWorkspace, { recursive: true, force: true })
    }
  })

  it('is false when nothing was ever delegated', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'nochildren-'))
    const emptyBoundary = observeChildStreams(empty)
    expect(childrenActive(emptyBoundary, 60_000)).toBe(false)
    fs.rmSync(empty, { recursive: true, force: true })
  })

  it('releases and exposes an older empty stream as a failed launch', () => {
    const failedWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'empty-failed-child-'))
    const failedBoundary = observeChildStreams(failedWorkspace)
    const stream = path.join(agentsDir(failedWorkspace), 'research.codex.jsonl')
    fs.writeFileSync(stream, '')
    const mtime = fs.statSync(stream).mtimeMs
    try {
      expect(childrenActive(failedBoundary, CHILD_STARTUP_GRACE_MS, mtime + 1_000)).toBe(true)
      const settledAt = mtime + CHILD_STARTUP_GRACE_MS + 1
      expect(childrenActive(failedBoundary, CHILD_STARTUP_GRACE_MS, settledAt)).toBe(false)
      expect(childStreamFailures(failedBoundary, CHILD_STARTUP_GRACE_MS, settledAt)).toEqual([{
        agentId: 'research',
        harness: 'codex',
        reason: 'produced no protocol output; the worker launch did not become observable',
      }])
      expect(readChildAgents(failedBoundary, 'gpt-5.6-luna', undefined, settledAt)[0]).toMatchObject({
        done: true,
        state: 'failed',
        note: 'produced no protocol output; the worker launch did not become observable',
      })
    } finally {
      fs.rmSync(failedWorkspace, { recursive: true, force: true })
    }
  })

  it('uses the wrapper exit marker instead of waiting forever for a terminal event', () => {
    const failedWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'marked-failed-child-'))
    const failedBoundary = observeChildStreams(failedWorkspace)
    const stream = path.join(agentsDir(failedWorkspace), 'research.codex.jsonl')
    fs.writeFileSync(stream, [
      JSON.stringify({ type: 'thread.started', thread_id: 'thread-1' }),
      JSON.stringify({ type: CHILD_PROCESS_EXIT_EVENT, exit_code: 1 }),
      '',
    ].join('\n'))
    const settledAt = fs.statSync(stream).mtimeMs + CHILD_STARTUP_GRACE_MS + 1
    try {
      expect(childrenActive(failedBoundary, CHILD_STARTUP_GRACE_MS, settledAt)).toBe(false)
      expect(childStreamFailures(failedBoundary, CHILD_STARTUP_GRACE_MS, settledAt)[0]?.reason).toBe(
        'exited with status 1 before emitting a terminal protocol event',
      )
      expect(readChildAgents(failedBoundary, 'gpt-5.6-luna', undefined, settledAt)[0]?.state).toBe('failed')
    } finally {
      fs.rmSync(failedWorkspace, { recursive: true, force: true })
    }
  })

  it('does not follow a planted agent-directory symlink', () => {
    const symlinkWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'children-symlink-'))
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'children-outside-'))
    fs.mkdirSync(path.join(symlinkWorkspace, '.gauntlet-gamesmith'))
    fs.writeFileSync(path.join(outside, 'stolen.codex.jsonl'), '{}')
    fs.symlinkSync(outside, agentsDir(symlinkWorkspace))
    try {
      expect(() => observeChildStreams(symlinkWorkspace)).toThrow(/real directory/)
      expect(() => safeAgentsDir(symlinkWorkspace, true)).toThrow(/real directory/)
    } finally {
      fs.rmSync(symlinkWorkspace, { recursive: true, force: true })
      fs.rmSync(outside, { recursive: true, force: true })
    }
  })

  it('fails terminally when the observed agents directory disappears or is replaced', () => {
    const changedWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'children-replaced-'))
    const observed = observeChildStreams(changedWorkspace)
    const original = `${agentsDir(changedWorkspace)}-original`
    fs.renameSync(agentsDir(changedWorkspace), original)
    fs.mkdirSync(agentsDir(changedWorkspace))
    try {
      expect(() => childrenActive(observed, 60_000)).toThrow(/changed identity/)
      expect(() => readChildAgents(observed, null)).toThrow(/changed identity/)
    } finally {
      fs.rmSync(changedWorkspace, { recursive: true, force: true })
    }
  })

  it('refuses to claim child streams through a replaced workspace root', () => {
    const changedWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'children-root-replaced-'))
    const displaced = `${changedWorkspace}-displaced`
    const expected = captureWorkspaceIdentity(changedWorkspace, [])
    fs.renameSync(changedWorkspace, displaced)
    fs.mkdirSync(changedWorkspace)
    try {
      expect(() => observeChildStreams(changedWorkspace, expected)).toThrow(/changed identity/)
    } finally {
      fs.rmSync(changedWorkspace, { recursive: true, force: true })
      fs.rmSync(displaced, { recursive: true, force: true })
    }
  })
})
