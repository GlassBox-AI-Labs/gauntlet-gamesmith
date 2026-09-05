import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveModels } from '../shared/models'
import { ASSET_WAVE_SIZE } from '../shared/prompts'
import { parseChildProcessExit } from './child-process-exit'
import {
  claudeChildCommand,
  codexChildCommand,
  delegationRules,
  grokAgentsJson,
  implementerAgentDefinition,
  implementerAgentMd,
  quote,
  researchRules,
  sculptorAgentMd,
  sculptorRules,
} from './delegation'

const models = (orchestratorModel: string, subagentModel: string | null) =>
  resolveModels({ orchestratorModel, subagentModel, subagentEffort: 'high' }, null)

describe('quote', () => {
  it.each([
    ['plain', "'plain'"],
    ['two words', "'two words'"],
    ["it's quoted", "'it'\\''s quoted'"],
    ['--leading-dash', "'--leading-dash'"],
    ['value > /tmp/result', "'value > /tmp/result'"],
    ['$(touch /tmp/substitution)', "'$(touch /tmp/substitution)'"],
    ['`touch /tmp/backtick`', "'`touch /tmp/backtick`'"],
    ['../../traversal', "'../../traversal'"],
    ['', "''"],
  ])('quotes %j as one inert shell argument', (value, expected) => {
    expect(quote(value)).toBe(expected)
  })

  it.skipIf(process.platform === 'win32')('round-trips shell metacharacters without evaluating them', () => {
    const value = "a b ' c > $(printf injected) `printf injected` ../../x"
    const result = spawnSync('sh', ['-c', `printf %s ${quote(value)}`], { encoding: 'utf8' })
    expect(result.status).toBe(0)
    expect(result.stdout).toBe(value)
  })

  it('rejects unsafe concrete child slugs before building a command', () => {
    expect(() => codexChildCommand('gpt-5.6-sol', 'high', '../escape')).toThrow(/slug/)
    expect(() => claudeChildCommand('claude-opus-5', 'high', 'space here')).toThrow(/slug/)
  })

  it('uses quoted private executable variables and refuses to clobber a planted stream', () => {
    const command = codexChildCommand('gpt-5.6-sol', 'high', 'renderer')
    expect(command).toContain('( set -C; : > .gauntlet-gamesmith/agents/renderer.codex.jsonl')
    expect(command).toContain('"${GAUNTLET_CODEX_BIN:?}"')
    expect(claudeChildCommand('claude-opus-5', 'high', 'renderer')).toContain('"${GAUNTLET_CLAUDE_BIN:?}"')

    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'gauntlet-delegation-noclobber-'))
    try {
      fs.mkdirSync(path.join(workspace, '.gauntlet-gamesmith', 'agents'), { recursive: true })
      fs.writeFileSync(path.join(workspace, '.gauntlet-gamesmith', 'codex-renderer.md'), 'brief')
      const stream = path.join(workspace, '.gauntlet-gamesmith', 'agents', 'renderer.codex.jsonl')
      fs.writeFileSync(stream, 'operator evidence')
      const result = spawnSync('/bin/sh', ['-c', command], {
        cwd: workspace,
        env: { PATH: '/usr/bin:/bin', GAUNTLET_CODEX_BIN: '/usr/bin/true' },
      })
      expect(result.status).not.toBe(0)
      expect(fs.readFileSync(stream, 'utf8')).toBe('operator evidence')
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('appends the delegated process exit status when the CLI cannot emit protocol output', () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'gauntlet-delegation-exit-'))
    try {
      fs.mkdirSync(path.join(workspace, '.gauntlet-gamesmith', 'agents'), { recursive: true })
      fs.writeFileSync(path.join(workspace, '.gauntlet-gamesmith', 'codex-renderer.md'), 'brief')
      const command = codexChildCommand('gpt-5.6-sol', 'low', 'renderer')
      const result = spawnSync('/bin/sh', ['-c', command], {
        cwd: workspace,
        env: { PATH: '/usr/bin:/bin', GAUNTLET_CODEX_BIN: '/usr/bin/false' },
      })
      expect(result.status).toBe(1)
      const lines = fs.readFileSync(path.join(workspace, '.gauntlet-gamesmith', 'agents', 'renderer.codex.jsonl'), 'utf8').trim().split('\n')
      expect(parseChildProcessExit(lines.at(-1) ?? '')).toEqual({ exitCode: 1 })
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true })
    }
  })
})

describe('implementerAgentMd', () => {
  it('names the worker model directly when both sides are claude', () => {
    const definition = implementerAgentDefinition(models('claude-fable-5', 'claude-opus-5'), 'reference/loop-123')!
    const md = definition.markdown
    expect(definition.filename).toBe(`${definition.agentName}.md`)
    expect(definition.agentName).toMatch(/^gauntlet-implementer-v2-[0-9a-f]{24}$/)
    expect(md).toContain(`name: ${definition.agentName}`)
    expect(md).toContain('model: claude-opus-5')
    expect(md).toContain('effort: high')
    expect(md).toContain('read reference/loop-123/README.md')
    expect(md).toContain('reference/loop-123/research.md')
    expect(md).toContain('progression classification, story beats, and difficulty curve')
  })

  it('fronts a codex worker with a cheap dispatcher that must not background the child', () => {
    const md = implementerAgentMd(models('claude-fable-5', 'gpt-5.6-sol'), 'reference/loop-123')!
    expect(md).toContain('model: claude-sonnet-5')
    expect(md).toContain('Do NOT use `run_in_background`')
    // The child's stream has to land where the app reads tokens from.
    expect(md).toContain('> .gauntlet-gamesmith/agents/<slug>.codex.jsonl')
    expect(md).toContain(`'-m' 'gpt-5.6-sol'`)
  })

  it('writes no agent file when codex orchestrates — its rules ride in the prompt', () => {
    expect(implementerAgentMd(models('gpt-5.6-sol', 'claude-opus-5'), 'reference/loop-123')).toBeNull()
  })
})

describe('delegationRules', () => {
  it('tells a codex orchestrator to override the model per spawn, which needs a bare fork', () => {
    const rules = delegationRules(models('gpt-5.6-sol', 'gpt-5.6-luna'), 'reference/loop-123')
    expect(rules).toContain('spawn_agent')
    expect(rules).toContain('model="gpt-5.6-luna"')
    // The override is refused on a full-history fork — verified against the CLI.
    expect(rules).toContain('fork_turns="none"')
  })

  it('tells a codex orchestrator how to run claude workers and capture them', () => {
    const rules = delegationRules(models('gpt-5.6-sol', 'claude-opus-5'), 'reference/loop-123')
    expect(rules).toContain('claude ')
    expect(rules).toContain(`'--model' 'claude-opus-5'`)
    expect(rules).toContain('> .gauntlet-gamesmith/agents/<slug>.claude.jsonl')
  })

  it('keeps the orchestrator off game source once slices are out, in every delegated pairing', () => {
    for (const pair of [
      ['claude-fable-5', 'claude-opus-5'],
      ['claude-fable-5', 'gpt-5.6-sol'],
      ['gpt-5.6-sol', 'gpt-5.6-luna'],
      ['gpt-5.6-sol', 'claude-opus-5'],
    ] as const) {
      const rules = delegationRules(models(pair[0], pair[1]), 'reference/loop-123')
      expect(rules).toContain('must NOT edit game source yourself')
      expect(rules).toContain('scaffold')
      expect(rules).toContain('reference/loop-123/README.md')
      expect(rules).toContain('reference/loop-123/research.md')
      expect(rules).toContain('story, difficulty, level/progression, and gameplay workers')
    }
  })

  it('uses only the versioned app-owned Claude agent identity', () => {
    const configured = models('claude-fable-5', 'claude-opus-5')
    const definition = implementerAgentDefinition(configured, 'reference/loop-123')!
    const rules = delegationRules(configured, 'reference/loop-123')
    expect(rules).toContain(`.claude/agents/${definition.filename}`)
    expect(rules).toContain(`agentType: '${definition.agentName}'`)
    expect(rules).not.toContain('.claude/agents/implementer.md')
  })

  it('leaves a solo run free to edit — there is nobody to delegate to', () => {
    expect(delegationRules(models('claude-opus-5', null), 'reference/loop-123')).not.toContain('must NOT edit game source')
  })

  it('keeps the solo run free of delegation', () => {
    expect(delegationRules(models('claude-opus-5', null), 'reference/loop-123')).toContain('do NOT delegate')
  })
})

describe('researchRules', () => {
  it('fans researchers out as CLI children whose streams the app can price', () => {
    const rules = researchRules(models('claude-opus-5', null), 'reference/loop-123')
    expect(rules).toContain('gpt-5.6-luna at medium effort')
    expect(rules).toContain(`'-m' 'gpt-5.6-luna'`)
    expect(rules).toContain('> .gauntlet-gamesmith/agents/<slug>.codex.jsonl')
    expect(rules).toContain('reference/loop-123/research/<slug>.md')
    expect(rules).toContain('reference/loop-123/research.md')
    expect(rules).toContain('never touch project source')
  })

  it('uses native codex delegation instead of nesting a sandboxed codex app server', () => {
    const rules = researchRules(models('gpt-5.6-luna', null), 'reference/loop-123')
    expect(rules).toContain('spawn_agent')
    expect(rules).toContain('model="gpt-5.6-luna"')
    expect(rules).toContain('reasoning_effort="medium"')
    expect(rules).toContain('fork_turns="none"')
    expect(rules).not.toContain('GAUNTLET_CODEX_BIN')
  })

  it('routes claude researchers through the claude CLI', () => {
    const base = models('gpt-5.6-sol', null)
    const rules = researchRules({ ...base, researchHarness: 'claude', researchModel: 'claude-sonnet-5', researchEffort: 'low' }, 'reference/loop-123')
    expect(rules).toContain(`'--model' 'claude-sonnet-5'`)
    expect(rules).toContain('> .gauntlet-gamesmith/agents/<slug>.claude.jsonl')
  })

  it('keeps the sweep in-agent when fan-out is off', () => {
    const base = models('claude-opus-5', null)
    const rules = researchRules({ ...base, researchHarness: null, researchModel: null }, 'reference/loop-123')
    expect(rules).toContain('do NOT spawn researcher subagents')
  })
})

const sculptors = (orchestratorModel: string, assetModel: string | null) =>
  resolveModels({ orchestratorModel }, null, null, { assetModel, assetEffort: 'high' })

describe('sculptorAgentMd', () => {
  it('names the sculptor model directly when both sides are claude', () => {
    const md = sculptorAgentMd(sculptors('claude-fable-5', 'claude-opus-5'), 'reference/loop-1')!
    expect(md).toContain('name: sculptor')
    expect(md).toContain('model: claude-opus-5')
    expect(md).toContain('effort: high')
  })

  it('fronts a codex sculptor with a cheap dispatcher that must not background the child', () => {
    const md = sculptorAgentMd(sculptors('claude-fable-5', 'gpt-5.6-sol'), 'reference/loop-1')!
    expect(md).toContain('model: claude-sonnet-5')
    expect(md).toContain('effort: low')
    expect(md).toContain('run_in_background')
    // The brief has to stand alone: codex starts with no memory of the run.
    expect(md).toContain('tools/crop.py')
  })

  it('writes no agent file when there is no asset phase or codex orchestrates', () => {
    expect(sculptorAgentMd(sculptors('claude-fable-5', null), 'reference/loop-1')).toBeNull()
    expect(sculptorAgentMd(sculptors('gpt-5.6-sol', 'claude-opus-5'), 'reference/loop-1')).toBeNull()
  })
})

describe('sculptorRules', () => {
  it('holds every pairing to one sculptor per entry, a wave at a time', () => {
    for (const [orchestrator, worker] of [
      ['claude-fable-5', 'claude-opus-5'],
      ['claude-fable-5', 'gpt-5.6-sol'],
      ['gpt-5.6-sol', 'claude-opus-5'],
      ['gpt-5.6-sol', 'gpt-5.6-terra'],
    ] as const) {
      const rules = sculptorRules(sculptors(orchestrator, worker), 'reference/loop-1')
      expect(rules).toContain('One sculptor per cast entry')
      // A wide fan-out loses every unfinished sculptor to a usage limit, so no
      // pairing may tell the orchestrator to launch the whole cast at once.
      expect(rules).toContain(`launched ${ASSET_WAVE_SIZE} at a time`)
      expect(rules).toContain('never the whole cast at once')
      expect(rules).not.toContain('all launched together')
      // The orchestrator hands out work and checks it; it never sculpts.
      expect(rules).toContain('Do not sculpt anything yourself')
    }
  })

  it('caps a workflow fan-out to the wave size too', () => {
    const models = resolveModels({ orchestratorModel: 'claude-fable-5-1', orchestratorEffort: 'ultracode' }, null, null, {
      assetModel: 'claude-fable-5-1',
      assetEffort: 'high',
    })
    const rules = sculptorRules(models, 'reference/loop-1')

    expect(rules).toContain(`keep its concurrency to ${ASSET_WAVE_SIZE}`)
  })

  it('tells a codex orchestrator to override the model per spawn, which needs a bare fork', () => {
    const rules = sculptorRules(sculptors('gpt-5.6-sol', 'gpt-5.6-terra'), 'reference/loop-1')
    expect(rules).toContain('model="gpt-5.6-terra"')
    expect(rules).toContain('fork_turns="none"')
  })

  it('gives a cross-harness pairing a brief that stands alone', () => {
    const rules = sculptorRules(sculptors('gpt-5.6-sol', 'claude-opus-5'), 'reference/loop-1')
    expect(rules).toContain('.gauntlet-gamesmith/claude-<slug>.md')
    expect(rules).toContain('tools/crop.py')
    expect(rules).toContain('reference/loop-1/objects/')
  })

  it('says nothing when the phase is off — the runner never queues it', () => {
    expect(sculptorRules(sculptors('claude-fable-5', null), 'reference/loop-1')).toBe('')
  })
})

describe('grok delegation', () => {
  const grokPair = (subagentModel: string | null) =>
    resolveModels({ orchestratorModel: 'grok-4.6', subagentModel, subagentEffort: 'high' }, null)

  it('uses grok native subagents when both sides are grok, and says effort will not bind', () => {
    const rules = delegationRules(grokPair('grok-4.5'), 'reference/loop-123')
    expect(rules).toContain('spawn_subagent')
    expect(rules).toContain('subagent_type="implementer"')
    expect(rules).toContain('at high effort')
    expect(rules).toContain('get_command_or_subagent_output')
  })

  it('pins the worker model through the --agents payload rather than the prompt', () => {
    const agents = JSON.parse(grokAgentsJson(grokPair('grok-4.5'), 'reference/loop-123'))
    expect(agents.implementer.model).toBe('grok-4.5')
    // `effort` is a typed field on grok's agent definition, so it binds too.
    expect(agents.implementer.effort).toBe('high')
    expect(agents.implementer.prompt).toContain('reference/loop-123/README.md')
  })

  it('shells out when a grok orchestrator drives another CLI', () => {
    const models = resolveModels({ orchestratorModel: 'grok-4.6', subagentModel: 'gpt-5.6-sol' }, null)
    const rules = delegationRules(models, 'reference/loop-123')
    expect(rules).toContain('.gauntlet-gamesmith/codex-<slug>.md')
    expect(rules).toContain('> .gauntlet-gamesmith/agents/<slug>.codex.jsonl')
  })

  it('fronts a grok worker with a claude dispatcher, since Claude Code runs only claude models', () => {
    const models = resolveModels({ orchestratorModel: 'claude-opus-5', subagentModel: 'grok-4.6' }, null)
    const md = implementerAgentMd(models, 'reference/loop-123')!
    expect(md).toContain('model: claude-sonnet-5')
    expect(md).toContain('through the grok CLI')
    expect(md).toContain('.gauntlet-gamesmith/grok-<slug>.md')
    expect(md).toContain('> .gauntlet-gamesmith/agents/<slug>.grok.jsonl')
    expect(delegationRules(models, 'reference/loop-123')).toContain('through the grok CLI')
  })

  it('routes grok researchers through the grok CLI', () => {
    const base = resolveModels({ orchestratorModel: 'claude-opus-5' }, null)
    const rules = researchRules({ ...base, researchHarness: 'grok', researchModel: 'grok-4.5', researchEffort: 'low' }, 'reference/loop-123')
    expect(rules).toContain('> .gauntlet-gamesmith/agents/<slug>.grok.jsonl')
    expect(rules).toContain(`'--reasoning-effort' 'low'`)
  })
})
