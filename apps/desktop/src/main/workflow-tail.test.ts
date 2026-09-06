import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { deriveLabels, WorkflowTail, workflowTailDir } from './workflow-tail'

let root: string | null = null

function makeRun(): { dir: string; runDir: string } {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'gauntlet-tail-'))
  const runDir = path.join(root, 'wf_abc123')
  fs.mkdirSync(runDir, { recursive: true })
  return { dir: root, runDir }
}

function assistant(id: string, out: number, tools = 0): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp: '2026-08-31T18:00:00.000Z',
    message: {
      id,
      model: 'claude-opus-5',
      usage: { input_tokens: 10, output_tokens: out, cache_read_input_tokens: 100, cache_creation_input_tokens: 5 },
      content: Array.from({ length: tools }, () => ({ type: 'tool_use', name: 'Read', input: {} })),
    },
  })
}

afterEach(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true })
  root = null
})

describe('WorkflowTail', () => {
  it('emits each workflow brief, spawn, thought, tool, output, and completion with the workflow agent id', () => {
    const { dir, runDir } = makeRun()
    const agentLine = JSON.stringify({
      type: 'assistant',
      timestamp: '2026-08-31T18:00:00.000Z',
      message: {
        id: 'm-visible',
        model: 'claude-opus-5',
        usage: { input_tokens: 1, output_tokens: 2 },
        content: [
          { type: 'thinking', thinking: 'Inspect the renderer boundary.' },
          { type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: 'src/view.tsx' } },
          { type: 'text', text: 'Renderer slice is ready.' },
        ],
      },
    })
    fs.writeFileSync(
      path.join(runDir, 'agent-a1.jsonl'),
      `${JSON.stringify({ type: 'user', message: { content: 'Own the renderer slice.' } })}\n${agentLine}\n`,
    )
    fs.writeFileSync(path.join(runDir, 'agent-a1.meta.json'), JSON.stringify({ agentType: 'implementer' }))
    fs.writeFileSync(
      path.join(runDir, 'journal.jsonl'),
      `${JSON.stringify({ type: 'started', agentId: 'a1' })}\n${JSON.stringify({ type: 'result', agentId: 'a1', result: 'All done.' })}\n`,
    )

    const tail = new WorkflowTail(dir)
    const result = tail.pollWithEvents()
    expect(result.agents[0]).toMatchObject({ id: 'wf:wf_abc123:a1', done: true, toolCalls: 1 })
    expect(result.events.map(({ agentId, kind }) => [agentId, kind])).toEqual([
      ['wf:wf_abc123:a1', 'spawn'],
      ['wf:wf_abc123:a1', 'spawn'],
      ['wf:wf_abc123:a1', 'agent'],
      ['wf:wf_abc123:a1', 'prompt'],
      ['wf:wf_abc123:a1', 'thought'],
      ['wf:wf_abc123:a1', 'tool'],
      ['wf:wf_abc123:a1', 'claude'],
    ])
  })

  it('reads only what was appended since the last poll', () => {
    const { dir, runDir } = makeRun()
    const file = path.join(runDir, 'agent-a1.jsonl')
    fs.writeFileSync(file, `${JSON.stringify({ type: 'user', message: { content: 'do the thing' } })}\n${assistant('m1', 50, 2)}\n`)
    fs.writeFileSync(path.join(runDir, 'agent-a1.meta.json'), JSON.stringify({ agentType: 'implementer', spawnDepth: 1 }))
    fs.writeFileSync(path.join(runDir, 'journal.jsonl'), `${JSON.stringify({ type: 'started', agentId: 'a1' })}\n`)

    const tail = new WorkflowTail(dir)
    let [agent] = tail.poll()
    expect(agent.prompt).toBe('do the thing')
    expect(agent.agentType).toBe('implementer')
    expect(agent.tokens.output).toBe(50)
    expect(agent.toolCalls).toBe(2)
    expect(agent.state).toBe('progress')

    fs.appendFileSync(file, `${assistant('m2', 25, 1)}\n`)
    fs.appendFileSync(path.join(runDir, 'journal.jsonl'), `${JSON.stringify({ type: 'result', agentId: 'a1', result: 'all done' })}\n`)
    ;[agent] = tail.poll()
    // 50 + 25, not 50 + 50 + 25: the first file segment is not re-read.
    expect(agent.tokens.output).toBe(75)
    expect(agent.toolCalls).toBe(3)
    expect(agent.state).toBe('done')
    expect(agent.note).toBe('all done')
  })

  it('restores newline-safe offsets without replaying history and emits downtime appends', () => {
    const { dir, runDir } = makeRun()
    fs.writeFileSync(path.join(runDir, 'agent-a1.jsonl'), `${assistant('m1', 10)}\n`)
    fs.writeFileSync(path.join(runDir, 'journal.jsonl'), `${JSON.stringify({ type: 'started', agentId: 'a1' })}\n`)
    const first = new WorkflowTail(dir)
    expect(first.pollWithEvents().events.length).toBeGreaterThan(0)
    const recovered = new WorkflowTail(dir, first.snapshot(), dir, first.identitySnapshot())
    expect(recovered.pollWithEvents().events).toEqual([])

    fs.appendFileSync(path.join(runDir, 'journal.jsonl'), `${JSON.stringify({ type: 'result', agentId: 'a1', result: 'finished later' })}\n`)
    const appended = recovered.pollWithEvents()
    expect(appended.events.map((event) => event.text)).toEqual([
      expect.stringContaining('finished'),
      'finished later',
    ])
  })

  it('counts a streamed message once, however many times it is rewritten', () => {
    const { dir, runDir } = makeRun()
    // The runtime rewrites a message as it streams; 429 of 885 lines in a real
    // transcript were repeats of an id already seen.
    fs.writeFileSync(path.join(runDir, 'agent-a1.jsonl'), [assistant('m1', 10), assistant('m1', 40), assistant('m2', 5), ''].join('\n'))
    const [agent] = new WorkflowTail(dir).poll()
    expect(agent.tokens.output).toBe(45)
    expect(agent.messages).toBe(2)
  })

  it('keeps the same agent id distinct across workflow runs', () => {
    const { dir, runDir } = makeRun()
    const secondRun = path.join(dir, 'wf_second')
    fs.mkdirSync(secondRun)
    fs.writeFileSync(path.join(runDir, 'agent-a1.jsonl'), `${assistant('m1', 10)}\n`)
    fs.writeFileSync(path.join(secondRun, 'agent-a1.jsonl'), `${assistant('m2', 20)}\n`)
    const agents = new WorkflowTail(dir).poll()
    expect(agents.map((agent) => agent.id)).toEqual(['wf:wf_abc123:a1', 'wf:wf_second:a1'])
    expect(agents.map((agent) => agent.tokens.output)).toEqual([10, 20])
  })

  it('counts repeated tool blocks once', () => {
    const { dir, runDir } = makeRun()
    fs.writeFileSync(path.join(runDir, 'agent-a1.jsonl'), [assistant('m1', 10, 2), assistant('m1', 40, 2), ''].join('\n'))
    const [agent] = new WorkflowTail(dir).poll()
    expect(agent.toolCalls).toBe(2)
  })

  it('holds back a partial trailing line until it is complete', () => {
    const { dir, runDir } = makeRun()
    const file = path.join(runDir, 'agent-a1.jsonl')
    const line = assistant('m1', 10)
    fs.writeFileSync(file, line.slice(0, 40))
    const tail = new WorkflowTail(dir)
    expect(tail.poll()[0]?.tokens.output ?? 0).toBe(0)
    fs.appendFileSync(file, `${line.slice(40)}\n`)
    expect(tail.poll()[0].tokens.output).toBe(10)
  })

  it('checkpoints a partial record at its last newline across restart', () => {
    const { dir, runDir } = makeRun()
    const file = path.join(runDir, 'agent-a1.jsonl')
    const line = assistant('m1', 10)
    fs.writeFileSync(file, line.slice(0, 40))
    const first = new WorkflowTail(dir)
    first.poll()
    expect(first.snapshot()['wf_abc123/agent-a1.jsonl']).toBe(0)

    fs.appendFileSync(file, `${line.slice(40)}\n`)
    const [agent] = new WorkflowTail(dir, first.snapshot(), dir, first.identitySnapshot()).poll()
    expect(agent.tokens.output).toBe(10)
  })

  it('fails closed on live shrink and replacement across durable recovery', () => {
    const { dir, runDir } = makeRun()
    const file = path.join(runDir, 'agent-a1.jsonl')
    fs.writeFileSync(file, `${assistant('m1', 10)}\n`)
    const first = new WorkflowTail(dir)
    first.poll()
    const offsets = first.snapshot()
    const identities = first.identitySnapshot()

    fs.truncateSync(file, 0)
    expect(() => first.poll()).toThrow(/shrank.*refusing incomplete or replacement evidence/)

    fs.renameSync(file, `${file}.old`)
    fs.writeFileSync(file, `${assistant('m2', 999)}\n${assistant('m3', 999)}\n`)
    expect(() => new WorkflowTail(dir, offsets, dir, identities).poll()).toThrow(/changed identity/)
    expect(() => new WorkflowTail(dir, offsets)).toThrow(/without its original file identity/)
  })

  it('prices each agent from its own token split', () => {
    const { dir, runDir } = makeRun()
    fs.writeFileSync(path.join(runDir, 'agent-a1.jsonl'), `${assistant('m1', 1_000_000)}\n`)
    const [agent] = new WorkflowTail(dir).poll()
    // opus output is $25/MTok, so a million output tokens dominates the total.
    expect(agent.costUsd).toBeGreaterThan(24)
    expect(agent.costUsd).toBeLessThan(26)
  })

  it('returns nothing when no workflow has run', () => {
    expect(new WorkflowTail('/no/such/dir').poll()).toEqual([])
  })

  it('surfaces malformed journal and transcript values without crashing the tailer', () => {
    const { dir, runDir } = makeRun()
    fs.writeFileSync(path.join(runDir, 'journal.jsonl'), 'null\n{}\n')
    fs.writeFileSync(path.join(runDir, 'agent-a1.jsonl'), 'null\n')
    const events = new WorkflowTail(dir).pollWithEvents().events
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ agentId: 'workflow:wf_abc123', kind: 'system', text: expect.stringContaining('malformed workflow journal') }),
      expect.objectContaining({ agentId: 'workflow:wf_abc123', kind: 'system', text: expect.stringContaining('without an agent id') }),
      expect.objectContaining({ agentId: 'wf:wf_abc123:a1', kind: 'system', text: expect.stringContaining('malformed event') }),
    ]))
  })

  it('rejects a journal agent id that could escape its workflow directory', () => {
    const { dir, runDir } = makeRun()
    fs.writeFileSync(path.join(runDir, 'journal.jsonl'), `${JSON.stringify({ type: 'started', agentId: '../escape' })}\n`)
    const result = new WorkflowTail(dir).pollWithEvents()
    expect(result.agents).toEqual([])
    expect(result.events).toEqual([
      expect.objectContaining({ agentId: 'workflow:wf_abc123', kind: 'system', text: expect.stringContaining('without an agent id') }),
    ])
  })

  it('bounds unterminated transcript projections and refuses symlinked agent files', () => {
    const { dir, runDir } = makeRun()
    const huge = path.join(runDir, 'agent-a1.jsonl')
    fs.writeFileSync(huge, Buffer.alloc(1024 * 1024 + 1, 0x61))
    const tail = new WorkflowTail(dir)
    expect(tail.pollWithEvents().events).toEqual([])
    expect(tail.pollWithEvents().events).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'error', text: expect.stringContaining('projection limit') }),
    ]))

    fs.rmSync(huge)
    const outside = path.join(path.dirname(runDir), 'outside.jsonl')
    fs.writeFileSync(outside, '{}\n')
    fs.symlinkSync(outside, path.join(runDir, 'agent-linked.jsonl'))
    expect(new WorkflowTail(dir).pollWithEvents().events).toEqual(expect.arrayContaining([
      expect.objectContaining({ agentId: 'workflow:wf_abc123', kind: 'error', text: expect.stringContaining('not a regular transcript') }),
    ]))
  })

  it('refuses hard-linked and inspection-raced workflow transcripts', () => {
    const { dir, runDir } = makeRun()
    const outside = path.join(dir, 'outside.jsonl')
    fs.writeFileSync(outside, `${assistant('secret', 999)}\n`)
    fs.linkSync(outside, path.join(runDir, 'agent-linked.jsonl'))
    expect(new WorkflowTail(dir).pollWithEvents().events).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'error', text: expect.stringContaining('singly linked') }),
    ]))

    const raced = path.join(runDir, 'agent-raced.jsonl')
    fs.writeFileSync(raced, `${assistant('before', 1)}\n`)
    const originalOpen = fs.openSync.bind(fs)
    let replaced = false
    const spy = vi.spyOn(fs, 'openSync').mockImplementation(((file: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
      if (!replaced && path.basename(String(file)) === path.basename(raced)) {
        replaced = true
        fs.renameSync(raced, `${raced}.old`)
        fs.writeFileSync(raced, `${assistant('after', 999)}\n`)
      }
      return originalOpen(file, flags, mode)
    }) as typeof fs.openSync)
    try {
      expect(() => new WorkflowTail(dir).pollWithEvents()).toThrow(/changed identity/)
    } finally {
      spy.mockRestore()
    }
  })

  it('applies one aggregate byte budget across all workflow transcripts', () => {
    const { dir, runDir } = makeRun()
    for (const id of ['a1', 'a2', 'a3']) {
      fs.writeFileSync(path.join(runDir, `agent-${id}.jsonl`), Buffer.alloc(1024 * 1024 + 1, 0x61))
    }
    const events = new WorkflowTail(dir).pollWithEvents().events
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'error', text: expect.stringContaining('aggregate 2048-entry/2097152-byte poll limit') }),
    ]))
  })

  it('caps retained agents below the persisted run-metrics ceiling', () => {
    const { dir } = makeRun()
    for (let run = 0; run < 3; run += 1) {
      const runDir = path.join(dir, `wf_many_${run}`)
      fs.mkdirSync(runDir)
      for (let agent = 0; agent < 171; agent += 1) {
        fs.writeFileSync(path.join(runDir, `agent-a${run}_${agent}.jsonl`), '{}\n')
      }
    }

    const tail = new WorkflowTail(dir)
    const result = tail.pollWithEvents()
    expect(result.agents).toHaveLength(511)
    expect(result.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'error', text: expect.stringContaining('511-agent persistence limit') }),
    ]))
    expect(Object.keys(tail.snapshot()).length).toBeLessThanOrEqual(1_000)
  })

  it('bounds long-lived prompt and note projections at assignment time', () => {
    const { dir, runDir } = makeRun()
    const long = 'x'.repeat(10_000)
    fs.writeFileSync(
      path.join(runDir, 'agent-a1.jsonl'),
      `${JSON.stringify({ type: 'user', message: { content: long } })}\n${JSON.stringify({ type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: long }] } })}\n`,
    )
    fs.writeFileSync(path.join(runDir, 'journal.jsonl'), `${JSON.stringify({ type: 'result', agentId: 'a1', result: long })}\n`)

    const result = new WorkflowTail(dir).pollWithEvents()
    expect(result.agents[0].prompt).toHaveLength(4_000)
    expect(result.agents[0].note!.length).toBeLessThanOrEqual(301)
    expect(result.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'error', text: expect.stringContaining('prompt exceeded 4000 characters') }),
    ]))
  })
})

describe('deriveLabels', () => {
  it('names each agent by the first line that differs from the shared preamble', () => {
    expect(
      deriveLabels([
        'PREAMBLE\nshared\nYOUR WORKSTREAM — W1: WORLD RENDERING. You own these files:\ntail',
        'PREAMBLE\nshared\nYOUR WORKSTREAM — W6: AUDIO. You own these files:\ntail',
      ]),
    ).toEqual(['YOUR WORKSTREAM — W1: WORLD RENDERING', 'YOUR WORKSTREAM — W6: AUDIO'])
  })

  it('falls back to the first line when the prompts share nothing', () => {
    expect(deriveLabels(['build the maze. and more', 'wire the audio. and more'])).toEqual(['build the maze', 'wire the audio'])
  })

  it('handles an agent whose prompt has not been read yet', () => {
    expect(deriveLabels([null])).toEqual([null])
  })
})

describe('workflowTailDir', () => {
  it('points at the live transcripts, not the end-of-run summary', () => {
    expect(workflowTailDir('/home/.claude', '/Users/john/Projects/Claude-Man', 'sess-1')).toBe(
      '/home/.claude/projects/-Users-john-Projects-Claude-Man/sess-1/subagents/workflows',
    )
  })

  it('rejects traversal ids and symbolic links inside the private-home path', () => {
    expect(() => workflowTailDir('/home/.claude', '/workspace', '../escape')).toThrow(/session id/)
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'gauntlet-tail-path-'))
    const home = path.join(root, 'claude-home')
    const project = path.join(home, 'projects', '-workspace')
    const outside = path.join(root, 'outside')
    fs.mkdirSync(project, { recursive: true })
    fs.mkdirSync(outside)
    fs.symlinkSync(outside, path.join(project, 'sess-1'))
    expect(() => workflowTailDir(home, '/workspace', 'sess-1')).toThrow(/symbolic link/)
  })

  it('follows the shared projects link the app makes for an extra account', () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'gauntlet-tail-account-'))
    // The real layout: accounts.ts shares `projects` across accounts so a run
    // can switch accounts between rounds and continue the same session.
    const claudeTree = path.join(root, 'harnesses', 'claude')
    const accountHome = path.join(claudeTree, 'accounts', 'account-2')
    fs.mkdirSync(path.join(claudeTree, 'projects', '-workspace', 'sess-1', 'subagents', 'workflows'), { recursive: true })
    fs.mkdirSync(accountHome, { recursive: true })
    fs.symlinkSync('../../projects', path.join(accountHome, 'projects'))

    expect(workflowTailDir(accountHome, '/workspace', 'sess-1')).toBe(
      fs.realpathSync(path.join(claudeTree, 'projects', '-workspace', 'sess-1', 'subagents', 'workflows')),
    )

    // A link out of the harness tree is still refused.
    const escape = path.join(root, 'outside')
    fs.mkdirSync(escape)
    fs.rmSync(path.join(claudeTree, 'projects', '-workspace', 'sess-1'), { recursive: true })
    fs.symlinkSync(escape, path.join(claudeTree, 'projects', '-workspace', 'sess-1'))
    expect(() => workflowTailDir(accountHome, '/workspace', 'sess-1')).toThrow(/symbolic link/)
  })
})
