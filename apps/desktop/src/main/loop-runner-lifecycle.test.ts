import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ChildProcess } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { StartLoopInput } from '../shared/loop'
import { IPC } from '../shared/ipc'
import { resolveModels } from '../shared/models'
import { composeImplementPrompt, composeResumePrompt } from '../shared/prompts'
import { Ledger } from './ledger'
import { implementerAgentDefinition } from './delegation'
import { accountLabelForProbe, LoopRunner, type LoopRunnerDeps } from './loop-runner'
import { referencePackFingerprint } from './phase-contracts'
import { PRICE_TABLE_VERSION } from './pricing'
import { configureRoundRevisionStorage } from './round-revision'
import { completeProcessMeta, prepareProcessMeta, processMetaPath, processStreamPaths, readProcessIdentity, readProcessMeta } from './run-process'
import { verdictArtifactRelativePath } from './verdict'

const tempDirs: string[] = []
const ledgers: Ledger[] = []

function setup(
  overrides: Partial<LoopRunnerDeps> = {},
  send: (channel: string, payload: unknown) => void = () => {},
): { ledger: Ledger; runner: LoopRunner; workspaceDir: string; deps: Partial<LoopRunnerDeps> } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gauntlet-runner-lifecycle-'))
  tempDirs.push(root)
  configureRoundRevisionStorage(path.join(root, 'round-revisions'))
  const workspaceDir = path.join(root, 'workspace')
  const harnessRoot = path.join(root, 'harnesses')
  fs.mkdirSync(workspaceDir, { recursive: true })
  const protectedRoots = overrides.protectedRoots ?? (() => [path.join(harnessRoot, 'claude'), path.join(harnessRoot, 'codex')])
  const ledger = new Ledger(path.join(root, 'ledger.db'), { protectedRoots })
  ledgers.push(ledger)
  const deps: Partial<LoopRunnerDeps> = {
    harnessHome: (kind) => {
      const home = path.join(harnessRoot, kind)
      fs.mkdirSync(home, { recursive: true })
      return home
    },
    cliVersion: () => 'test-cli 1.2.3',
    accountLabel: (kind) => `${kind}:test-account@example.com`,
    hostname: () => 'test-host',
    protectedRoots,
    subscriptionReady: () => ({ ok: true, error: null }),
    cliExecutable: (kind) => `/installed/${kind}`,
    validatedExecutableEnv: (executables) => Object.fromEntries(
      [...executables].map(([kind, executable]) => [`GAUNTLET_${kind.toUpperCase()}_BIN`, executable]),
    ),
    processGroupIdentity: (pid) => [`${pid}:${readProcessIdentity(process.pid)!}`],
    // Most lifecycle fixtures use this Vitest process as a stand-in leader but
    // do not model detached descendants. Tests for lingering groups override it.
    processGroupStillOwned: () => false,
    completeProcessMeta: (workspace, runId, marker, pid, streams, groupIdentities) => completeProcessMeta(
      workspace,
      runId,
      marker,
      pid,
      () => ({ identity: readProcessIdentity(process.pid)!, groupId: pid, startedAtMs: marker.startedAtMs }),
      streams,
      groupIdentities,
    ),
    ...overrides,
  }
  const runner = new LoopRunner(ledger, send, deps)
  return { ledger, runner, workspaceDir, deps }
}

function writeReadyReferencePack(workspaceDir: string, loopId: string): string {
  const root = path.join(workspaceDir, 'reference', loopId)
  const evidence = [
    ...Array.from({ length: 8 }, (_, index) => `images/still-${index}.png`),
    ...Array.from({ length: 8 }, (_, index) => `motion/frame-${index}.png`),
    ...Array.from({ length: 4 }, (_, index) => `journey/${String(index + 1).padStart(2, '0')}-step.png`),
    'video/gameplay.mp4',
  ]
  for (const file of evidence) {
    const target = path.join(root, file)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, file)
  }
  fs.writeFileSync(path.join(root, 'README.md'), 'Progression model: non-level-based')
  fs.writeFileSync(path.join(root, 'research.md'), 'Expert gameplay dossier')
  fs.writeFileSync(path.join(root, 'journey.md'), 'menu to play')
  fs.writeFileSync(path.join(root, 'story.md'), 'premise and ending')
  fs.writeFileSync(path.join(root, 'cast.md'), 'none')
  fs.writeFileSync(
    path.join(root, 'manifest.json'),
    JSON.stringify({
      title: 'Test reference',
      sources: evidence.map((file) => ({ url: `https://example.com/${encodeURIComponent(file)}`, file, note: 'test evidence' })),
    }),
  )
  return root
}

const input = (workspaceDir: string): StartLoopInput => ({
  prompt: 'Build the game.',
  workspaceDir,
  maxRounds: 2,
  budgetUsd: null,
  orchestratorModel: 'gpt-5.6-luna',
  orchestratorEffort: 'medium',
  subagentModel: null,
  subagentEffort: 'medium',
  criticModel: 'claude-fable-5',
  criticEffort: 'high',
  researchModel: null,
  researchEffort: 'medium',
  assetModel: null,
  assetEffort: 'medium',
})

async function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000
  while (!check() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20))
  if (!check()) throw new Error('Timed out waiting for runner state.')
}

function workspaceIdentity(workspaceDir: string): { dev: number; ino: number } {
  const stat = fs.lstatSync(workspaceDir)
  return { dev: stat.dev, ino: stat.ino }
}

afterEach(async () => {
  vi.restoreAllMocks()
  // `start` intentionally launches the async orchestration without making UI
  // callers await it. Let terminal promise continuations drain before closing
  // their test ledger; unresolved fake-repeat runs remain parked at that seam.
  await new Promise<void>((resolve) => setImmediate(resolve))
  for (const ledger of ledgers.splice(0)) ledger.close()
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('LoopRunner lifecycle boundary', () => {
  it('treats Stop for an unknown loop id as a no-op', () => {
    const { ledger, runner } = setup()
    runner.stop('00000000-0000-4000-8000-000000000000')
    expect(ledger.loops()).toEqual([])
  })

  it('rejects credential-shaped goal text before creating history', () => {
    const { ledger, runner, workspaceDir } = setup()
    const result = runner.start({ ...input(workspaceDir), prompt: 'Use sk-proj-abcdefghijklmnopqrstuvwxyz1234567890 in the game.' })

    expect(result).toEqual({ ok: false, error: expect.stringContaining('Remove credentials or secrets') })
    expect(ledger.loops()).toEqual([])
  })

  it('preserves an accepted goal byte-for-byte in history and phase prompts', () => {
    const { ledger, runner, workspaceDir } = setup({
      spawnChild: () => { throw new Error('stop after prompt inspection') },
    })
    const prompt = ' \nBuild an exact [arcade] game — preserve this punctuation.\n '

    const result = runner.start({ ...input(workspaceDir), prompt })

    expect(ledger.getLoop(result.loopId!)?.prompt).toBe(prompt)
    const [run] = ledger.runsForLoop(result.loopId!)
    expect(run.prompt).toContain(`<goal>\n${prompt}\n</goal>`)
    const [rawStreamEvent] = ledger.eventsForRun(run.id).filter((event) => event.kind === 'raw-stream')
    expect(rawStreamEvent).toEqual(expect.objectContaining({ runId: run.id, text: 'Raw output stream opened for this attempt.' }))
    expect(Date.parse(rawStreamEvent.ts)).toBeGreaterThanOrEqual(Date.parse(run.startedAt!))
  })

  it('creates a dedicated prompt-named project folder for a new UI run', () => {
    const { ledger, runner, workspaceDir } = setup({
      spawnChild: () => { throw new Error('stop after workspace inspection') },
    })
    const runsRoot = path.join(path.dirname(workspaceDir), 'runs')

    const result = runner.start({ ...input(runsRoot), prompt: 'Build Tower aggro' }, 'new-child')
    const loop = ledger.getLoop(result.loopId!)!

    expect(result.ok).toBe(true)
    expect(loop.title).toBe('Tower aggro')
    expect(loop.workspaceDir).toBe(path.join(fs.realpathSync(runsRoot), 'tower-aggro'))
    expect(fs.statSync(loop.workspaceDir).isDirectory()).toBe(true)
  })

  it('rejects a workspace overlapping protected app data before creating history', () => {
    const { ledger, runner, workspaceDir } = setup({ protectedRoots: () => [path.dirname(workspaceDir)] })
    const result = runner.start(input(workspaceDir))
    expect(result).toEqual({ ok: false, error: expect.stringContaining('overlaps private app data') })
    expect(ledger.loops()).toEqual([])
  })

  it('revalidates the workspace after auth probing and before role launch', () => {
    let workspacePath = ''
    let movedPath = ''
    let swapped = false
    let spawned = false
    const sent: Array<{ channel: string; payload: unknown }> = []
    let replacement = ''
    const { ledger, runner, workspaceDir } = setup({
      subscriptionReady: () => {
        if (!swapped) {
          swapped = true
          movedPath = `${workspacePath}.moved`
          replacement = `${workspacePath}.replacement`
          fs.mkdirSync(replacement)
          fs.renameSync(workspacePath, movedPath)
          fs.symlinkSync(replacement, workspacePath, 'dir')
        }
        return { ok: true, error: null }
      },
      spawnChild: () => {
        spawned = true
        throw new Error('workspace boundary must stop before spawn')
      },
    }, (channel, payload) => sent.push({ channel, payload }))
    workspacePath = workspaceDir

    const started = runner.start(input(workspaceDir))
    const run = ledger.runsForLoop(started.loopId!)[0]

    expect(spawned).toBe(false)
    expect(ledger.getLoop(started.loopId!)?.status).toBe('stopped')
    expect(run.status).toBe('interrupted')
    expect(run.error).toContain('Workspace safety check failed')
    expect(fs.statSync(movedPath).isDirectory()).toBe(true)
    expect(fs.existsSync(path.join(replacement, '.gauntlet-gamesmith'))).toBe(false)
    expect(sent.some(({ channel, payload }) => channel === IPC.loop.log && (payload as { kind?: string }).kind === 'workspace-boundary')).toBe(true)
    expect(sent.some(({ channel, payload }) => channel === IPC.loop.update && (payload as { loop?: { status?: string } }).loop?.status === 'stopped')).toBe(true)
  })

  it('records Claude attribution and a stable Codex managed-profile control label', () => {
    expect(accountLabelForProbe('claude', { loggedIn: true, authMethod: 'account', details: [['Email', 'person@example.com'], ['Organization', 'Studio']] })).toBe(
      'claude:person@example.com:Studio',
    )
    expect(accountLabelForProbe('codex', { loggedIn: true, authMethod: 'ChatGPT', details: [['Provider', 'OpenAI'], ['Auth', 'ChatGPT Plus']] })).toBe(
      'codex:app-profile-1:OpenAI:ChatGPT Plus',
    )
  })

  it('persists exact provenance before a spawn failure and terminalizes both records', () => {
    const { ledger, runner, workspaceDir } = setup({
      spawnChild: () => {
        throw new Error('synthetic spawn failure')
      },
    })

    fs.writeFileSync(path.join(workspaceDir, 'gauntlet-report.md'), 'legacy user-owned report')
    fs.writeFileSync(path.join(workspaceDir, 'gauntlet-report-v1.md'), 'legacy v1 operator report')
    const started = runner.start(input(workspaceDir))
    expect(started.ok, JSON.stringify(started)).toBe(true)
    const run = ledger.runsForLoop(started.loopId!)[0]
    expect(run).toMatchObject({
      status: 'failed',
      effort: 'medium',
      cliVersion: 'test-cli 1.2.3',
      priceTableVersion: PRICE_TABLE_VERSION,
      accountLabel: 'codex:test-account@example.com',
      machineLabel: 'test-host',
      authMode: 'subscription',
      costSource: null,
    })
    expect(run.promptSha256).toBe(createHash('sha256').update(run.prompt).digest('hex'))
    expect(run.finishedAt).not.toBeNull()
    expect(ledger.getLoop(started.loopId!)?.status).toBe('failed')
    expect(runner.activeRun()).toBeNull()
    expect(ledger.eventsForRun(run.id).some((event) => event.text.includes('synthetic spawn failure'))).toBe(true)
    expect(fs.readFileSync(path.join(workspaceDir, 'gauntlet-report.md'), 'utf8')).toBe('legacy user-owned report')
    expect(fs.readFileSync(path.join(workspaceDir, 'gauntlet-report-v1.md'), 'utf8')).toBe('legacy v1 operator report')
    const reportEvent = ledger.eventsForLoop(started.loopId!).find((event) => event.text.startsWith('Immutable report snapshot: '))
    expect(reportEvent).toBeDefined()
    const reportPath = path.join(workspaceDir, reportEvent!.text.slice('Immutable report snapshot: '.length))
    expect(fs.readFileSync(reportPath, 'utf8')).toContain('Generated by Gauntlet Loop')
  })

  it('captures the attempt start after slow provenance probes finish', () => {
    let clock = 1_000
    const { ledger, runner, workspaceDir } = setup({
      now: () => clock,
      cliVersion: () => {
        clock += 10_000
        return 'slow-cli 1.0'
      },
      accountLabel: () => {
        clock += 20_000
        return 'codex:slow-account'
      },
      spawnChild: () => { throw new Error('stop after launch timestamp') },
    })

    const started = runner.start(input(workspaceDir))
    const run = ledger.runsForLoop(started.loopId!)[0]

    expect(run.startedAt).toBe(new Date(31_000).toISOString())
    expect(run.finishedAt).not.toBeNull()
  })

  it('permanently quarantines a launched CLI when canonical group identity cannot be captured', () => {
    const signals: NodeJS.Signals[] = []
    const deferred: Array<() => void> = []
    const child = new EventEmitter() as ChildProcess
    Object.assign(child, {
      pid: 43,
      unref: () => child,
      kill: (signal: NodeJS.Signals) => {
        signals.push(signal)
        return true
      },
    })
    const { ledger, runner, workspaceDir } = setup({
      spawnChild: () => child,
      completeProcessMeta: () => { throw new Error('synthetic identity failure') },
      processGroupIdentity: () => ['43:owned-child'],
      defer: (work) => {
        deferred.push(work)
        return { unref: () => undefined } as unknown as NodeJS.Timeout
      },
    })

    const started = runner.start(input(workspaceDir))
    const run = ledger.runsForLoop(started.loopId!)[0]
    expect(ledger.getRun(run.id)?.status).toBe('interrupted')
    expect(ledger.getLoop(started.loopId!)?.status).toBe('stopped')
    expect(ledger.getRun(run.id)?.error).toContain('Launch identity was not durably recorded')
    expect(signals).toEqual(['SIGINT'])
    expect(runner.resumeLoop(started.loopId!)).toEqual({ ok: false, error: expect.stringContaining('Resume is disabled') })
    child.emit('exit', 0)
    expect(ledger.getRun(run.id)?.status).toBe('interrupted')
    expect(ledger.getRun(run.id)?.error).toContain('Launch identity was not durably recorded')
    expect(runner.start(input(workspaceDir))).toEqual({ ok: false, error: expect.stringContaining('workspace is quarantined') })
    expect(deferred).toHaveLength(1)
  })

  it('clears canonical ownership after its commit reports a mirror failure and the group settles', () => {
    const signals: Array<0 | NodeJS.Signals> = []
    const deferred: Array<() => void> = []
    let owned = true
    const identity = readProcessIdentity(process.pid)!
    const leader = `${process.pid}:${identity}`
    const child = new EventEmitter() as ChildProcess
    Object.assign(child, { pid: process.pid, unref: () => child })
    const { ledger, runner, workspaceDir } = setup({
      spawnChild: () => child,
      processGroupIdentity: () => owned ? [leader] : [],
      processGroupStillOwned: () => owned,
      signalProcess: (_pid, signal) => {
        signals.push(signal)
        if (signal === 'SIGKILL') owned = false
      },
      defer: (work) => {
        deferred.push(work)
        return { unref: () => undefined } as unknown as NodeJS.Timeout
      },
    })
    const setOwnership = ledger.setRunProcessOwnership.bind(ledger)
    vi.spyOn(ledger, 'setRunProcessOwnership').mockImplementation((runId, ownership) => {
      setOwnership(runId, ownership)
      throw new Error('synthetic post-commit mirror failure')
    })

    const started = runner.start(input(workspaceDir))
    const run = ledger.latestRunForLoop(started.loopId!)!
    expect(run.status).toBe('interrupted')
    expect(ledger.runProcessOwnership(run.id)).not.toBeNull()
    expect(signals).toEqual([0, 'SIGINT'])

    while (deferred.length > 0) deferred.shift()!()

    expect(signals).toEqual([0, 'SIGINT', 0, 'SIGKILL'])
    expect(ledger.runProcessOwnership(run.id)).toBeNull()
  })

  it('handles an undefined child pid and its later spawn error without releasing supervision early', async () => {
    const signals: NodeJS.Signals[] = []
    const child = new EventEmitter() as ChildProcess
    Object.assign(child, {
      pid: undefined,
      unref: () => child,
      kill: (signal: NodeJS.Signals) => {
        signals.push(signal)
        return true
      },
    })
    const { ledger, runner, workspaceDir } = setup({
      spawnChild: () => {
        queueMicrotask(() => child.emit('error', new Error('native spawn error')))
        return child
      },
    })

    const started = runner.start(input(workspaceDir))
    await new Promise<void>((resolve) => setImmediate(resolve))

    const run = ledger.runsForLoop(started.loopId!)[0]
    expect(ledger.getLoop(started.loopId!)?.status).toBe('stopped')
    expect(run.status).toBe('interrupted')
    expect(signals).toEqual(['SIGINT'])
    expect(run.error).toContain('Launch identity was not durably recorded')
    expect(run.error).toContain('spawned without a safe PID')
    expect(runner.activeRun()).toBeNull()
  })

  it('keeps an unidentified launch quarantined after a late leader exit', () => {
    const deferred: Array<() => void> = []
    const child = new EventEmitter() as ChildProcess
    Object.assign(child, {
      pid: undefined,
      unref: () => child,
      kill: () => true,
    })
    const { ledger, runner, workspaceDir } = setup({
      spawnChild: () => child,
      defer: (work) => {
        deferred.push(work)
        return { unref: () => undefined } as unknown as NodeJS.Timeout
      },
    })

    const started = runner.start(input(workspaceDir))
    while (deferred.length > 0) deferred.shift()!()
    const run = ledger.runsForLoop(started.loopId!)[0]
    expect(run.status).toBe('interrupted')
    expect(run.error).toContain('Launch identity was not durably recorded')

    child.emit('exit', 0)

    expect(ledger.getRun(run.id)?.error).toContain('Launch identity was not durably recorded')
    expect(runner.resumeLoop(started.loopId!)).toEqual({
      ok: false,
      error: expect.stringContaining('Resume is disabled'),
    })
    expect(runner.start(input(workspaceDir))).toEqual({
      ok: false,
      error: expect.stringContaining('workspace is quarantined'),
    })
  })

  it('closes launch state when CLI version provenance fails before spawn', () => {
    let spawned = false
    const { ledger, runner, workspaceDir } = setup({
      cliVersion: () => { throw new Error('version unavailable') },
      spawnChild: () => {
        spawned = true
        throw new Error('must not spawn')
      },
    })

    const started = runner.start(input(workspaceDir))
    const run = ledger.runsForLoop(started.loopId!)[0]
    expect(spawned).toBe(false)
    expect(run.status).toBe('failed')
    expect(run.error).toContain('Could not establish run provenance')
    expect(fs.existsSync(processMetaPath(workspaceDir, run.id))).toBe(false)
  })

  it('blocks start and resume until a stopped run process group finishes escalation', async () => {
    const signals: Array<0 | NodeJS.Signals> = []
    const deferred: Array<() => void> = []
    const polls: Array<() => void> = []
    const child = new EventEmitter() as ChildProcess
    Object.assign(child, { pid: process.pid, unref: () => child })
    const identity = readProcessIdentity(process.pid)!
    let groupOwned = true
    const { ledger, runner, workspaceDir } = setup({
      wait: async () => {},
      spawnChild: () => child,
      signalProcess: (_pid, signal) => {
        signals.push(signal)
        if (signal === 'SIGKILL') groupOwned = false
      },
      processGroupIdentity: () => [`${process.pid}:${identity}`],
      processGroupStillOwned: () => groupOwned,
      defer: (work) => {
        deferred.push(work)
        return { unref: () => undefined } as unknown as NodeJS.Timeout
      },
      repeat: (work) => {
        polls.push(work)
        return { unref: () => undefined } as unknown as NodeJS.Timeout
      },
      cancelRepeat: () => {},
    })

    const started = runner.start(input(workspaceDir))
    runner.stop(started.loopId!)
    child.emit('exit', 0)
    polls.forEach((poll) => poll())

    expect(signals).toEqual([0, 'SIGINT'])
    expect(runner.activeRun()).not.toBeNull()
    expect(runner.resumeLoop(started.loopId!)).toEqual({ ok: false, error: 'Loop is already running.' })
    expect(runner.start(input(path.join(path.dirname(workspaceDir), 'other-workspace')))).toEqual({
      ok: false,
      error: 'A loop is already running. Stop it first.',
    })

    while (deferred.length > 0) deferred.shift()!()
    polls.forEach((poll) => poll())
    await waitFor(() => ledger.getLoop(started.loopId!)?.status === 'stopped')
    expect(signals).toEqual([0, 'SIGINT', 0, 'SIGKILL'])
  })

  it('Stop interrupts captured descendants after the durable leader exited', () => {
    const deadPid = 2_000_000_000
    const identity = readProcessIdentity(process.pid)!
    const leader = `${deadPid}:${identity}`
    const descendant = `${deadPid - 1}:${identity}`
    const signals: Array<0 | NodeJS.Signals> = []
    const deferred: Array<() => void> = []
    const child = new EventEmitter() as ChildProcess
    Object.assign(child, { pid: deadPid, unref: () => child })
    const { ledger, runner, workspaceDir } = setup({
      spawnChild: () => child,
      completeProcessMeta: (workspace, runId, marker, pid, streams, groupIdentities) => completeProcessMeta(
        workspace,
        runId,
        marker,
        pid,
        () => ({ identity, groupId: pid, startedAtMs: marker.startedAtMs }),
        streams,
        groupIdentities,
      ),
      processGroupIdentity: () => [leader, descendant],
      processGroupStillOwned: (_pid, captured) => captured.includes(descendant),
      signalProcess: (_pid, signal) => { signals.push(signal) },
      repeat: () => ({ unref: () => undefined } as unknown as NodeJS.Timeout),
      cancelRepeat: () => {},
      defer: (work) => {
        deferred.push(work)
        return { unref: () => undefined } as unknown as NodeJS.Timeout
      },
    })

    const started = runner.start(input(workspaceDir))
    const run = ledger.runsForLoop(started.loopId!)[0]
    runner.stop(started.loopId!)

    expect(signals).toEqual([0, 'SIGINT'])
    expect(ledger.runProcessOwnership(run.id)?.groupIdentities).toEqual([leader, descendant])
    expect(deferred).toHaveLength(1)
  })

  it.each(['current', 'retained'] as const)('%s Stop starts process control when portable event writes fail', (mode) => {
    const signals: Array<0 | NodeJS.Signals> = []
    const child = new EventEmitter() as ChildProcess
    Object.assign(child, { pid: process.pid, unref: () => child })
    const { ledger, runner, workspaceDir, deps } = setup({
      spawnChild: () => child,
      signalProcess: (_pid, signal) => { signals.push(signal) },
      processGroupStillOwned: () => true,
      defer: () => ({ unref: () => undefined } as unknown as NodeJS.Timeout),
      repeat: () => ({ unref: () => undefined } as unknown as NodeJS.Timeout),
      cancelRepeat: () => {},
    })
    const started = runner.start(input(workspaceDir))
    vi.spyOn(ledger, 'appendEvent').mockImplementation(() => { throw new Error('synthetic portable event failure') })
    const controller = mode === 'current' ? runner : new LoopRunner(ledger, () => {}, deps)

    controller.stop(started.loopId!)

    expect(signals).toEqual([0, 'SIGINT'])
    expect(controller.hasUnsettledOwnership()).toBe(true)
  })

  it('starts timeout interruption even when ordinary event persistence fails', () => {
    const polls: Array<() => void> = []
    const signals: Array<0 | NodeJS.Signals> = []
    const child = new EventEmitter() as ChildProcess
    Object.assign(child, { pid: process.pid, unref: () => child })
    let now = Date.now()
    const { ledger, runner, workspaceDir } = setup({
      now: () => now,
      spawnChild: () => child,
      signalProcess: (_pid, signal) => { signals.push(signal) },
      processGroupStillOwned: () => true,
      defer: () => ({ unref: () => undefined } as unknown as NodeJS.Timeout),
      repeat: (work) => {
        polls.push(work)
        return { unref: () => undefined } as unknown as NodeJS.Timeout
      },
      cancelRepeat: () => {},
    })
    const started = runner.start(input(workspaceDir))
    vi.spyOn(ledger, 'appendEvent').mockImplementation(() => { throw new Error('synthetic portable event failure') })
    now += 61 * 60_000

    polls[0]()

    expect(signals).toEqual([0, 'SIGINT'])
    expect(runner.hasUnsettledOwnership()).toBe(true)
    expect(ledger.getLoop(started.loopId!)?.status).toBe('running')
  })

  it('quit interrupts captured descendants after the durable leader exited', () => {
    const deadPid = 1_999_999_999
    const identity = readProcessIdentity(process.pid)!
    const leader = `${deadPid}:${identity}`
    const descendant = `${deadPid - 1}:${identity}`
    const signals: Array<0 | NodeJS.Signals> = []
    const deferred: Array<() => void> = []
    const child = new EventEmitter() as ChildProcess
    Object.assign(child, { pid: deadPid, unref: () => child })
    const { ledger, runner, workspaceDir } = setup({
      spawnChild: () => child,
      completeProcessMeta: (workspace, runId, marker, pid, streams, groupIdentities) => completeProcessMeta(
        workspace,
        runId,
        marker,
        pid,
        () => ({ identity, groupId: pid, startedAtMs: marker.startedAtMs }),
        streams,
        groupIdentities,
      ),
      processGroupIdentity: () => [leader, descendant],
      processGroupStillOwned: (_pid, captured) => captured.includes(descendant),
      signalProcess: (_pid, signal) => { signals.push(signal) },
      repeat: () => ({ unref: () => undefined } as unknown as NodeJS.Timeout),
      cancelRepeat: () => {},
      defer: (work) => {
        deferred.push(work)
        return { unref: () => undefined } as unknown as NodeJS.Timeout
      },
    })

    const started = runner.start(input(workspaceDir))
    const run = ledger.runsForLoop(started.loopId!)[0]
    runner.stopForQuit()

    expect(signals).toEqual([0, 'SIGINT'])
    expect(ledger.getLoop(started.loopId!)?.status).toBe('stopped')
    expect(ledger.runProcessOwnership(run.id)?.groupIdentities).toEqual([leader, descendant])
    expect(deferred).toHaveLength(1)
  })

  it.each([
    ['Stop', (runner: LoopRunner, loopId: string) => runner.stop(loopId), 'running'],
    ['quit', (runner: LoopRunner) => runner.stopForQuit(), 'stopped'],
  ] as const)('%s never signals a reused foreign PGID after the captured leader exited', (_label, interrupt, expectedLoopStatus) => {
    const deadPid = 1_999_999_996
    const identity = readProcessIdentity(process.pid)!
    const leader = `${deadPid}:${identity}`
    const descendant = `${deadPid - 1}:${identity}`
    const stranger = `${deadPid - 2}:${identity}`
    const signals: Array<0 | NodeJS.Signals> = []
    const child = new EventEmitter() as ChildProcess
    Object.assign(child, { pid: deadPid, unref: () => child })
    let launchCapture = true
    const { ledger, runner, workspaceDir } = setup({
      spawnChild: () => child,
      completeProcessMeta: (workspace, runId, marker, pid, streams, groupIdentities) => completeProcessMeta(
        workspace,
        runId,
        marker,
        pid,
        () => ({ identity, groupId: pid, startedAtMs: marker.startedAtMs }),
        streams,
        groupIdentities,
      ),
      processGroupIdentity: () => launchCapture ? [leader, descendant] : [stranger],
      processGroupStillOwned: () => launchCapture,
      signalProcess: (_pid, signal) => { signals.push(signal) },
      repeat: () => ({ unref: () => undefined } as unknown as NodeJS.Timeout),
      cancelRepeat: () => {},
    })

    const started = runner.start(input(workspaceDir))
    const run = ledger.runsForLoop(started.loopId!)[0]
    launchCapture = false
    interrupt(runner, started.loopId!)

    expect(signals).toEqual([])
    expect(ledger.runProcessOwnership(run.id)?.groupIdentities).toEqual([leader, descendant])
    expect(ledger.getLoop(started.loopId!)?.status).toBe(expectedLoopStatus)
    expect(ledger.eventsForRun(run.id).some((event) => event.text.includes('manual intervention'))).toBe(true)
  })

  it('retains canonical ownership across restart when a group survives SIGKILL', () => {
    const deferred: Array<() => void> = []
    const polls: Array<() => void> = []
    const child = new EventEmitter() as ChildProcess
    Object.assign(child, { pid: process.pid, unref: () => child })
    const { ledger, runner, workspaceDir, deps } = setup({
      wait: async () => {},
      spawnChild: () => child,
      signalProcess: () => {},
      processGroupStillOwned: () => true,
      defer: (work) => {
        deferred.push(work)
        return { unref: () => undefined } as unknown as NodeJS.Timeout
      },
      repeat: (work) => {
        polls.push(work)
        return { unref: () => undefined } as unknown as NodeJS.Timeout
      },
      cancelRepeat: () => {},
    })

    const started = runner.start(input(workspaceDir))
    const run = ledger.runsForLoop(started.loopId!)[0]
    runner.stop(started.loopId!)
    child.emit('exit', 0)
    polls.forEach((poll) => poll())
    while (deferred.length > 0) deferred.shift()!()
    runner.stopForQuit()

    expect(ledger.runProcessOwnership(run.id)).not.toBeNull()
    const restarted = new LoopRunner(ledger, () => {}, deps)
    restarted.recoverAll()
    expect(restarted.hasUnsettledOwnership()).toBe(true)
    expect(restarted.quitSettlementPending()).toBe(true)
    expect(restarted.activeRun()).toMatchObject({ loopId: started.loopId, runId: run.id, pid: process.pid })
    expect(restarted.start(input(path.join(path.dirname(workspaceDir), 'other-workspace')))).toEqual({
      ok: false,
      error: expect.stringContaining('still owned'),
    })
  })

  it('persists a late descendant before quit so restart retains its ownership', () => {
    const deferred: Array<() => void> = []
    const polls: Array<() => void> = []
    const child = new EventEmitter() as ChildProcess
    Object.assign(child, { pid: process.pid, unref: () => child })
    const leader = `${process.pid}:${readProcessIdentity(process.pid)!}`
    const descendant = `${process.pid + 1}:${readProcessIdentity(process.pid)!}`
    let captures = 0
    const { ledger, runner, workspaceDir, deps } = setup({
      spawnChild: () => child,
      signalProcess: () => {},
      processGroupIdentity: () => (++captures === 1 ? [leader] : [leader, descendant]),
      processGroupStillOwned: (_pid, identities) => identities.includes(descendant),
      defer: (work) => {
        deferred.push(work)
        return { unref: () => undefined } as unknown as NodeJS.Timeout
      },
      repeat: (work) => {
        polls.push(work)
        return { unref: () => undefined } as unknown as NodeJS.Timeout
      },
      cancelRepeat: () => {},
    })

    const started = runner.start(input(workspaceDir))
    const run = ledger.runsForLoop(started.loopId!)[0]
    runner.stopForQuit()
    child.emit('exit', 0)

    expect(ledger.runProcessOwnership(run.id)?.groupIdentities).toEqual([leader, descendant])
    // Dynamic ownership advances only in the canonical registry; portable
    // workspace metadata is never trusted as recovery authority.
    const restarted = new LoopRunner(ledger, () => {}, deps)
    expect(restarted.start(input(path.join(path.dirname(workspaceDir), 'other-workspace')))).toEqual({
      ok: false,
      error: expect.stringContaining('still owned'),
    })
  })

  it('awaits identity-bound quit escalation and reports whether the group settled', async () => {
    for (const shouldSettle of [true, false]) {
      const deferred: Array<() => void> = []
      const child = new EventEmitter() as ChildProcess
      Object.assign(child, { pid: process.pid, unref: () => child })
      const leader = `${process.pid}:${readProcessIdentity(process.pid)!}`
      let owned = true
      const { ledger, runner, workspaceDir } = setup({
        spawnChild: () => child,
        processGroupIdentity: () => owned ? [leader] : [],
        processGroupStillOwned: () => owned,
        signalProcess: (_pid, signal) => {
          if (signal === 'SIGKILL' && shouldSettle) owned = false
        },
        defer: (work) => {
          deferred.push(work)
          return { unref: () => undefined } as unknown as NodeJS.Timeout
        },
        wait: async () => { deferred.shift()?.() },
        repeat: () => ({ unref: () => undefined } as unknown as NodeJS.Timeout),
        cancelRepeat: () => {},
      })

      const started = runner.start(input(workspaceDir))
      const run = ledger.runsForLoop(started.loopId!)[0]
      expect(await runner.stopForQuitAndWait(400)).toBe(shouldSettle)
      expect(ledger.getLoop(started.loopId!)?.status).toBe('stopped')
      expect(ledger.runProcessOwnership(run.id) === null).toBe(shouldSettle)
    }
  })

  it('resumes SIGINT-first settlement for a retained owner before quit', async () => {
    const deferred: Array<() => void> = []
    const signals: Array<0 | NodeJS.Signals> = []
    let owned = true
    const identity = readProcessIdentity(process.pid)!
    const leader = `${process.pid}:${identity}`
    const { ledger, runner, workspaceDir } = setup({
      processGroupIdentity: () => owned ? [leader] : [],
      processGroupStillOwned: () => owned,
      signalProcess: (_pid, signal) => {
        signals.push(signal)
        if (signal === 'SIGKILL') owned = false
      },
      defer: (work) => {
        deferred.push(work)
        return { unref: () => undefined } as unknown as NodeJS.Timeout
      },
      wait: async () => { deferred.shift()?.() },
    })
    const models = resolveModels(input(workspaceDir), input(workspaceDir), input(workspaceDir))
    const loop = ledger.createLoop({ prompt: 'retained quit', workspaceDir, maxRounds: 2, budgetUsd: null, models })
    const run = ledger.createRun({ loopId: loop.id, round: 0, role: 'reference', harness: 'codex', prompt: 'research' })
    const startedAtMs = Date.now()
    ledger.patchRun(run.id, { status: 'cancelled', startedAt: new Date(startedAtMs).toISOString(), finishedAt: new Date(startedAtMs).toISOString() })
    ledger.patchLoop(loop.id, { status: 'stopped' })
    const marker = prepareProcessMeta(workspaceDir, run.id, startedAtMs, workspaceIdentity(workspaceDir))
    fs.writeFileSync(marker.outPath, '')
    fs.writeFileSync(marker.errPath, '')
    const meta = completeProcessMeta(
      workspaceDir,
      run.id,
      marker,
      process.pid,
      () => ({ identity, groupId: process.pid, startedAtMs }),
    )
    ledger.setRunProcessOwnership(run.id, {
      pid: meta.pid,
      processIdentity: meta.processIdentity,
      groupIdentities: [leader],
      startedAtMs: meta.startedAtMs,
      outDev: meta.outDev,
      outIno: meta.outIno,
      errDev: meta.errDev,
      errIno: meta.errIno,
    })

    expect(await runner.stopForQuitAndWait(1_000)).toBe(true)
    expect(signals).toEqual([0, 'SIGINT', 0, 'SIGKILL'])
    expect(ledger.runProcessOwnership(run.id)).toBeNull()
  })

  it('settles a current owner at quit without mirroring through a replaced workspace', async () => {
    const deferred: Array<() => void> = []
    const signals: Array<0 | NodeJS.Signals> = []
    let owned = true
    const identity = readProcessIdentity(process.pid)!
    const leader = `${process.pid}:${identity}`
    const child = new EventEmitter() as ChildProcess
    Object.assign(child, { pid: process.pid, unref: () => child })
    const { ledger, runner, workspaceDir } = setup({
      spawnChild: () => child,
      processGroupIdentity: () => owned ? [leader] : [],
      processGroupStillOwned: () => owned,
      signalProcess: (_pid, signal) => {
        signals.push(signal)
        if (signal === 'SIGKILL') owned = false
      },
      defer: (work) => {
        deferred.push(work)
        return { unref: () => undefined } as unknown as NodeJS.Timeout
      },
      wait: async () => { deferred.shift()?.() },
      repeat: () => ({ unref: () => undefined } as unknown as NodeJS.Timeout),
      cancelRepeat: () => {},
    })
    const started = runner.start(input(workspaceDir))
    const run = ledger.latestRunForLoop(started.loopId!)!
    fs.renameSync(workspaceDir, `${workspaceDir}.preserved`)
    fs.mkdirSync(workspaceDir)

    expect(await runner.stopForQuitAndWait(1_000)).toBe(true)
    expect(signals).toEqual([0, 'SIGINT', 0, 'SIGKILL'])
    expect(ledger.getRun(run.id)?.status).toBe('interrupted')
    expect(ledger.getLoop(started.loopId!)?.status).toBe('stopped')
    expect(fs.readdirSync(workspaceDir)).toEqual([])
  })

  it('settles a retained running owner at quit without mirroring through a replaced workspace', async () => {
    const deferred: Array<() => void> = []
    const signals: Array<0 | NodeJS.Signals> = []
    let owned = true
    const identity = readProcessIdentity(process.pid)!
    const leader = `${process.pid}:${identity}`
    const { ledger, runner, workspaceDir } = setup({
      processGroupIdentity: () => owned ? [leader] : [],
      processGroupStillOwned: () => owned,
      signalProcess: (_pid, signal) => {
        signals.push(signal)
        if (signal === 'SIGKILL') owned = false
      },
      defer: (work) => {
        deferred.push(work)
        return { unref: () => undefined } as unknown as NodeJS.Timeout
      },
      wait: async () => { deferred.shift()?.() },
    })
    const models = resolveModels(input(workspaceDir), input(workspaceDir), input(workspaceDir))
    const loop = ledger.createLoop({ prompt: 'unsafe retained quit', workspaceDir, maxRounds: 2, budgetUsd: null, models })
    const run = ledger.createRun({ loopId: loop.id, round: 0, role: 'reference', harness: 'codex', prompt: 'research' })
    const startedAtMs = Date.now()
    ledger.patchRun(run.id, { status: 'running', startedAt: new Date(startedAtMs).toISOString() })
    const marker = prepareProcessMeta(workspaceDir, run.id, startedAtMs, workspaceIdentity(workspaceDir))
    fs.writeFileSync(marker.outPath, '')
    fs.writeFileSync(marker.errPath, '')
    const meta = completeProcessMeta(
      workspaceDir,
      run.id,
      marker,
      process.pid,
      () => ({ identity, groupId: process.pid, startedAtMs }),
    )
    ledger.setRunProcessOwnership(run.id, {
      pid: meta.pid,
      processIdentity: meta.processIdentity,
      groupIdentities: [leader],
      startedAtMs: meta.startedAtMs,
      outDev: meta.outDev,
      outIno: meta.outIno,
      errDev: meta.errDev,
      errIno: meta.errIno,
    })
    fs.renameSync(workspaceDir, `${workspaceDir}.preserved`)
    fs.mkdirSync(workspaceDir)

    expect(await runner.stopForQuitAndWait(1_000)).toBe(true)
    expect(signals).toEqual([0, 'SIGINT', 0, 'SIGKILL'])
    expect(ledger.getRun(run.id)?.status).toBe('interrupted')
    expect(ledger.getLoop(loop.id)?.status).toBe('stopped')
    expect(fs.readdirSync(workspaceDir)).toEqual([])
  })

  it('quarantines an incomplete launch record instead of risking a duplicate editor', () => {
    const { ledger, runner, workspaceDir } = setup({
      spawnChild: () => {
        throw new Error('replacement spawn stopped for test')
      },
    })
    const models = resolveModels(input(workspaceDir), input(workspaceDir), input(workspaceDir))
    const loop = ledger.createLoop({ prompt: 'recover', workspaceDir, maxRounds: 2, budgetUsd: null, models })
    const run = ledger.createRun({ loopId: loop.id, round: 0, role: 'reference', harness: 'codex', prompt: 'research' })
    const startedAt = new Date().toISOString()
    ledger.patchRun(run.id, { status: 'running', startedAt })
    prepareProcessMeta(workspaceDir, run.id, Date.parse(startedAt), workspaceIdentity(workspaceDir))

    runner.recoverAll()

    const attempts = ledger.runsForLoop(loop.id)
    expect(attempts.map((attempt) => attempt.status)).toEqual(['interrupted'])
    expect(ledger.getLoop(loop.id)?.status).toBe('stopped')
    expect(ledger.eventsForLoop(loop.id).some((event) => event.text.includes('Canonical process ownership is missing'))).toBe(true)
    expect(runner.resumeLoop(loop.id)).toEqual({
      ok: false,
      error: expect.stringContaining('Resume is disabled to avoid duplicating an untracked editor'),
    })
  })

  it('reattaches from canonical ownership when workspace process metadata is deleted', () => {
    let spawned = false
    const polls: Array<() => void> = []
    const { ledger, runner, workspaceDir } = setup({
      spawnChild: () => {
        spawned = true
        throw new Error('recovery must not launch a replacement')
      },
      repeat: (work) => {
        polls.push(work)
        return { unref: () => undefined } as unknown as NodeJS.Timeout
      },
      cancelRepeat: () => {},
      processGroupStillOwned: () => true,
    })
    const models = resolveModels(input(workspaceDir), input(workspaceDir), input(workspaceDir))
    const loop = ledger.createLoop({ prompt: 'recover canonically', workspaceDir, maxRounds: 2, budgetUsd: null, models })
    const run = ledger.createRun({ loopId: loop.id, round: 0, role: 'reference', harness: 'codex', prompt: 'research' })
    const startedAtMs = Date.now()
    ledger.patchRun(run.id, { status: 'running', startedAt: new Date(startedAtMs).toISOString() })
    const marker = prepareProcessMeta(workspaceDir, run.id, startedAtMs, workspaceIdentity(workspaceDir))
    fs.writeFileSync(marker.outPath, '')
    fs.writeFileSync(marker.errPath, '')
    const identity = readProcessIdentity(process.pid)!
    const meta = completeProcessMeta(
      workspaceDir,
      run.id,
      marker,
      process.pid,
      () => ({ identity, groupId: process.pid, startedAtMs }),
    )
    ledger.setRunProcessOwnership(run.id, {
      pid: meta.pid,
      processIdentity: meta.processIdentity,
      groupIdentities: [`${meta.pid}:${meta.processIdentity}`],
      startedAtMs: meta.startedAtMs,
      outDev: meta.outDev,
      outIno: meta.outIno,
      errDev: meta.errDev,
      errIno: meta.errIno,
    })
    fs.unlinkSync(processMetaPath(workspaceDir, run.id))
    fs.mkdirSync(path.join(workspaceDir, '.gauntlet-gamesmith', 'agents'))

    runner.recoverAll()

    expect(spawned).toBe(false)
    expect(runner.activeRun()).toMatchObject({ loopId: loop.id, runId: run.id, pid: process.pid })
    expect(ledger.eventsForRun(run.id).some((event) => event.text.includes('re-attached to live reference'))).toBe(true)
    expect(polls).toHaveLength(1)
  })

  it('touches no replacement workspace before validating retained boot ownership', () => {
    const { ledger, runner, workspaceDir } = setup({
      signalProcess: () => {},
      processGroupStillOwned: () => false,
      defer: () => ({ unref: () => undefined } as unknown as NodeJS.Timeout),
    })
    const models = resolveModels(input(workspaceDir), input(workspaceDir), input(workspaceDir))
    const loop = ledger.createLoop({ prompt: 'recover safely', workspaceDir, maxRounds: 2, budgetUsd: null, models })
    const run = ledger.createRun({ loopId: loop.id, round: 0, role: 'reference', harness: 'codex', prompt: 'research' })
    const startedAtMs = Date.now()
    ledger.patchRun(run.id, { status: 'running', startedAt: new Date(startedAtMs).toISOString() })
    const marker = prepareProcessMeta(workspaceDir, run.id, startedAtMs, workspaceIdentity(workspaceDir))
    fs.writeFileSync(marker.outPath, '')
    fs.writeFileSync(marker.errPath, '')
    const identity = readProcessIdentity(process.pid)!
    const meta = completeProcessMeta(
      workspaceDir,
      run.id,
      marker,
      process.pid,
      () => ({ identity, groupId: process.pid, startedAtMs }),
    )
    ledger.setRunProcessOwnership(run.id, {
      pid: meta.pid,
      processIdentity: meta.processIdentity,
      groupIdentities: [`${meta.pid}:${meta.processIdentity}`],
      startedAtMs: meta.startedAtMs,
      outDev: meta.outDev,
      outIno: meta.outIno,
      errDev: meta.errDev,
      errIno: meta.errIno,
    })
    const preserved = `${workspaceDir}.preserved`
    fs.renameSync(workspaceDir, preserved)
    fs.mkdirSync(workspaceDir)

    runner.recoverAll()

    expect(fs.readdirSync(workspaceDir)).toEqual([])
    expect(ledger.runProcessOwnership(run.id)).not.toBeNull()
  })

  it('interrupts a stopped retained owner after the workspace root was replaced', () => {
    const signals: Array<0 | NodeJS.Signals> = []
    const deferred: Array<() => void> = []
    const identity = readProcessIdentity(process.pid)!
    const leader = `${process.pid}:${identity}`
    const { ledger, runner, workspaceDir } = setup({
      signalProcess: (_pid, signal) => { signals.push(signal) },
      processGroupIdentity: () => [leader],
      processGroupStillOwned: () => true,
      defer: (work) => {
        deferred.push(work)
        return { unref: () => undefined } as unknown as NodeJS.Timeout
      },
    })
    const models = resolveModels(input(workspaceDir), input(workspaceDir), input(workspaceDir))
    const loop = ledger.createLoop({ prompt: 'stopped retained recovery', workspaceDir, maxRounds: 2, budgetUsd: null, models })
    const run = ledger.createRun({ loopId: loop.id, round: 0, role: 'reference', harness: 'codex', prompt: 'research' })
    const startedAtMs = Date.now()
    ledger.patchRun(run.id, { status: 'cancelled', startedAt: new Date(startedAtMs).toISOString(), finishedAt: new Date(startedAtMs).toISOString() })
    ledger.patchLoop(loop.id, { status: 'stopped' })
    const marker = prepareProcessMeta(workspaceDir, run.id, startedAtMs, workspaceIdentity(workspaceDir))
    fs.writeFileSync(marker.outPath, '')
    fs.writeFileSync(marker.errPath, '')
    const meta = completeProcessMeta(
      workspaceDir,
      run.id,
      marker,
      process.pid,
      () => ({ identity, groupId: process.pid, startedAtMs }),
    )
    ledger.setRunProcessOwnership(run.id, {
      pid: meta.pid,
      processIdentity: meta.processIdentity,
      groupIdentities: [leader],
      startedAtMs: meta.startedAtMs,
      outDev: meta.outDev,
      outIno: meta.outIno,
      errDev: meta.errDev,
      errIno: meta.errIno,
    })
    fs.renameSync(workspaceDir, `${workspaceDir}.preserved`)
    fs.mkdirSync(workspaceDir)

    runner.recoverAll()

    expect(signals).toEqual([0, 'SIGINT'])
    expect(deferred).toHaveLength(1)
    expect(ledger.runProcessOwnership(run.id)).not.toBeNull()
    expect(fs.readdirSync(workspaceDir)).toEqual([])
    expect(ledger.eventsForRun(run.id).some((event) => event.text.includes('SIGINT sent'))).toBe(true)
  })

  it('durably extends ownership across an overlap chain after the leader exits', () => {
    const polls: Array<() => void> = []
    const child = new EventEmitter() as ChildProcess
    const deadPid = 1_999_999_998
    Object.assign(child, { pid: deadPid, unref: () => child })
    const identity = readProcessIdentity(process.pid)!
    const leader = `${deadPid}:${identity}`
    const descendant = `${deadPid - 1}:${identity}`
    const grandchild = `${deadPid - 2}:${identity}`
    const signals: Array<0 | NodeJS.Signals> = []
    let groupReads = 0
    const { ledger, runner, workspaceDir } = setup({
      spawnChild: () => child,
      completeProcessMeta: (workspace, runId, marker, pid, streams, groupIdentities) => completeProcessMeta(
        workspace,
        runId,
        marker,
        pid,
        () => ({ identity, groupId: pid, startedAtMs: marker.startedAtMs }),
        streams,
        groupIdentities,
      ),
      processGroupIdentity: () => {
        groupReads += 1
        if (groupReads === 1) return [leader]
        if (groupReads === 2) return [leader, descendant]
        return [descendant, grandchild]
      },
      processGroupStillOwned: (_pid, captured) => captured.includes(grandchild),
      signalProcess: (_pid, signal) => { signals.push(signal) },
      repeat: (work) => {
        polls.push(work)
        return { unref: () => undefined } as unknown as NodeJS.Timeout
      },
      cancelRepeat: () => {},
    })

    const started = runner.start(input(workspaceDir))
    const run = ledger.runsForLoop(started.loopId!)[0]
    polls[0]()
    child.emit('exit', 0)
    polls[0]()
    runner.stop(started.loopId!)

    expect(ledger.runProcessOwnership(run.id)?.groupIdentities).toEqual([leader, descendant, grandchild])
    expect(runner.activeRun()?.runId).toBe(run.id)
    expect(signals).toEqual([0, 'SIGINT'])
  })

  it('never adopts or signals a reused numeric process group during recovery', () => {
    let spawned = false
    const signals: Array<0 | NodeJS.Signals> = []
    const { ledger, runner, workspaceDir } = setup({
      spawnChild: () => {
        spawned = true
        throw new Error('must not launch replacement work')
      },
      signalProcess: (_pid, signal) => { signals.push(signal) },
      processGroupIdentity: () => [`${process.pid}:${readProcessIdentity(process.pid)!}`],
      processGroupStillOwned: () => false,
    })
    const models = resolveModels(input(workspaceDir), input(workspaceDir), input(workspaceDir))
    const loop = ledger.createLoop({ prompt: 'reject reused pid', workspaceDir, maxRounds: 2, budgetUsd: null, models })
    const run = ledger.createRun({ loopId: loop.id, round: 0, role: 'reference', harness: 'codex', prompt: 'research' })
    const startedAtMs = Date.now()
    ledger.patchRun(run.id, { status: 'running', startedAt: new Date(startedAtMs).toISOString() })
    const marker = prepareProcessMeta(workspaceDir, run.id, startedAtMs, workspaceIdentity(workspaceDir))
    fs.writeFileSync(marker.outPath, '')
    fs.writeFileSync(marker.errPath, '')
    const out = fs.lstatSync(marker.outPath)
    const err = fs.lstatSync(marker.errPath)
    const staleIdentity = 'Thu Sep  3 01:00:00 2026'
    ledger.setRunProcessOwnership(run.id, {
      pid: process.pid,
      processIdentity: staleIdentity,
      groupIdentities: [`${process.pid}:${staleIdentity}`],
      startedAtMs,
      outDev: out.dev,
      outIno: out.ino,
      errDev: err.dev,
      errIno: err.ino,
    })

    runner.recoverAll()

    expect(spawned).toBe(false)
    expect(signals).toEqual([])
    expect(ledger.getRun(run.id)?.status).toBe('interrupted')
    expect(ledger.getRun(run.id)?.error).toContain('PID identity no longer belongs to this run')
  })

  it('fails closed when an exact run stream path was preclaimed as a hard link', () => {
    let spawned = false
    const { ledger, runner, workspaceDir } = setup({
      spawnChild: () => {
        spawned = true
        throw new Error('must not spawn')
      },
    })
    const models = resolveModels(input(workspaceDir), input(workspaceDir), input(workspaceDir))
    const loop = ledger.createLoop({ prompt: 'recover', workspaceDir, maxRounds: 2, budgetUsd: null, models })
    const run = ledger.createRun({ loopId: loop.id, round: 0, role: 'reference', harness: 'codex', prompt: 'research' })
    const target = path.join(workspaceDir, 'operator-file.txt')
    fs.writeFileSync(target, 'keep me')
    const outPath = processStreamPaths(workspaceDir, run.id).outPath
    fs.mkdirSync(path.dirname(outPath), { recursive: true })
    fs.linkSync(target, outPath)

    runner.recoverAll()

    expect(spawned).toBe(false)
    expect(fs.readFileSync(target, 'utf8')).toBe('keep me')
    expect(ledger.getRun(run.id)?.status).toBe('failed')
    expect(ledger.getLoop(loop.id)?.status).toBe('failed')
  })

  it('keeps finalization owned and advances exactly once across a failed phase retry', async () => {
    let spawns = 0
    const { ledger, runner, workspaceDir } = setup({
      wait: async () => {},
      spawnChild: () => {
        spawns += 1
        const child = new EventEmitter() as ChildProcess
        Object.assign(child, { pid: process.pid, unref: () => child })
        queueMicrotask(() => child.emit('exit', 1))
        return child
      },
    })

    const started = runner.start(input(workspaceDir))
    await waitFor(() => ledger.getLoop(started.loopId!)?.status === 'failed')

    const attempts = ledger.runsForLoop(started.loopId!)
    expect(spawns, JSON.stringify(ledger.eventsForLoop(started.loopId!, 2_000))).toBe(2)
    expect(attempts).toHaveLength(2)
    expect(attempts.every((attempt) => attempt.status === 'failed')).toBe(true)
    expect(runner.activeRun()).toBeNull()
    expect(attempts.every((attempt) => fs.existsSync(processMetaPath(workspaceDir, attempt.id)))).toBe(true)
  })

  it('turns a rate-limit event into a durable bounded pause without consuming a failure attempt', async () => {
    const { ledger, runner, workspaceDir } = setup({
      wait: async () => {},
      spawnChild: (_command, _args, options) => {
        fs.writeSync(
          options.stdio[1],
          `${JSON.stringify({ type: 'turn.failed', error: { message: 'usage limit reached; retry after 90 seconds' } })}\n`,
        )
        const child = new EventEmitter() as ChildProcess
        Object.assign(child, { pid: process.pid, unref: () => child })
        queueMicrotask(() => child.emit('exit', 1))
        return child
      },
    })

    const started = runner.start(input(workspaceDir))
    await waitFor(() => ledger.runsForLoop(started.loopId!).some((run) => run.status === 'interrupted'))

    const attempts = ledger.runsForLoop(started.loopId!)
    expect(attempts.map((attempt) => attempt.status)).toEqual(['interrupted', 'queued'])
    expect(attempts.filter((attempt) => attempt.status === 'failed')).toHaveLength(0)
    expect(attempts[0].error).toContain('retry scheduled for')
    expect(ledger.eventsForRun(attempts[0].id).some((event) => event.text.includes('backoff 90s'))).toBe(true)
    runner.stop(started.loopId!)
  })

  it('stops for manual resume without failing after the durable rate-pause ceiling', async () => {
    const { ledger, runner, workspaceDir } = setup({
      wait: async () => {},
      spawnChild: (_command, _args, options) => {
        fs.writeSync(
          options.stdio[1],
          `${JSON.stringify({ type: 'turn.failed', error: { message: 'usage limit reached; retry after 90 seconds' } })}\n`,
        )
        const child = new EventEmitter() as ChildProcess
        Object.assign(child, { pid: process.pid, unref: () => child })
        queueMicrotask(() => child.emit('exit', 1))
        return child
      },
    })
    const models = resolveModels(input(workspaceDir), input(workspaceDir), input(workspaceDir))
    const loop = ledger.createLoop({ prompt: 'rate capped', workspaceDir, maxRounds: 2, budgetUsd: null, models })
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const prior = ledger.createRun({ loopId: loop.id, round: 0, role: 'reference', harness: 'codex', prompt: 'research' })
      ledger.patchRun(prior.id, {
        status: 'interrupted',
        error: `Rate limited; retry scheduled for 2020-01-01T12:0${attempt}:00.000Z.`,
      })
    }
    const active = ledger.createRun({ loopId: loop.id, round: 0, role: 'reference', harness: 'codex', prompt: 'research' })

    runner.recoverAll()
    await waitFor(() => ledger.getLoop(loop.id)?.status === 'stopped')

    expect(ledger.getRun(active.id)?.status).toBe('interrupted')
    expect(ledger.getLoop(loop.id)?.stopReason).toContain('Resume later')
    expect(ledger.runsForLoop(loop.id).filter((run) => run.status === 'queued')).toHaveLength(0)
    expect(ledger.eventsForRun(active.id, 'metric')).toHaveLength(1)
  })

  it('bounds lifetime Claude implement message identities and keeps the omission visible', async () => {
    let ledgerRef: Ledger
    const { ledger, runner, workspaceDir } = setup({
      wait: async () => {},
      spawnChild: (_command, _args, options) => {
        const lines = Array.from({ length: 8_194 }, (_, index) => JSON.stringify({
          type: 'assistant',
          message: { id: `message-${index}`, model: 'claude-fable-5', usage: { input_tokens: 1, output_tokens: 1 }, content: [] },
        }))
        lines.push(JSON.stringify({ type: 'result', is_error: true, result: 'synthetic stop' }))
        fs.writeSync(options.stdio[1], `${lines.join('\n')}\n`)
        const child = new EventEmitter() as ChildProcess
        Object.assign(child, { pid: process.pid, unref: () => child })
        queueMicrotask(() => child.emit('exit', 1))
        return child
      },
    })
    ledgerRef = ledger
    const models = resolveModels({ ...input(workspaceDir), orchestratorModel: 'claude-fable-5' }, input(workspaceDir), input(workspaceDir))
    const loop = ledger.createLoop({ prompt: 'bounded implement', workspaceDir, maxRounds: 2, budgetUsd: null, models })
    writeReadyReferencePack(workspaceDir, loop.id)
    const reference = ledger.createRun({ loopId: loop.id, round: 0, role: 'reference', harness: 'claude', prompt: 'reference' })
    ledger.patchRun(reference.id, { status: 'succeeded' })
    ledger.appendEvent({
      loopId: loop.id,
      runId: reference.id,
      ts: new Date().toISOString(),
      kind: 'artifact',
      channel: 'system',
      text: `Reference Pack frozen at sha256:${referencePackFingerprint(workspaceDir, `reference/${loop.id}`)}`,
    })
    const implement = ledger.createRun({ loopId: loop.id, round: 1, role: 'implement', harness: 'claude', prompt: 'implement' })

    runner.recoverAll()
    await waitFor(() => ledgerRef.getLoop(loop.id)?.status === 'failed')

    expect(ledger.getRun(implement.id)?.status).toBe('failed')
    expect(
      ledger.eventsForRun(implement.id).filter((event) => event.text.includes('bounded message/task identity limit')),
      JSON.stringify(ledger.eventsForLoop(loop.id, 2_000)),
    ).toHaveLength(1)
  })

  it('bounds an unterminated stream line and makes the truncation visible', async () => {
    const { ledger, runner, workspaceDir } = setup({
      wait: async () => {},
      spawnChild: (_command, _args, options) => {
        fs.writeSync(options.stdio[1], 'x'.repeat(300_000))
        const child = new EventEmitter() as ChildProcess
        Object.assign(child, { pid: process.pid, unref: () => child })
        queueMicrotask(() => child.emit('exit', 1))
        return child
      },
    })

    const started = runner.start(input(workspaceDir))
    await waitFor(() => ledger.getLoop(started.loopId!)?.status === 'failed')

    expect(ledger.eventsForLoop(started.loopId!, 2_000).some((event) => event.text.includes('line longer than'))).toBe(true)
    expect(runner.activeRun()).toBeNull()
  })

  it('fails supervision if a launched stream path is replaced by a hard link', async () => {
    let ledgerRef: Ledger
    const { ledger, runner, workspaceDir } = setup({
      wait: async () => {},
      spawnChild: () => {
        const run = ledgerRef.runsForLoop(ledgerRef.latestLoop()!.id).find((candidate) => candidate.status === 'running')!
        const outPath = processStreamPaths(workspaceDir, run.id).outPath
        const unrelated = path.join(workspaceDir, 'unrelated-stream-source.txt')
        fs.writeFileSync(unrelated, 'must never be parsed\n')
        fs.unlinkSync(outPath)
        fs.linkSync(unrelated, outPath)
        const child = new EventEmitter() as ChildProcess
        Object.assign(child, { pid: process.pid, unref: () => child })
        queueMicrotask(() => child.emit('exit', 0))
        return child
      },
    })
    ledgerRef = ledger

    const started = runner.start(input(workspaceDir))
    await waitFor(() => ledger.getLoop(started.loopId!)?.status === 'failed')

    const run = ledger.runsForLoop(started.loopId!)[0]
    expect(run.status).toBe('failed')
    expect(run.summary).toBeNull()
    expect(ledger.eventsForRun(run.id).some((event) => event.text.includes('changed identity'))).toBe(true)
  })

  it('interrupts captured descendants when supervision fails after the leader exited', async () => {
    const deadPid = 1_999_999_997
    const identity = readProcessIdentity(process.pid)!
    const leader = `${deadPid}:${identity}`
    const descendant = `${deadPid - 1}:${identity}`
    const polls: Array<() => void> = []
    const deferred: Array<() => void> = []
    const signals: Array<0 | NodeJS.Signals> = []
    let ledgerRef: Ledger
    const { ledger, runner, workspaceDir } = setup({
      spawnChild: () => {
        const run = ledgerRef.runsForLoop(ledgerRef.latestLoop()!.id).find((candidate) => candidate.status === 'running')!
        const outPath = processStreamPaths(workspaceDir, run.id).outPath
        const unrelated = path.join(workspaceDir, 'post-leader-injected-stream.txt')
        fs.writeFileSync(unrelated, 'must never be parsed\n')
        fs.unlinkSync(outPath)
        fs.linkSync(unrelated, outPath)
        const child = new EventEmitter() as ChildProcess
        Object.assign(child, { pid: deadPid, unref: () => child })
        return child
      },
      completeProcessMeta: (workspace, runId, marker, pid, streams, groupIdentities) => completeProcessMeta(
        workspace,
        runId,
        marker,
        pid,
        () => ({ identity, groupId: pid, startedAtMs: marker.startedAtMs }),
        streams,
        groupIdentities,
      ),
      processGroupIdentity: () => [leader, descendant],
      processGroupStillOwned: (_pid, captured) => captured.includes(descendant),
      signalProcess: (_pid, signal) => { signals.push(signal) },
      repeat: (work) => {
        polls.push(work)
        return { unref: () => undefined } as unknown as NodeJS.Timeout
      },
      cancelRepeat: () => {},
      defer: (work) => {
        deferred.push(work)
        return { unref: () => undefined } as unknown as NodeJS.Timeout
      },
    })
    ledgerRef = ledger

    const started = runner.start(input(workspaceDir))
    const run = ledger.runsForLoop(started.loopId!)[0]
    polls[0]()
    await waitFor(() => ledger.getLoop(started.loopId!)?.status === 'failed')

    expect(signals).toEqual([0, 'SIGINT'])
    expect(ledger.runProcessOwnership(run.id)?.groupIdentities).toEqual([leader, descendant])
    expect(ledger.eventsForRun(run.id).some((event) => event.text.includes('changed identity'))).toBe(true)
    expect(deferred).toHaveLength(1)
  })

  it('revalidates the workspace before finalization and performs no writes through a replaced root', async () => {
    const polls: Array<() => void> = []
    const child = new EventEmitter() as ChildProcess
    Object.assign(child, { pid: process.pid, unref: () => child })
    let workspacePath = ''
    let protectedHome = ''
    let swapped = false
    const { ledger, runner, workspaceDir, deps } = setup({
      spawnChild: () => child,
      repeat: (work) => {
        polls.push(work)
        return { unref: () => undefined } as unknown as NodeJS.Timeout
      },
      cancelRepeat: () => {},
      wait: async (ms) => {
        if (ms !== 300 || swapped) return
        swapped = true
        fs.renameSync(workspacePath, `${workspacePath}.moved`)
        fs.symlinkSync(protectedHome, workspacePath, 'dir')
      },
    })
    workspacePath = workspaceDir
    protectedHome = deps.harnessHome!('codex')

    const started = runner.start(input(workspaceDir))
    child.emit('exit', 0)
    polls[0]()
    await waitFor(() => ledger.getLoop(started.loopId!)?.status === 'stopped' && runner.activeRun() === null)

    const run = ledger.runsForLoop(started.loopId!)[0]
    expect(run.status).toBe('interrupted')
    expect(run.error).toContain('Workspace safety check failed')
    expect(ledger.runsForLoop(started.loopId!)).toHaveLength(1)
    expect(fs.existsSync(path.join(protectedHome, '.gauntlet-gamesmith'))).toBe(false)
  })

  it('rejects a Reference Pack when research changed playable source', async () => {
    let ledgerRef: Ledger
    let spawns = 0
    const { ledger, runner, workspaceDir } = setup({
      wait: async () => {},
      spawnChild: () => {
        spawns += 1
        writeReadyReferencePack(workspaceDir, ledgerRef.latestLoop()!.id)
        fs.writeFileSync(path.join(workspaceDir, 'forged-source.txt'), 'research must not edit source')
        const child = new EventEmitter() as ChildProcess
        Object.assign(child, { pid: process.pid, unref: () => child })
        queueMicrotask(() => child.emit('exit', 0))
        return child
      },
    })
    ledgerRef = ledger

    const started = runner.start(input(workspaceDir))
    await waitFor(() => ledger.getLoop(started.loopId!)?.status === 'failed')

    expect(spawns).toBe(1)
    const run = ledger.runsForLoop(started.loopId!)[0]
    expect(run.role).toBe('reference')
    expect(run.status).toBe('failed')
    expect(run.revision).toMatch(/^[0-9a-f]{40,64}$/)
    expect(ledger.eventsForRun(run.id).some((event) => event.text.includes('Reference source boundary rejected'))).toBe(true)
  })

  it('rejects an implement attempt that writes into prior critique evidence', async () => {
    let ledgerRef: Ledger
    let spawns = 0
    const { ledger, runner, workspaceDir } = setup({
      wait: async () => {},
      spawnChild: () => {
        spawns += 1
        const loop = ledgerRef.latestLoop()!
        if (spawns === 1) {
          writeReadyReferencePack(workspaceDir, loop.id)
        } else {
          const critiqueDir = path.join(workspaceDir, 'critique')
          fs.mkdirSync(critiqueDir, { recursive: true })
          fs.writeFileSync(path.join(critiqueDir, 'forged-evidence.txt'), 'implementer must not author critic evidence')
        }
        const child = new EventEmitter() as ChildProcess
        Object.assign(child, { pid: process.pid, unref: () => child })
        queueMicrotask(() => child.emit('exit', 0))
        return child
      },
    })
    ledgerRef = ledger

    const started = runner.start(input(workspaceDir))
    await waitFor(() => ledger.getLoop(started.loopId!)?.status === 'failed')

    expect(spawns).toBe(2)
    const implement = ledger.runsForLoop(started.loopId!).find((run) => run.role === 'implement')!
    expect(implement.status).toBe('failed')
    expect(ledger.eventsForRun(implement.id).some((event) => event.text.includes('Critique evidence boundary rejected'))).toBe(true)
    expect(ledger.runsForLoop(started.loopId!).some((run) => run.role === 'critique')).toBe(false)
  })

  it('rejects a critic verdict when the critic mutates the frozen Reference Pack', async () => {
    let ledgerRef: Ledger
    let spawns = 0
    const { ledger, runner, workspaceDir } = setup({
      wait: async () => {},
      spawnChild: () => {
        spawns += 1
        const loop = ledgerRef.latestLoop()!
        if (spawns === 1) {
          writeReadyReferencePack(workspaceDir, loop.id)
        } else if (spawns === 2) {
          fs.writeFileSync(path.join(workspaceDir, 'game.txt'), 'playable source')
        } else {
          const critique = ledgerRef.runsForLoop(loop.id).find((run) => run.role === 'critique' && run.status === 'running')!
          const evidenceDir = path.join(workspaceDir, 'critique', `round-${critique.round}`)
          fs.mkdirSync(evidenceDir, { recursive: true })
          fs.writeFileSync(
            path.join(workspaceDir, verdictArtifactRelativePath(critique.round, critique.id)),
            JSON.stringify({ revision: critique.revision, score: 0.95, pass: true, summary: 'Looks done.', findings: [] }),
          )
          fs.appendFileSync(path.join(workspaceDir, 'reference', loop.id, 'README.md'), '\ncritic contamination')
        }
        const child = new EventEmitter() as ChildProcess
        Object.assign(child, { pid: process.pid, unref: () => child })
        queueMicrotask(() => child.emit('exit', 0))
        return child
      },
    })
    ledgerRef = ledger

    const started = runner.start(input(workspaceDir))
    await waitFor(() => ledger.getLoop(started.loopId!)?.status === 'failed')

    expect(spawns).toBe(3)
    expect(ledger.getLoop(started.loopId!)?.status).toBe('failed')
    const critique = ledger.runsForLoop(started.loopId!).find((run) => run.role === 'critique')!
    expect(critique.status).toBe('failed')
    expect(critique.verdict).toBeNull()
    expect(ledger.eventsForRun(critique.id).some((event) => event.text.includes('Reference Pack changed'))).toBe(true)
  })

  it('stops a paused queued loop without inventing a running child', () => {
    const { ledger, runner, workspaceDir } = setup()
    const models = resolveModels(input(workspaceDir), input(workspaceDir), input(workspaceDir))
    const loop = ledger.createLoop({ prompt: 'pause', workspaceDir, maxRounds: 2, budgetUsd: null, models })
    const run = ledger.createRun({ loopId: loop.id, round: 1, role: 'implement', harness: 'codex', prompt: 'go' })

    runner.stop(loop.id)

    expect(ledger.getLoop(loop.id)?.status).toBe('stopped')
    expect(ledger.getRun(run.id)?.status).toBe('queued')
    expect(runner.activeRun()).toBeNull()
  })

  it('keeps imported history read-only when Resume is requested', () => {
    let spawned = false
    const { ledger, runner, workspaceDir } = setup({
      spawnChild: () => {
        spawned = true
        throw new Error('must not spawn imported history')
      },
    })
    const models = resolveModels(input(workspaceDir), input(workspaceDir), input(workspaceDir))
    const loop = ledger.createLoop({ prompt: 'imported', workspaceDir, maxRounds: 2, budgetUsd: null, models })
    ledger.patchLoop(loop.id, { status: 'stopped', playTrusted: false })
    ledger.createRun({ loopId: loop.id, round: 1, role: 'implement', harness: 'codex', prompt: 'untrusted work' })

    expect(runner.resumeLoop(loop.id)).toEqual({
      ok: false,
      error: 'Untrusted history (imported or created before trust provenance shipped) is read-only; start a new trusted run in this workspace.',
    })
    expect(spawned).toBe(false)
    expect(ledger.getLoop(loop.id)?.status).toBe('stopped')
  })

  it('refuses Resume before changing history when the selected profile is no longer subscription-ready', () => {
    let spawned = false
    const { ledger, runner, workspaceDir } = setup({
      subscriptionReady: () => ({ ok: false, error: 'API-key authentication is active.' }),
      spawnChild: () => {
        spawned = true
        throw new Error('must not spawn without subscription readiness')
      },
    })
    const models = resolveModels(input(workspaceDir), input(workspaceDir), input(workspaceDir))
    const loop = ledger.createLoop({ prompt: 'resume safely', workspaceDir, maxRounds: 2, budgetUsd: null, models })
    const queued = ledger.createRun({ loopId: loop.id, round: 0, role: 'reference', harness: 'codex', prompt: 'research' })
    ledger.patchLoop(loop.id, { status: 'stopped' })

    expect(runner.resumeLoop(loop.id)).toEqual({
      ok: false,
      error: 'Subscription readiness blocked codex: API-key authentication is active.',
    })
    expect(spawned).toBe(false)
    expect(ledger.getLoop(loop.id)?.status).toBe('stopped')
    expect(ledger.getRun(queued.id)?.status).toBe('queued')
    expect(ledger.eventsForLoop(loop.id)).toEqual([])
  })

  it('stops boot recovery before launching queued work when subscription readiness changed', () => {
    let spawned = false
    const { ledger, runner, workspaceDir } = setup({
      subscriptionReady: () => ({ ok: false, error: 'This profile is signed out.' }),
      spawnChild: () => {
        spawned = true
        throw new Error('must not spawn after a failed recovery probe')
      },
    })
    const models = resolveModels(input(workspaceDir), input(workspaceDir), input(workspaceDir))
    const loop = ledger.createLoop({ prompt: 'recover safely', workspaceDir, maxRounds: 2, budgetUsd: null, models })
    const queued = ledger.createRun({ loopId: loop.id, round: 0, role: 'reference', harness: 'codex', prompt: 'research' })

    runner.recoverAll()

    expect(spawned).toBe(false)
    expect(ledger.runsForLoop(loop.id)).toHaveLength(1)
    expect(ledger.getRun(queued.id)).toMatchObject({
      status: 'interrupted',
      error: expect.stringContaining('Subscription readiness blocked codex'),
    })
    expect(ledger.getLoop(loop.id)).toMatchObject({
      status: 'stopped',
      stopReason: expect.stringContaining('This profile is signed out'),
    })
    expect(ledger.eventsForRun(queued.id).filter((event) => event.kind === 'error')).toHaveLength(1)
  })

  it('interrupts a captured descendant when recovery finds switched authentication after leader exit', () => {
    const deadPid = 1_999_999_995
    const identity = readProcessIdentity(process.pid)!
    const leader = `${deadPid}:${identity}`
    const descendant = `${deadPid - 1}:${identity}`
    const signals: Array<0 | NodeJS.Signals> = []
    const deferred: Array<() => void> = []
    const { ledger, runner, workspaceDir } = setup({
      subscriptionReady: () => ({ ok: false, error: 'API-key authentication replaced the subscription profile.' }),
      processGroupIdentity: () => [descendant],
      processGroupStillOwned: (_pid, captured) => captured.includes(descendant),
      signalProcess: (_pid, signal) => { signals.push(signal) },
      defer: (work) => {
        deferred.push(work)
        return { unref: () => undefined } as unknown as NodeJS.Timeout
      },
    })
    const models = resolveModels(input(workspaceDir), input(workspaceDir), input(workspaceDir))
    const loop = ledger.createLoop({ prompt: 'recover switched auth', workspaceDir, maxRounds: 2, budgetUsd: null, models })
    const run = ledger.createRun({ loopId: loop.id, round: 0, role: 'reference', harness: 'codex', prompt: 'research' })
    const startedAtMs = Date.now()
    ledger.patchRun(run.id, { status: 'running', startedAt: new Date(startedAtMs).toISOString() })
    const marker = prepareProcessMeta(workspaceDir, run.id, startedAtMs, workspaceIdentity(workspaceDir))
    fs.writeFileSync(marker.outPath, '')
    fs.writeFileSync(marker.errPath, '')
    const meta = completeProcessMeta(
      workspaceDir,
      run.id,
      marker,
      deadPid,
      () => ({ identity, groupId: deadPid, startedAtMs }),
      undefined,
      [leader, descendant],
    )
    ledger.setRunProcessOwnership(run.id, {
      pid: deadPid,
      processIdentity: identity,
      groupIdentities: [leader, descendant],
      startedAtMs,
      outDev: meta.outDev,
      outIno: meta.outIno,
      errDev: meta.errDev,
      errIno: meta.errIno,
    })

    runner.recoverAll()

    expect(signals).toEqual([0, 'SIGINT'])
    expect(ledger.getRun(run.id)).toMatchObject({
      status: 'interrupted',
      error: expect.stringContaining('Subscription readiness blocked codex'),
    })
    expect(ledger.getLoop(loop.id)?.status).toBe('stopped')
    expect(ledger.runProcessOwnership(run.id)?.groupIdentities).toEqual([leader, descendant])
    expect(deferred).toHaveLength(1)
  })

  it('quarantines one invalid recovery surface and continues processing later loops', () => {
    const signals: Array<0 | NodeJS.Signals> = []
    const deferred: Array<() => void> = []
    const { ledger, runner, workspaceDir } = setup({
      signalProcess: (_pid, signal) => { signals.push(signal) },
      processGroupStillOwned: () => true,
      defer: (work) => {
        deferred.push(work)
        return { unref: () => undefined } as unknown as NodeJS.Timeout
      },
    })
    const models = resolveModels(input(workspaceDir), input(workspaceDir), input(workspaceDir))

    const laterWorkspace = path.join(path.dirname(workspaceDir), 'later-workspace')
    fs.mkdirSync(laterWorkspace)
    const later = ledger.createLoop({ prompt: 'continue recovery scan', workspaceDir: laterWorkspace, maxRounds: 2, budgetUsd: null, models })
    ledger.createRun({ loopId: later.id, round: 0, role: 'reference', harness: 'codex', prompt: 'research' })
    ledger.patchLoop(later.id, { playTrusted: false })

    const broken = ledger.createLoop({ prompt: 'broken child surface', workspaceDir, maxRounds: 2, budgetUsd: null, models })
    const run = ledger.createRun({ loopId: broken.id, round: 0, role: 'reference', harness: 'codex', prompt: 'research' })
    const startedAtMs = Date.now()
    ledger.patchRun(run.id, { status: 'running', startedAt: new Date(startedAtMs).toISOString() })
    const marker = prepareProcessMeta(workspaceDir, run.id, startedAtMs, workspaceIdentity(workspaceDir))
    fs.writeFileSync(marker.outPath, '')
    fs.writeFileSync(marker.errPath, '')
    const identity = readProcessIdentity(process.pid)!
    const leader = `${process.pid}:${identity}`
    const meta = completeProcessMeta(
      workspaceDir,
      run.id,
      marker,
      process.pid,
      () => ({ identity, groupId: process.pid, startedAtMs }),
      undefined,
      [leader],
    )
    ledger.setRunProcessOwnership(run.id, {
      pid: meta.pid,
      processIdentity: meta.processIdentity,
      groupIdentities: [leader],
      startedAtMs,
      outDev: meta.outDev,
      outIno: meta.outIno,
      errDev: meta.errDev,
      errIno: meta.errIno,
    })
    const outsideAgents = path.join(path.dirname(workspaceDir), 'outside-agents')
    fs.mkdirSync(outsideAgents)
    fs.symlinkSync(outsideAgents, path.join(workspaceDir, '.gauntlet-gamesmith', 'agents'), 'dir')

    runner.recoverAll()

    expect(signals).toEqual([0, 'SIGINT'])
    expect(ledger.getRun(run.id)).toMatchObject({ status: 'interrupted', error: expect.stringContaining('Recovery setup failed safely') })
    expect(ledger.runProcessOwnership(run.id)).not.toBeNull()
    expect(ledger.getLoop(later.id)).toMatchObject({
      status: 'stopped',
      stopReason: expect.stringContaining('Untrusted history'),
    })
    expect(deferred).toHaveLength(1)
  })

  it('rechecks subscription readiness at the final spawn seam', async () => {
    let probes = 0
    let spawned = false
    const { ledger, runner, workspaceDir } = setup({
      subscriptionReady: () => {
        probes += 1
        return probes === 1
          ? { ok: true, error: null }
          : { ok: false, error: 'Authentication changed before launch.' }
      },
      spawnChild: () => {
        spawned = true
        throw new Error('must not spawn after the last-mile probe fails')
      },
    })

    const started = runner.start(input(workspaceDir))
    await waitFor(() => ledger.getLoop(started.loopId!)?.status === 'stopped')

    const run = ledger.runsForLoop(started.loopId!)[0]
    expect(probes).toBe(2)
    expect(spawned).toBe(false)
    expect(run.status).toBe('interrupted')
    expect(run.error).toContain('Authentication changed before launch')
    expect(ledger.eventsForRun(run.id).filter((event) => event.text.includes('Subscription readiness blocked'))).toHaveLength(1)
  })

  it('terminalizes a queued attempt when an execution-admission probe throws', async () => {
    const { ledger, runner, workspaceDir } = setup({
      subscriptionReady: () => { throw new Error('pinned executable identity changed') },
      spawnChild: () => { throw new Error('must not spawn after an admission exception') },
    })

    const started = runner.start(input(workspaceDir))
    await waitFor(() => ledger.getLoop(started.loopId!)?.status === 'failed')

    expect(ledger.runsForLoop(started.loopId!)[0]).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('pinned executable identity changed'),
    })
    expect(ledger.eventsForLoop(started.loopId!, 100).some((event) => event.kind === 'done')).toBe(true)
  })

  it('preflights a cross-harness research worker before launching the primary harness', async () => {
    const probed: string[] = []
    let spawned = false
    const { ledger, runner, workspaceDir } = setup({
      subscriptionReady: (kind) => {
        probed.push(kind)
        return kind === 'codex'
          ? { ok: true, error: null }
          : { ok: false, error: 'Claude switched to API-key authentication.' }
      },
      spawnChild: () => {
        spawned = true
        throw new Error('must not launch a primary that can delegate to an unready worker')
      },
    })
    const configured = input(workspaceDir)
    configured.researchModel = 'claude-fable-5'

    const started = runner.start(configured)
    await waitFor(() => ledger.getLoop(started.loopId!)?.status === 'stopped')

    const run = ledger.runsForLoop(started.loopId!)[0]
    expect(probed).toEqual(['codex', 'claude'])
    expect(spawned).toBe(false)
    expect(run.status).toBe('interrupted')
    expect(run.error).toContain('Subscription readiness blocked claude')
  })

  it('spawns only pinned absolute primary and delegated CLI executables', async () => {
    let command = ''
    let env: Record<string, string> = {}
    const resolved: string[] = []
    const { ledger, runner, workspaceDir } = setup({
      cliExecutable: (kind, unsafeRoots) => {
        expect(unsafeRoots).toContain(fs.realpathSync(workspaceDir))
        resolved.push(kind)
        return `/trusted/bin/${kind}`
      },
      spawnChild: (nextCommand, _args, options) => {
        command = nextCommand
        env = options.env
        throw new Error('stop after executable inspection')
      },
    })
    const configured = input(workspaceDir)
    configured.researchModel = 'claude-fable-5'

    expect(runner.start(configured).ok).toBe(true)
    await waitFor(() => command.length > 0 || ledger.latestLoop()?.status === 'failed')

    expect(resolved, JSON.stringify(ledger.eventsForLoop(ledger.latestLoop()!.id))).toEqual(['codex', 'claude'])
    expect(command).toBe('/trusted/bin/codex')
    expect(env.GAUNTLET_CODEX_BIN).toBe('/trusted/bin/codex')
    expect(env.GAUNTLET_CLAUDE_BIN).toBe('/trusted/bin/claude')
  })

  it('resumes only the same-round session with the complete effective prompt', () => {
    let spawnedArgs: string[] | null = null
    const { ledger, runner, workspaceDir } = setup({
      spawnChild: (_command, args) => {
        spawnedArgs = args
        throw new Error('stop after inspecting resume launch')
      },
    })
    const models = resolveModels(input(workspaceDir), input(workspaceDir), input(workspaceDir))
    const loop = ledger.createLoop({ prompt: 'Build the game.', workspaceDir, maxRounds: 2, budgetUsd: null, models })
    const referenceRoot = writeReadyReferencePack(workspaceDir, loop.id)
    const reference = ledger.createRun({ loopId: loop.id, round: 0, role: 'reference', harness: 'codex', prompt: 'research' })
    ledger.patchRun(reference.id, { status: 'succeeded', finishedAt: new Date().toISOString() })
    ledger.appendEvent({
      loopId: loop.id,
      runId: reference.id,
      ts: new Date().toISOString(),
      kind: 'artifact',
      channel: 'system',
      text: `Reference Pack frozen at sha256:${referencePackFingerprint(workspaceDir, path.relative(workspaceDir, referenceRoot))}`,
    })
    const basePrompt = composeImplementPrompt('Build the game.', 1, null, 'Work independently and verify the result.', `reference/${loop.id}`)
    const interrupted = ledger.createRun({ loopId: loop.id, round: 1, role: 'implement', harness: 'codex', prompt: basePrompt })
    ledger.patchRun(interrupted.id, { status: 'cancelled', sessionId: 'same-round-thread', finishedAt: new Date().toISOString() })
    ledger.patchLoop(loop.id, { status: 'stopped', round: 1 })

    expect(runner.resumeLoop(loop.id)).toEqual({ ok: true, loopId: loop.id })

    expect(spawnedArgs, JSON.stringify(ledger.eventsForLoop(loop.id, 2_000))).not.toBeNull()
    expect(spawnedArgs).toContain('same-round-thread')
    expect(spawnedArgs!.at(-1)).toBe(composeResumePrompt(basePrompt))
    expect(spawnedArgs!.at(-1)).toContain('<goal>\nBuild the game.\n</goal>')
  })

  it('leaves the released unmarked implementer agent untouched and writes a versioned owned agent', () => {
    const { ledger, runner, workspaceDir } = setup({
      spawnChild: () => { throw new Error('stop after agent definition write') },
    })
    const configured = input(workspaceDir)
    configured.orchestratorModel = 'claude-fable-5'
    configured.subagentModel = 'claude-opus-5'
    const models = resolveModels(configured, configured, configured)
    const loop = ledger.createLoop({ prompt: 'Build the game.', workspaceDir, maxRounds: 2, budgetUsd: null, models })
    const referenceRoot = writeReadyReferencePack(workspaceDir, loop.id)
    const reference = ledger.createRun({ loopId: loop.id, round: 0, role: 'reference', harness: 'claude', prompt: 'research' })
    ledger.patchRun(reference.id, { status: 'succeeded', finishedAt: new Date().toISOString() })
    ledger.appendEvent({
      loopId: loop.id,
      runId: reference.id,
      ts: new Date().toISOString(),
      kind: 'artifact',
      channel: 'system',
      text: `Reference Pack frozen at sha256:${referencePackFingerprint(workspaceDir, path.relative(workspaceDir, referenceRoot))}`,
    })
    ledger.createRun({ loopId: loop.id, round: 1, role: 'implement', harness: 'claude', prompt: 'implement' })
    ledger.patchLoop(loop.id, { status: 'stopped', round: 1 })
    const agentDir = path.join(workspaceDir, '.claude', 'agents')
    fs.mkdirSync(agentDir, { recursive: true })
    fs.writeFileSync(path.join(agentDir, 'implementer.md'), 'legacy user-owned agent')

    expect(runner.resumeLoop(loop.id).ok).toBe(true)

    expect(fs.readFileSync(path.join(agentDir, 'implementer.md'), 'utf8')).toBe('legacy user-owned agent')
    const definition = implementerAgentDefinition(models, path.relative(workspaceDir, referenceRoot))!
    expect(fs.readFileSync(path.join(agentDir, definition.filename), 'utf8')).toContain(`name: ${definition.agentName}`)
  })

  it('does not recover queued work from an untrusted imported loop', () => {
    let spawned = false
    const { ledger, runner, workspaceDir } = setup({
      spawnChild: () => {
        spawned = true
        throw new Error('must not spawn imported history')
      },
    })
    const models = resolveModels(input(workspaceDir), input(workspaceDir), input(workspaceDir))
    const loop = ledger.createLoop({ prompt: 'imported', workspaceDir, maxRounds: 2, budgetUsd: null, models })
    ledger.patchLoop(loop.id, { playTrusted: false })
    ledger.createRun({ loopId: loop.id, round: 0, role: 'reference', harness: 'codex', prompt: 'untrusted work' })

    runner.recoverAll()

    expect(spawned).toBe(false)
    expect(ledger.getLoop(loop.id)?.status).toBe('stopped')
    expect(ledger.getLoop(loop.id)?.stopReason).toContain('Untrusted history (imported or created before trust provenance shipped) is read-only')
  })

  it('quarantines a pre-boundary protected workspace before resume or recovery', () => {
    let protectedRoots: string[] = []
    let spawned = false
    const { ledger, runner, workspaceDir } = setup({
      protectedRoots: () => protectedRoots,
      spawnChild: () => {
        spawned = true
        throw new Error('must not spawn in protected data')
      },
    })
    const models = resolveModels(input(workspaceDir), input(workspaceDir), input(workspaceDir))
    const resumed = ledger.createLoop({ prompt: 'legacy resume', workspaceDir, maxRounds: 2, budgetUsd: null, models })
    ledger.createRun({ loopId: resumed.id, round: 0, role: 'reference', harness: 'codex', prompt: 'unsafe' })
    ledger.patchLoop(resumed.id, { status: 'stopped' })
    protectedRoots = [workspaceDir]

    expect(runner.resumeLoop(resumed.id)).toEqual({ ok: false, error: expect.stringContaining('Workspace safety check failed') })
    expect(ledger.getLoop(resumed.id)).toMatchObject({ status: 'stopped', stopReason: expect.stringContaining('Workspace safety check failed') })
    expect(ledger.runsForLoop(resumed.id)[0].status).toBe('interrupted')

    protectedRoots = []
    const recovered = ledger.createLoop({ prompt: 'legacy recovery', workspaceDir, maxRounds: 2, budgetUsd: null, models })
    ledger.createRun({ loopId: recovered.id, round: 0, role: 'reference', harness: 'codex', prompt: 'unsafe' })
    protectedRoots = [workspaceDir]
    runner.recoverAll()

    expect(spawned).toBe(false)
    expect(ledger.getLoop(recovered.id)).toMatchObject({ status: 'stopped', stopReason: expect.stringContaining('Workspace safety check failed') })
    expect(ledger.runsForLoop(recovered.id)[0].status).toBe('interrupted')
  })
})
