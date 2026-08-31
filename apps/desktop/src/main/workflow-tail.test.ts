import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
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

  it('counts a streamed message once, however many times it is rewritten', () => {
    const { dir, runDir } = makeRun()
    // The runtime rewrites a message as it streams; 429 of 885 lines in a real
    // transcript were repeats of an id already seen.
    fs.writeFileSync(path.join(runDir, 'agent-a1.jsonl'), [assistant('m1', 10), assistant('m1', 40), assistant('m2', 5), ''].join('\n'))
    const [agent] = new WorkflowTail(dir).poll()
    expect(agent.tokens.output).toBe(45)
    expect(agent.messages).toBe(2)
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
})
