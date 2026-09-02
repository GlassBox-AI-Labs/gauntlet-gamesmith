import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ChildStreamTailer } from './child-tailer'

let dir: string | null = null

function makeDir(): string {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gauntlet-childtail-'))
  return dir
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

describe('ChildStreamTailer', () => {
  it('attributes each stream to its slug and picks the translator from the file name', () => {
    const agents = makeDir()
    fs.writeFileSync(path.join(agents, 'renderer.claude.jsonl'), `${claudeLine}\n`)
    fs.writeFileSync(path.join(agents, 'physics.codex.jsonl'), `${codexLine}\n`)
    fs.writeFileSync(path.join(agents, 'notes.md'), 'not a stream')
    const tailer = new ChildStreamTailer(agents, 0)
    expect(tailer.poll()).toEqual([
      { agentId: 'physics', channel: 'tool', kind: 'cmd', text: "$ bash -lc 'npm run build'" },
      { agentId: 'renderer', channel: 'thought', kind: 'thought', text: '𝜓 Start with the tile map.' },
      { agentId: 'renderer', channel: 'output', kind: 'claude', text: 'Renderer slice under way.' },
    ])
  })

  it('emits only appended lines on later polls, and streams that appear mid-run', () => {
    const agents = makeDir()
    fs.writeFileSync(path.join(agents, 'renderer.claude.jsonl'), `${claudeLine}\n`)
    const tailer = new ChildStreamTailer(agents, 0)
    expect(tailer.poll()).toHaveLength(2)
    expect(tailer.poll()).toEqual([])

    fs.appendFileSync(path.join(agents, 'renderer.claude.jsonl'), `${claudeLine}\n`)
    fs.writeFileSync(path.join(agents, 'audio.codex.jsonl'), `${codexLine}\n`)
    const next = tailer.poll()
    expect(next.filter((e) => e.agentId === 'renderer')).toHaveLength(2)
    expect(next.filter((e) => e.agentId === 'audio')).toHaveLength(1)
  })

  it('holds a partial trailing line until its newline arrives', () => {
    const agents = makeDir()
    const file = path.join(agents, 'ui.claude.jsonl')
    fs.writeFileSync(file, claudeLine.slice(0, 40))
    const tailer = new ChildStreamTailer(agents, 0)
    expect(tailer.poll()).toEqual([])
    fs.appendFileSync(file, `${claudeLine.slice(40)}\n`)
    expect(tailer.poll()).toHaveLength(2)
  })

  it('skips streams left over from before the run started', () => {
    const agents = makeDir()
    fs.writeFileSync(path.join(agents, 'stale.claude.jsonl'), `${claudeLine}\n`)
    const tailer = new ChildStreamTailer(agents, Date.now() + 60_000)
    expect(tailer.poll()).toEqual([])
  })

  it('resumes from persisted offsets without replaying', () => {
    const agents = makeDir()
    const file = path.join(agents, 'renderer.claude.jsonl')
    fs.writeFileSync(file, `${claudeLine}\n`)
    const first = new ChildStreamTailer(agents, 0)
    first.poll()
    const resumed = new ChildStreamTailer(agents, 0, first.snapshot())
    expect(resumed.poll()).toEqual([])
    fs.appendFileSync(file, `${claudeLine}\n`)
    expect(resumed.poll()).toHaveLength(2)
  })
})
