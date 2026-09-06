import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CHILD_PROCESS_EXIT_EVENT } from '../child-process-exit'
import { ChildStreamTailer } from './child-tailer'

let dir: string | null = null

function makeDir(): string {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gauntlet-childtail-'))
  const agents = path.join(dir, 'agents')
  fs.mkdirSync(agents)
  return agents
}

afterEach(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true })
  dir = null
})

const claudeLine = JSON.stringify({
  type: 'assistant',
  message: {
    id: 'msg_01',
    model: 'claude-opus-5',
    content: [{ type: 'thinking', thinking: 'Start with the tile map.' }, { type: 'text', text: 'Renderer slice under way.' }],
    usage: { input_tokens: 10, output_tokens: 20 },
  },
})

const codexLine = JSON.stringify({
  type: 'item.completed',
  item: { id: 'item_1', type: 'command_execution', command: "bash -lc 'npm run build'", status: 'completed' },
})

function writeBrief(agents: string, harness: 'claude' | 'codex', slug: string, text = `Build the ${slug} slice.`): void {
  fs.writeFileSync(path.join(path.dirname(agents), `${harness}-${slug}.md`), text)
}

describe('ChildStreamTailer', () => {
  it('attributes each stream to its slug and picks the translator from the file name', () => {
    const agents = makeDir()
    writeBrief(agents, 'claude', 'renderer')
    writeBrief(agents, 'codex', 'physics')
    fs.writeFileSync(path.join(agents, 'renderer.claude.jsonl'), `${claudeLine}\n`)
    fs.writeFileSync(path.join(agents, 'physics.codex.jsonl'), `${codexLine}\n`)
    fs.writeFileSync(path.join(agents, 'notes.md'), 'not a stream')
    const tailer = new ChildStreamTailer(agents, 0)
    expect(tailer.poll()).toEqual([
      { agentId: 'physics', channel: 'prompt', kind: 'prompt', text: 'Delegated codex brief:\nBuild the physics slice.' },
      { agentId: 'physics', channel: 'tool', kind: 'spawn', text: '⇉ delegated codex worker "physics" stream appeared' },
      { agentId: 'physics', channel: 'tool', kind: 'cmd', text: "$ bash -lc 'npm run build'" },
      { agentId: 'renderer', channel: 'prompt', kind: 'prompt', text: 'Delegated claude brief:\nBuild the renderer slice.' },
      { agentId: 'renderer', channel: 'tool', kind: 'spawn', text: '⇉ delegated claude worker "renderer" stream appeared' },
      { agentId: 'renderer', channel: 'thought', kind: 'thought', text: '𝜓 Start with the tile map.' },
      { agentId: 'renderer', channel: 'output', kind: 'claude', text: 'Renderer slice under way.' },
    ])
  })

  it('emits only appended lines on later polls, and streams that appear mid-build', () => {
    const agents = makeDir()
    writeBrief(agents, 'claude', 'renderer')
    fs.writeFileSync(path.join(agents, 'renderer.claude.jsonl'), `${claudeLine}\n`)
    const tailer = new ChildStreamTailer(agents, 0)
    expect(tailer.poll()).toHaveLength(4)
    expect(tailer.poll()).toEqual([])

    fs.appendFileSync(path.join(agents, 'renderer.claude.jsonl'), `${claudeLine}\n`)
    writeBrief(agents, 'codex', 'audio')
    fs.writeFileSync(path.join(agents, 'audio.codex.jsonl'), `${codexLine}\n`)
    const next = tailer.poll()
    expect(next.filter((e) => e.agentId === 'renderer')).toHaveLength(2)
    expect(next.filter((e) => e.agentId === 'audio')).toHaveLength(3)
  })

  it('holds a partial trailing line until its newline arrives', () => {
    const agents = makeDir()
    writeBrief(agents, 'claude', 'ui')
    const file = path.join(agents, 'ui.claude.jsonl')
    fs.writeFileSync(file, claudeLine.slice(0, 40))
    const tailer = new ChildStreamTailer(agents, 0)
    expect(tailer.poll().map((event) => event.kind)).toEqual(['prompt', 'spawn'])
    fs.appendFileSync(file, `${claudeLine.slice(40)}\n`)
    expect(tailer.poll()).toHaveLength(2)
  })

  it('skips streams left over from before the build started', () => {
    const agents = makeDir()
    fs.writeFileSync(path.join(agents, 'stale.claude.jsonl'), `${claudeLine}\n`)
    const tailer = new ChildStreamTailer(agents, Date.now() + 60_000)
    expect(tailer.poll()).toEqual([])
  })

  it('resumes from persisted offsets without replaying', () => {
    const agents = makeDir()
    writeBrief(agents, 'claude', 'renderer')
    const file = path.join(agents, 'renderer.claude.jsonl')
    fs.writeFileSync(file, `${claudeLine}\n`)
    const first = new ChildStreamTailer(agents, 0)
    first.poll()
    const resumed = new ChildStreamTailer(agents, 0, first.snapshot(), first.identitySnapshot())
    expect(resumed.poll()).toEqual([])
    fs.appendFileSync(file, `${claudeLine}\n`)
    expect(resumed.poll()).toHaveLength(2)
  })

  it('fails closed when an admitted stream is replaced between polls', () => {
    const agents = makeDir()
    writeBrief(agents, 'claude', 'renderer')
    const file = path.join(agents, 'renderer.claude.jsonl')
    fs.writeFileSync(file, `${claudeLine}\n`)
    const tailer = new ChildStreamTailer(agents, 0)
    tailer.poll()

    const replacement = path.join(agents, 'replacement')
    fs.writeFileSync(replacement, `${claudeLine}\n`)
    fs.renameSync(replacement, file)

    expect(() => tailer.poll()).toThrow(/changed identity.*refusing replacement evidence/)
  })

  it('fails closed when an admitted stream shrinks without changing inode', () => {
    const agents = makeDir()
    writeBrief(agents, 'codex', 'physics')
    const file = path.join(agents, 'physics.codex.jsonl')
    fs.writeFileSync(file, `${codexLine}\n`)
    const tailer = new ChildStreamTailer(agents, 0)
    tailer.poll()

    fs.truncateSync(file, 0)

    expect(() => tailer.poll()).toThrow(/stream .* shrank.*refusing incomplete or replacement evidence/)
  })

  it('fails closed when a stream is replaced between a durable snapshot and recovery', () => {
    const agents = makeDir()
    writeBrief(agents, 'claude', 'renderer')
    const file = path.join(agents, 'renderer.claude.jsonl')
    fs.writeFileSync(file, `${claudeLine}\n`)
    const first = new ChildStreamTailer(agents, 0)
    first.poll()
    const offsets = first.snapshot()
    const identities = first.identitySnapshot()
    fs.renameSync(file, `${file}.old`)
    fs.writeFileSync(file, `${claudeLine}\n${claudeLine}\n`)

    expect(() => new ChildStreamTailer(agents, 0, offsets, identities).poll()).toThrow(/changed identity/)
    expect(() => new ChildStreamTailer(agents, 0, offsets)).toThrow(/without its original file identity/)
  })

  it('recovers a record split across restart without losing or replaying it', () => {
    const agents = makeDir()
    writeBrief(agents, 'claude', 'renderer')
    const file = path.join(agents, 'renderer.claude.jsonl')
    const splitAt = Math.floor(claudeLine.length / 2)
    fs.writeFileSync(file, claudeLine.slice(0, splitAt))
    const first = new ChildStreamTailer(agents, 0)
    expect(first.poll().map((event) => event.kind)).toEqual(['prompt', 'spawn'])
    const offsets = first.snapshot()
    expect(offsets['renderer.claude.jsonl']).toBe(0)

    fs.appendFileSync(file, `${claudeLine.slice(splitAt)}\n`)
    const resumed = new ChildStreamTailer(agents, 0, offsets, first.identitySnapshot())
    expect(resumed.poll()).toEqual([
      expect.objectContaining({ agentId: 'renderer', kind: 'thought', text: expect.stringContaining('tile map') }),
      expect.objectContaining({ agentId: 'renderer', kind: 'claude', text: 'Renderer slice under way.' }),
    ])
    expect(resumed.poll()).toEqual([])
  })

  it('rejects invalid slugs and refuses symlinked streams', () => {
    const agents = makeDir()
    fs.writeFileSync(path.join(agents, '../outside.jsonl'), `${claudeLine}\n`)
    fs.writeFileSync(path.join(agents, 'UPPER.claude.jsonl'), `${claudeLine}\n`)
    fs.symlinkSync(path.join(agents, '../outside.jsonl'), path.join(agents, 'unsafe.claude.jsonl'))
    const events = new ChildStreamTailer(agents, 0).poll()
    expect(events).toEqual([
      expect.objectContaining({ agentId: 'unsafe', kind: 'error', text: expect.stringContaining('regular file') }),
    ])
  })

  it('refuses hard-linked streams and briefs', () => {
    const agents = makeDir()
    const streamSource = path.join(agents, 'stream-source')
    fs.writeFileSync(streamSource, `${claudeLine}\n`)
    fs.linkSync(streamSource, path.join(agents, 'linked.claude.jsonl'))
    const briefSource = path.join(agents, 'brief-source')
    fs.writeFileSync(briefSource, 'Do not project this hard-linked brief.')
    fs.linkSync(briefSource, path.join(path.dirname(agents), 'claude-safe.md'))
    fs.writeFileSync(path.join(agents, 'safe.claude.jsonl'), `${claudeLine}\n`)

    const events = new ChildStreamTailer(agents, 0).poll()
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ agentId: 'linked', kind: 'error', text: expect.stringContaining('singly linked regular file') }),
      expect.objectContaining({ agentId: 'safe', kind: 'error', text: expect.stringContaining('brief is not a singly linked regular file') }),
    ]))
    expect(events.some((event) => event.agentId === 'linked' && event.kind === 'claude')).toBe(false)
  })

  it('reads only the prevalidated brief snapshot instead of following growth to EOF', () => {
    const agents = makeDir()
    writeBrief(agents, 'claude', 'bounded')
    fs.writeFileSync(path.join(agents, 'bounded.claude.jsonl'), `${claudeLine}\n`)
    const wholeFileRead = vi.spyOn(fs, 'readFileSync')
    try {
      const events = new ChildStreamTailer(agents, 0).poll()
      expect(events).toContainEqual(expect.objectContaining({
        agentId: 'bounded',
        kind: 'prompt',
        text: expect.stringContaining('Delegated claude brief'),
      }))
      expect(wholeFileRead).not.toHaveBeenCalled()
    } finally {
      wholeFileRead.mockRestore()
    }
  })

  it('surfaces malformed child records without throwing', () => {
    const agents = makeDir()
    writeBrief(agents, 'claude', 'renderer')
    fs.writeFileSync(path.join(agents, 'renderer.claude.jsonl'), 'null\nnot-json\n')
    const events = new ChildStreamTailer(agents, 0).poll()
    expect(events.filter((event) => event.kind === 'system')).toHaveLength(2)
  })

  it('surfaces child session and successful completion events handled by role parsers', () => {
    const agents = makeDir()
    writeBrief(agents, 'claude', 'research')
    fs.writeFileSync(path.join(agents, 'research.claude.jsonl'), [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'session-claude', model: 'claude-opus-5' }),
      JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'done' }),
      '',
    ].join('\n'))
    writeBrief(agents, 'codex', 'gameplay')
    fs.writeFileSync(path.join(agents, 'gameplay.codex.jsonl'), [
      JSON.stringify({ type: 'thread.started', thread_id: 'thread-codex' }),
      JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 2 } }),
      '',
    ].join('\n'))

    const events = new ChildStreamTailer(agents, 0).poll()
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ agentId: 'research', kind: 'system', text: expect.stringContaining('claude session') }),
      expect.objectContaining({ agentId: 'research', kind: 'done', text: expect.stringContaining('claude result success') }),
      expect.objectContaining({ agentId: 'gameplay', kind: 'system', text: expect.stringContaining('codex thread') }),
      expect.objectContaining({ agentId: 'gameplay', kind: 'done', text: expect.stringContaining('codex turn completed') }),
    ]))
  })

  it('attributes the app-owned delegated process exit marker', () => {
    const agents = makeDir()
    writeBrief(agents, 'codex', 'research')
    fs.writeFileSync(path.join(agents, 'research.codex.jsonl'), `${JSON.stringify({
      type: CHILD_PROCESS_EXIT_EVENT,
      exit_code: 1,
    })}\n`)

    expect(new ChildStreamTailer(agents, 0).poll()).toContainEqual({
      agentId: 'research',
      channel: 'error',
      kind: 'error',
      text: 'delegated codex process exited with status 1',
    })
  })

  it('bounds an unterminated projection line while preserving the raw stream', () => {
    const agents = makeDir()
    writeBrief(agents, 'claude', 'oversized')
    const file = path.join(agents, 'oversized.claude.jsonl')
    fs.writeFileSync(file, 'x'.repeat(2 * 1024 * 1024 + 1))
    const tailer = new ChildStreamTailer(agents, 0)

    expect(tailer.poll().map((event) => event.kind)).toEqual(['prompt', 'spawn'])
    expect(tailer.poll()).toEqual([
      expect.objectContaining({
        agentId: 'oversized',
        kind: 'error',
        text: expect.stringContaining('1 MiB projection limit'),
      }),
    ])
    expect(fs.statSync(file).size).toBe(2 * 1024 * 1024 + 1)
  })

  it('bounds lifetime state across sequentially rotated valid stream names', () => {
    const agents = makeDir()
    const tailer = new ChildStreamTailer(agents, 0)
    const overflow: string[] = []
    for (let batch = 0; batch < 3; batch += 1) {
      for (let index = 0; index < 200; index += 1) {
        const slug = `worker-${batch}-${index}`
        fs.writeFileSync(path.join(agents, `${slug}.codex.jsonl`), `${codexLine}\n`)
      }
      overflow.push(...tailer.poll().filter((event) => event.text.includes('stream lifetime limit')).map((event) => event.text))
      for (const file of fs.readdirSync(agents)) fs.unlinkSync(path.join(agents, file))
    }

    expect(Object.keys(tailer.snapshot())).toHaveLength(512)
    expect(overflow).toHaveLength(1)
    expect(tailer.poll().filter((event) => event.text.includes('stream lifetime limit'))).toHaveLength(0)
  })
})
