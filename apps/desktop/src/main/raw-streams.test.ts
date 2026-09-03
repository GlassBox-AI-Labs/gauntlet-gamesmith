import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  parseRevealStreamInput,
  rawRevealTrustError,
  resolveProtectedRawStreamPath,
  resolveRawStreamPath,
  type RawStreamRoots,
} from './raw-streams'

const runId = '11111111-1111-4111-8111-111111111111'
let root: string | null = null

function roots(): RawStreamRoots {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'gauntlet-raw-'))
  return {
    workspaceDir: path.join(root, 'workspace'),
    runId,
    sessionId: 'session-1',
    claudeHome: path.join(root, 'claude'),
    codexHome: path.join(root, 'codex'),
    allowLiveChildStream: true,
  }
}

afterEach(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true })
  root = null
})

describe('raw reveal trust', () => {
  it('denies imported history before it can nominate private CLI-home paths', () => {
    expect(rawRevealTrustError(false)).toMatch(/imported or created before trust provenance shipped/)
    expect(rawRevealTrustError(true)).toBeNull()
  })
})

describe('parseRevealStreamInput', () => {
  it('accepts typed primary and agent requests', () => {
    expect(parseRevealStreamInput({ runId, stream: 'stdout' })).toEqual({ runId, stream: 'stdout' })
    expect(parseRevealStreamInput({ runId, stream: 'agent', agentId: 'child:physics' })).toEqual({
      runId,
      stream: 'agent',
      agentId: 'child:physics',
    })
  })

  it('rejects traversal, coercion, extra agent ids, and agents without separate streams', () => {
    expect(() => parseRevealStreamInput({ runId: '../../run', stream: 'stdout' })).toThrow('Invalid run id')
    expect(() => parseRevealStreamInput({ runId, stream: 'stdout', agentId: 'child:physics' })).toThrow('must not include')
    expect(() => parseRevealStreamInput({ runId, stream: 'agent', agentId: 'orchestrator' })).toThrow('separate raw stream')
    expect(() => parseRevealStreamInput({ runId, stream: 1 })).toThrow('Invalid raw stream kind')
  })
})

describe('resolveRawStreamPath', () => {
  it('resolves run, archived child, workflow, and Codex streams from ids', () => {
    const input = roots()
    const runRoot = path.join(input.workspaceDir, '.gauntlet-gamesmith', 'runs')
    const childRoot = path.join(input.workspaceDir, '.gauntlet-gamesmith', 'agents', runId)
    const workflowRoot = path.join(input.claudeHome, 'projects', input.workspaceDir.replace(/[^a-zA-Z0-9-]/g, '-'), 'session-1', 'subagents', 'workflows', 'wf_build')
    const codexRoot = path.join(input.codexHome, 'sessions', '2026', '09', '02')
    for (const dir of [runRoot, childRoot, workflowRoot, codexRoot]) fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(runRoot, `${runId}.out.ndjson`), '{}\n')
    fs.writeFileSync(path.join(childRoot, 'physics.codex.jsonl'), '{}\n')
    fs.writeFileSync(path.join(workflowRoot, 'agent-a1.jsonl'), '{}\n')
    fs.writeFileSync(path.join(codexRoot, 'rollout-date-thread-abc.jsonl'), '{}\n')

    expect(resolveRawStreamPath(input, { runId, stream: 'stdout' })).toBe(fs.realpathSync(path.join(runRoot, `${runId}.out.ndjson`)))
    expect(resolveRawStreamPath(input, { runId, stream: 'agent', agentId: 'child:physics' })).toBe(fs.realpathSync(path.join(childRoot, 'physics.codex.jsonl')))
    expect(resolveRawStreamPath(input, { runId, stream: 'agent', agentId: 'wf:wf_build:a1' })).toBe(fs.realpathSync(path.join(workflowRoot, 'agent-a1.jsonl')))
    expect(resolveRawStreamPath(input, { runId, stream: 'agent', agentId: 'codex:thread-abc' })).toBe(fs.realpathSync(path.join(codexRoot, 'rollout-date-thread-abc.jsonl')))
  })

  it('refuses a symlink that escapes the owned root', () => {
    const input = roots()
    const runRoot = path.join(input.workspaceDir, '.gauntlet-gamesmith', 'runs')
    fs.mkdirSync(runRoot, { recursive: true })
    const outside = path.join(root!, 'outside.jsonl')
    fs.writeFileSync(outside, 'secret')
    fs.symlinkSync(outside, path.join(runRoot, `${runId}.out.ndjson`))
    expect(() => resolveRawStreamPath(input, { runId, stream: 'stdout' })).toThrow('not a regular file')
  })

  it('refuses hard-linked raw files', () => {
    const input = roots()
    const runRoot = path.join(input.workspaceDir, '.gauntlet-gamesmith', 'runs')
    fs.mkdirSync(runRoot, { recursive: true })
    const outside = path.join(root!, 'outside.jsonl')
    fs.writeFileSync(outside, 'secret')
    fs.linkSync(outside, path.join(runRoot, `${runId}.out.ndjson`))
    expect(() => resolveRawStreamPath(input, { runId, stream: 'stdout' })).toThrow('unsafe hard link')
  })

  it('refuses an owned stream directory redirected outside its workspace', () => {
    const input = roots()
    const outside = path.join(root!, 'outside-runs')
    fs.mkdirSync(path.join(input.workspaceDir, '.gauntlet-gamesmith'), { recursive: true })
    fs.mkdirSync(outside)
    fs.writeFileSync(path.join(outside, `${runId}.out.ndjson`), '{}\n')
    fs.symlinkSync(outside, path.join(input.workspaceDir, '.gauntlet-gamesmith', 'runs'))
    expect(() => resolveRawStreamPath(input, { runId, stream: 'stdout' })).toThrow('unsafe path component')
  })

  it('revalidates a registry workspace before revealing after a protected-root swap', () => {
    const input = roots()
    const originalWorkspace = input.workspaceDir
    const movedWorkspace = `${originalWorkspace}-moved`
    const protectedRoot = path.join(root!, 'private-app-data')
    const protectedRuns = path.join(protectedRoot, '.gauntlet-gamesmith', 'runs')
    fs.mkdirSync(path.join(originalWorkspace, '.gauntlet-gamesmith', 'runs'), { recursive: true })
    fs.mkdirSync(protectedRuns, { recursive: true })
    fs.writeFileSync(path.join(protectedRuns, `${runId}.out.ndjson`), 'private')
    fs.renameSync(originalWorkspace, movedWorkspace)
    fs.symlinkSync(protectedRoot, originalWorkspace)

    expect(() => resolveProtectedRawStreamPath(input, { runId, stream: 'stdout' }, [protectedRoot])).toThrow(
      /overlaps private app data/,
    )
  })

  it('refuses an owned stream directory redirected elsewhere within its owner', () => {
    const input = roots()
    const unrelated = path.join(input.claudeHome, 'unrelated')
    const workflowParent = path.join(
      input.claudeHome,
      'projects',
      input.workspaceDir.replace(/[^a-zA-Z0-9-]/g, '-'),
      'session-1',
      'subagents',
    )
    fs.mkdirSync(unrelated, { recursive: true })
    fs.mkdirSync(workflowParent, { recursive: true })
    fs.mkdirSync(path.join(unrelated, 'wf_build'))
    fs.writeFileSync(path.join(unrelated, 'wf_build', 'agent-a1.jsonl'), '{}\n')
    fs.symlinkSync(unrelated, path.join(workflowParent, 'workflows'))
    expect(() => resolveRawStreamPath(input, { runId, stream: 'agent', agentId: 'wf:wf_build:a1' })).toThrow(
      'unsafe path component',
    )
  })

  it('does not fall back to a newer live child stream for a historical run', () => {
    const input = roots()
    input.allowLiveChildStream = false
    const childRoot = path.join(input.workspaceDir, '.gauntlet-gamesmith', 'agents')
    fs.mkdirSync(childRoot, { recursive: true })
    fs.writeFileSync(path.join(childRoot, 'physics.codex.jsonl'), '{}\n')
    expect(() => resolveRawStreamPath(input, { runId, stream: 'agent', agentId: 'child:physics' })).toThrow('not found')
  })

  it('rejects ambiguous child harnesses and Codex rollout suffixes', () => {
    const input = roots()
    const childRoot = path.join(input.workspaceDir, '.gauntlet-gamesmith', 'agents', runId)
    const codexRoot = path.join(input.codexHome, 'sessions')
    fs.mkdirSync(childRoot, { recursive: true })
    fs.mkdirSync(path.join(codexRoot, 'a'), { recursive: true })
    fs.mkdirSync(path.join(codexRoot, 'b'), { recursive: true })
    fs.writeFileSync(path.join(childRoot, 'physics.codex.jsonl'), '{}\n')
    fs.writeFileSync(path.join(childRoot, 'physics.claude.jsonl'), '{}\n')
    fs.writeFileSync(path.join(codexRoot, 'a', 'rollout-thread.jsonl'), '{}\n')
    fs.writeFileSync(path.join(codexRoot, 'b', 'other-thread.jsonl'), '{}\n')
    expect(() => resolveRawStreamPath(input, { runId, stream: 'agent', agentId: 'child:physics' })).toThrow('ambiguous')
    expect(() => resolveRawStreamPath(input, { runId, stream: 'agent', agentId: 'codex:thread' })).toThrow('ambiguous')
  })

  it('bounds Codex session traversal depth before recursive stack growth', () => {
    const input = roots()
    let directory = path.join(input.codexHome, 'sessions')
    fs.mkdirSync(directory, { recursive: true })
    for (let index = 0; index < 10; index += 1) {
      directory = path.join(directory, `depth-${index}`)
      fs.mkdirSync(directory)
    }
    fs.writeFileSync(path.join(directory, 'rollout-thread.jsonl'), '{}\n')
    expect(() => resolveRawStreamPath(input, { runId, stream: 'agent', agentId: 'codex:thread' })).toThrow('depth limit')
  })

  it('rejects a symlinked Codex sessions root before traversing it', () => {
    const input = roots()
    const outside = path.join(root!, 'outside-sessions')
    fs.mkdirSync(input.codexHome, { recursive: true })
    fs.mkdirSync(outside)
    fs.writeFileSync(path.join(outside, 'rollout-thread.jsonl'), 'private')
    fs.symlinkSync(outside, path.join(input.codexHome, 'sessions'))

    expect(() => resolveRawStreamPath(input, { runId, stream: 'agent', agentId: 'codex:thread' })).toThrow(
      'unsafe path component',
    )
  })
})
