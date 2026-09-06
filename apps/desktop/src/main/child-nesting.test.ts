import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Reading a codex child's live usage needs CODEX_HOME, which comes off the app.
vi.mock('electron', () => ({ app: { getPath: () => os.tmpdir() } }))
import { DEFAULT_CRITIC, resolveModels } from '../shared/models'
import { recoverChildStreams } from './child-agents'
import { Ledger } from './ledger'
import { createClaudeImplementProtocol } from './roles/implement-claude'

/**
 * A delegated codex worker is a process the app never started, so only the
 * command that launched it says who owns it. Without that link every codex row
 * hung off the bottom of the list instead of under its dispatcher.
 */

const models = resolveModels({ orchestratorModel: 'claude-fable-5', subagentModel: 'gpt-5.6-sol', subagentEffort: 'high' }, DEFAULT_CRITIC)
const TOOL_ID = 'toolu_dispatcher'

let dir: string | null = null

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  vi.useRealTimers()
  if (dir) fs.rmSync(dir, { recursive: true, force: true })
  dir = null
})

describe('delegated workers', () => {
  it('nest under the agent that launched them', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gauntlet-nesting-'))
    const workspaceDir = path.join(dir, 'workspace')
    fs.mkdirSync(path.join(workspaceDir, '.gauntlet-gamesmith', 'agents'), { recursive: true })
    fs.writeFileSync(
      path.join(workspaceDir, '.gauntlet-gamesmith', 'agents', 'core.codex.jsonl'),
      JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 100, output_tokens: 50 } }) + '\n',
    )
    const ledger = new Ledger(path.join(dir, 'ledger.db'))
    const build = ledger.createBuild({ prompt: 'build it', workspaceDir, maxRounds: 1, budgetUsd: null, models })
    const attempt = ledger.createAttempt({ buildId: build.id, round: 1, role: 'implement', harness: 'claude', prompt: 'go' })
    const parser = createClaudeImplementProtocol({
      ledger,
      build,
      attempt,
      gate: { suppress: false },
      childBoundary: recoverChildStreams(workspaceDir),
      now: Date.now,
      nowIso: () => new Date().toISOString(),
      harnessHome: () => path.join(dir!, 'harness'),
      log: () => {},
      broadcast: () => {},
      finalize: async () => {},
    })

    const lines = [
      { type: 'assistant', message: { id: 'm1', model: 'claude-fable-5', content: [{ type: 'tool_use', id: TOOL_ID, name: 'Agent', input: { description: 'Fix core' } }] } },
      { type: 'system', subtype: 'task_started', task_id: 'a1', tool_use_id: TOOL_ID, description: 'Fix core', task_type: 'local_agent' },
      // The dispatcher's own shell call is what names the slice.
      {
        type: 'assistant',
        parent_tool_use_id: TOOL_ID,
        message: {
          id: 'm2',
          model: 'claude-sonnet-5',
          usage: { input_tokens: 5, output_tokens: 5 },
          content: [{ type: 'tool_use', id: 'toolu_bash', name: 'Bash', input: { command: 'codex exec - < .gauntlet-gamesmith/codex-core.md > .gauntlet-gamesmith/agents/core.codex.jsonl' } }],
        },
      },
    ]
    for (const line of lines) parser.onLine(JSON.stringify(line))
    vi.advanceTimersByTime(20_000)
    parser.onLine(JSON.stringify({ type: 'assistant', message: { id: 'flush', model: 'claude-fable-5', usage: { input_tokens: 1, output_tokens: 1 }, content: [] } }))

    const agents = ledger.getAttempt(attempt.id)?.metrics?.agents ?? []
    const child = agents.find((a) => a.id === 'child:core')
    expect(child?.parentId).toBe(TOOL_ID)
    expect(agents.findIndex((a) => a.id === 'child:core')).toBe(agents.findIndex((a) => a.id === TOOL_ID) + 1)
  })
})
