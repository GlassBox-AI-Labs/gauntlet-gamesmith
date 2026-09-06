import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import type { ChildProcess } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { detectLaunch, hasActivePlay, playAccessError, playEnvironment, playState, processGroupIdentitiesOverlap, startPlay, stopAllPlayAndWait, stopPlay } from './play'
import { captureWorkspaceIdentity } from './workspace-boundary'

vi.mock('electron', () => ({ shell: { openExternal: vi.fn(async () => undefined) } }))

const dirs: string[] = []

function workspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gauntlet-play-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  stopPlay('loop-1')
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('play safety', () => {
  it('does not launch through a workspace root replaced after registration', () => {
    const dir = workspace()
    const moved = `${dir}-moved`
    dirs.push(moved)
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { dev: 'vite' } }))
    const expectedWorkspace = captureWorkspaceIdentity(dir, [])
    fs.renameSync(dir, moved)
    fs.mkdirSync(dir)
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { dev: 'attacker' } }))
    const spawn = vi.fn()

    const state = startPlay('loop-1', dir, null, null, vi.fn(), { spawn: spawn as never }, {
      expectedWorkspace,
      protectedRoots: [],
    })

    expect(state).toMatchObject({ running: false, error: expect.stringContaining('workspace root changed') })
    expect(spawn).not.toHaveBeenCalled()
  })

  it('allows Play during active agent work but fails closed for untrusted history', () => {
    expect(playAccessError({ playTrusted: true, status: 'running' })).toBeNull()
    expect(playAccessError({ playTrusted: false, status: 'stopped' })).toMatch(/imported or created before trust provenance shipped/)
  })

  it('uses a bounded package file and a fixed npm argv', () => {
    const dir = workspace()
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { dev: 'attacker controlled command' } }))
    expect(detectLaunch(dir)).toEqual({ command: 'npm', args: ['run', 'dev'] })

    fs.writeFileSync(path.join(dir, 'package.json'), ' '.repeat(1024 * 1024 + 1))
    expect(detectLaunch(dir)).toEqual({ error: expect.stringContaining('Nothing launchable') })
  })

  it('never downloads Vite for a bare index.html and ignores a symlinked package file', () => {
    const dir = workspace()
    fs.writeFileSync(path.join(dir, 'index.html'), '<main>game</main>')
    expect(detectLaunch(dir)).toEqual({ error: expect.stringContaining('never downloads executables automatically') })

    const outside = path.join(path.dirname(dir), `${path.basename(dir)}-package.json`)
    fs.writeFileSync(outside, JSON.stringify({ scripts: { dev: 'vite' } }))
    fs.symlinkSync(outside, path.join(dir, 'package.json'))
    expect(detectLaunch(dir)).toEqual({ error: expect.stringContaining('never downloads executables automatically') })

    fs.unlinkSync(path.join(dir, 'package.json'))
    fs.linkSync(outside, path.join(dir, 'package.json'))
    expect(detectLaunch(dir)).toEqual({ error: expect.stringContaining('never downloads executables automatically') })
    fs.rmSync(outside, { force: true })
  })

  it('constructs an allowlisted environment with an isolated npm config', () => {
    const dir = workspace()
    const plantedBin = path.join(dir, 'bin')
    fs.mkdirSync(plantedBin)
    const env = playEnvironment(dir, {
      PATH: `.:${plantedBin}:/usr/bin`,
      HOME: '/Users/operator',
      LANG: 'en_US.UTF-8',
      AWS_SECRET_ACCESS_KEY: 'secret',
      GITHUB_TOKEN: 'secret',
      OPENAI_API_KEY: 'secret',
      NODE_OPTIONS: '--require attacker.js',
    })

    expect(env.PATH).toBe('/usr/bin')
    expect(env.LANG).toBe('en_US.UTF-8')
    expect(env).not.toHaveProperty('AWS_SECRET_ACCESS_KEY')
    expect(env).not.toHaveProperty('GITHUB_TOKEN')
    expect(env).not.toHaveProperty('OPENAI_API_KEY')
    expect(env).not.toHaveProperty('NODE_OPTIONS')
  })

  it('passes HOME through so a shimmed node version manager can find its toolchain', () => {
    const dir = workspace()
    // Redirecting HOME hid volta/asdf/mise's toolchain along with the user's
    // dotfiles: `npm` became a shim that could not find a Node and exited 126.
    const env = playEnvironment(dir, { PATH: '/usr/bin', HOME: '/Users/operator' })
    expect(env.HOME).toBe('/Users/operator')
  })

  it('keeps the user npm config and cache out of an agent-authored game script', () => {
    const dir = workspace()
    const playHome = path.join(fs.realpathSync(dir), '.gauntlet-gamesmith', 'play-home')
    const env = playEnvironment(dir, { PATH: '/usr/bin', HOME: '/Users/operator' })
    // What redirecting HOME was really protecting: registry tokens in
    // ~/.npmrc, and the user's own npm cache.
    expect(env.NPM_CONFIG_USERCONFIG).toBe(path.join(playHome, 'npmrc'))
    expect(env.NPM_CONFIG_CACHE).toBe(path.join(playHome, 'npm-cache'))
  })

  it('rejects an agent-planted symlink for the isolated Play home', () => {
    const dir = workspace()
    const outside = path.join(path.dirname(dir), `${path.basename(dir)}-outside-home`)
    fs.mkdirSync(path.join(dir, '.gauntlet-gamesmith'), { recursive: true })
    fs.mkdirSync(outside)
    fs.symlinkSync(outside, path.join(dir, '.gauntlet-gamesmith', 'play-home'))

    expect(() => playEnvironment(dir, { PATH: '/bin' })).toThrow(/play-home must be a real directory/)
    fs.rmSync(outside, { recursive: true })
  })

  it('stops the whole game process group with bounded escalation at the hard timeout and reports it', () => {
    const dir = workspace()
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { dev: 'vite' } }))
    const child = new EventEmitter() as ChildProcess
    Object.assign(child, { pid: 4242, stdout: new PassThrough(), stderr: new PassThrough() })
    const callbacks: Array<() => void> = []
    const fakeTimer = (): NodeJS.Timeout => ({ unref: () => fakeTimer() }) as unknown as NodeJS.Timeout
    const kill = vi.fn()
    const notify = vi.fn()
    const groupAlive = vi.fn()
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(true)
      .mockReturnValue(false)

    startPlay('loop-1', dir, null, null, notify, {
      spawn: (() => child) as typeof import('node:child_process').spawn,
      kill,
      groupIdentity: () => ['4242:original-start'],
      groupAlive,
      timeoutMs: 60_000,
      setTimer: ((callback: () => void) => {
        callbacks.push(callback)
        return fakeTimer()
      }) as typeof setTimeout,
      clearTimer: vi.fn(),
    })
    callbacks[0]()

    expect(kill).toHaveBeenCalledWith(-4242, 'SIGINT')
    callbacks[1]()
    expect(kill).toHaveBeenCalledWith(-4242, 'SIGKILL')
    callbacks[2]()
    expect(kill).not.toHaveBeenCalledWith(-4242, 'SIGTERM')
    expect(playEnvironment(dir)).not.toHaveProperty('GITHUB_TOKEN')
    expect(notify).toHaveBeenLastCalledWith(
      expect.objectContaining({ loopId: 'loop-1', running: false, error: expect.stringContaining('safety timeout') }),
    )
  })

  it('skips delayed process-group escalation once the original group is gone', () => {
    const dir = workspace()
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { dev: 'vite' } }))
    const child = new EventEmitter() as ChildProcess
    Object.assign(child, { pid: 4242, stdout: new PassThrough(), stderr: new PassThrough() })
    const callbacks: Array<() => void> = []
    const fakeTimer = (): NodeJS.Timeout => ({ unref: () => fakeTimer() }) as unknown as NodeJS.Timeout
    const kill = vi.fn()

    startPlay('loop-1', dir, null, null, vi.fn(), {
      spawn: (() => child) as typeof import('node:child_process').spawn,
      kill,
      groupIdentity: () => ['4242:original-start'],
      groupAlive: () => false,
      setTimer: ((callback: () => void) => {
        callbacks.push(callback)
        return fakeTimer()
      }) as typeof setTimeout,
      clearTimer: vi.fn(),
    })
    stopPlay('loop-1')
    child.emit('exit', 0)

    expect(callbacks).toHaveLength(1)
    expect(kill).not.toHaveBeenCalled()
  })

  it('keeps Play blocked when the process-group probe fails until absence is verified', () => {
    const dir = workspace()
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { dev: 'vite' } }))
    const child = new EventEmitter() as ChildProcess
    Object.assign(child, { pid: 4242, stdout: new PassThrough(), stderr: new PassThrough() })
    const callbacks: Array<() => void> = []
    let probeFails = true
    const kill = vi.fn()

    startPlay('loop-1', dir, null, null, vi.fn(), {
      spawn: (() => child) as typeof import('node:child_process').spawn,
      kill,
      groupIdentity: () => ['4242:original-start'],
      groupAlive: () => {
        if (probeFails) throw new Error('ps unavailable')
        return false
      },
      setTimer: ((callback: () => void) => {
        callbacks.push(callback)
        return { unref: vi.fn() } as unknown as NodeJS.Timeout
      }) as typeof setTimeout,
      clearTimer: vi.fn(),
    })
    stopPlay('loop-1')

    expect(playState('loop-1')).toEqual(expect.objectContaining({
      running: true,
      error: expect.stringContaining('could not be checked'),
    }))
    expect(kill).not.toHaveBeenCalled()
    probeFails = false
    callbacks[1]()
    expect(playState('loop-1').running).toBe(false)
  })

  it('keeps bounded escalation for descendants after the npm leader exits', () => {
    const dir = workspace()
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { dev: 'vite' } }))
    const child = new EventEmitter() as ChildProcess
    Object.assign(child, { pid: 4242, stdout: new PassThrough(), stderr: new PassThrough() })
    const callbacks: Array<() => void> = []
    const fakeTimer = (): NodeJS.Timeout => ({ unref: () => fakeTimer() }) as unknown as NodeJS.Timeout
    const kill = vi.fn()
    const groupAlive = vi.fn()
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(true)
      .mockReturnValue(false)

    startPlay('loop-1', dir, null, null, vi.fn(), {
      spawn: (() => child) as typeof import('node:child_process').spawn,
      kill,
      groupIdentity: () => ['4242:original-start', '4243:child-start'],
      groupAlive,
      setTimer: ((callback: () => void) => {
        callbacks.push(callback)
        return fakeTimer()
      }) as typeof setTimeout,
      clearTimer: vi.fn(),
    })
    stopPlay('loop-1')
    child.emit('exit', 0)
    callbacks[1]()
    callbacks[2]()

    expect(kill).toHaveBeenNthCalledWith(1, -4242, 'SIGINT')
    expect(kill).toHaveBeenNthCalledWith(2, -4242, 'SIGKILL')
  })

  it('keeps a background server supervised when its launcher exits normally', () => {
    const dir = workspace()
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { dev: 'vite' } }))
    const child = new EventEmitter() as ChildProcess
    Object.assign(child, { pid: 4242, stdout: new PassThrough(), stderr: new PassThrough() })
    const callbacks: Array<() => void> = []
    const fakeTimer = (): NodeJS.Timeout => ({ unref: () => fakeTimer() }) as unknown as NodeJS.Timeout
    const kill = vi.fn()
    const notify = vi.fn()
    const groupAlive = vi.fn()
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(true)
      .mockReturnValue(false)

    startPlay('loop-1', dir, null, null, notify, {
      spawn: (() => child) as typeof import('node:child_process').spawn,
      kill,
      groupIdentity: () => ['4242:launcher', '4243:server'],
      groupAlive,
      setTimer: ((callback: () => void) => {
        callbacks.push(callback)
        return fakeTimer()
      }) as typeof setTimeout,
      clearTimer: vi.fn(),
    })
    child.emit('exit', 0)

    expect(playState('loop-1')).toEqual(expect.objectContaining({ running: true, error: expect.stringContaining('background server') }))
    expect(kill).toHaveBeenCalledWith(-4242, 'SIGINT')
    callbacks[1]()
    expect(kill).toHaveBeenCalledWith(-4242, 'SIGKILL')
    callbacks[2]()
    expect(playState('loop-1').running).toBe(false)
    expect(notify).toHaveBeenLastCalledWith(expect.objectContaining({ loopId: 'loop-1', running: false }))
  })

  it('retains a late-forked server identity after the launcher exits', () => {
    const dir = workspace()
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { dev: 'vite' } }))
    const child = new EventEmitter() as ChildProcess
    Object.assign(child, { pid: 4242, stdout: new PassThrough(), stderr: new PassThrough() })
    const callbacks: Array<() => void> = []
    let refresh: (() => void) | null = null
    let groupPresent = true
    let gateFile = ''
    const kill = vi.fn()
    const groupIdentity = vi.fn()
      .mockReturnValueOnce(['4242:launcher'])
      .mockReturnValueOnce(['4242:launcher', '4243:server'])
      .mockReturnValueOnce(['4243:server'])
    const groupAlive = vi.fn((_pid: number, identities: readonly string[]) => (
      groupPresent && identities.includes('4243:server')
    ))

    startPlay('loop-1', dir, null, null, vi.fn(), {
      spawn: ((command: string, args: readonly string[]) => {
        expect(command).toBe('/bin/sh')
        expect(args[1]).toContain('exec "$@"')
        gateFile = args[3]
        expect(fs.existsSync(gateFile)).toBe(false)
        return child
      }) as typeof import('node:child_process').spawn,
      kill,
      groupIdentity,
      groupAlive,
      setInterval: ((callback: () => void) => {
        refresh = callback
        return { unref: vi.fn() } as unknown as NodeJS.Timeout
      }) as typeof setInterval,
      clearInterval: vi.fn(),
      setTimer: ((callback: () => void) => {
        callbacks.push(callback)
        return { unref: vi.fn() } as unknown as NodeJS.Timeout
      }) as typeof setTimeout,
      clearTimer: vi.fn(),
    })
    expect(fs.existsSync(gateFile)).toBe(true)
    ;(refresh as (() => void) | null)?.()
    child.emit('exit', 0)

    expect(playState('loop-1')).toEqual(expect.objectContaining({ running: true, error: expect.stringContaining('background server') }))
    expect(groupAlive.mock.calls.some((call) => call[1].includes('4243:server'))).toBe(true)
    expect(kill).toHaveBeenCalledWith(-4242, 'SIGINT')

    groupPresent = false
    callbacks[1]()
    expect(playState('loop-1').running).toBe(false)
  })

  it('blocks a replacement session until verified shutdown actually settles', () => {
    const dir = workspace()
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { dev: 'vite' } }))
    const child = new EventEmitter() as ChildProcess
    Object.assign(child, { pid: 4242, stdout: new PassThrough(), stderr: new PassThrough() })
    const callbacks: Array<() => void> = []
    const groupAlive = vi.fn()
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(true)
      .mockReturnValue(false)
    const secondSpawn = vi.fn()

    startPlay('loop-1', dir, null, null, vi.fn(), {
      spawn: (() => child) as typeof import('node:child_process').spawn,
      kill: vi.fn(),
      groupIdentity: () => ['4242:launcher', '4243:server'],
      groupAlive,
      setTimer: ((callback: () => void) => {
        callbacks.push(callback)
        return { unref: vi.fn() } as unknown as NodeJS.Timeout
      }) as typeof setTimeout,
      clearTimer: vi.fn(),
    })
    stopPlay('loop-1')
    const blocked = startPlay('loop-1', dir, null, null, vi.fn(), { spawn: secondSpawn as typeof import('node:child_process').spawn })
    expect(blocked.running).toBe(true)
    expect(secondSpawn).not.toHaveBeenCalled()

    callbacks[1]()
    callbacks[2]()
    expect(playState('loop-1')).toEqual(expect.objectContaining({ running: true, error: expect.stringContaining('survived SIGKILL') }))
    callbacks[3]()
    expect(playState('loop-1').running).toBe(false)
  })

  it('keeps only the current descendant-settlement poll timer retained', () => {
    const dir = workspace()
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { dev: 'vite' } }))
    const child = new EventEmitter() as ChildProcess
    Object.assign(child, { pid: 4242, stdout: new PassThrough(), stderr: new PassThrough() })
    const callbacks: Array<() => void> = []
    let alive = true
    const clearTimer = vi.fn()

    startPlay('loop-1', dir, null, null, vi.fn(), {
      spawn: (() => child) as typeof import('node:child_process').spawn,
      kill: vi.fn(),
      groupIdentity: () => ['4242:launcher', '4243:server'],
      groupAlive: () => alive,
      setTimer: ((callback: () => void) => {
        callbacks.push(callback)
        return { unref: vi.fn() } as unknown as NodeJS.Timeout
      }) as typeof setTimeout,
      clearTimer,
    })
    child.emit('exit', 0)
    callbacks[1]() // SIGKILL escalation
    callbacks[2]() // survivor check starts polling
    for (let index = 0; index < 50; index += 1) callbacks[3 + index]()
    alive = false
    callbacks[53]()

    expect(playState('loop-1').running).toBe(false)
    // Cleanup clears the hard timeout, not all 52 already-fired escalation
    // and polling handles.
    expect(clearTimer).toHaveBeenCalledTimes(1)
  })

  it('still stops the child and reports a replaced checkout cleanup path', () => {
    const dir = workspace()
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { dev: 'vite' } }))
    const checkout = path.join(dir, '.gauntlet-gamesmith', 'play', 'round-1-aaaaaaaaaaaa')
    const outside = workspace()
    fs.mkdirSync(checkout, { recursive: true })
    const child = new EventEmitter() as ChildProcess
    Object.assign(child, { pid: 4242, stdout: new PassThrough(), stderr: new PassThrough() })
    const kill = vi.fn()
    const notify = vi.fn()
    const callbacks: Array<() => void> = []
    const groupAlive = vi.fn()
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(true)
      .mockReturnValue(false)

    startPlay('loop-1', dir, 1, checkout, notify, {
      spawn: (() => child) as typeof import('node:child_process').spawn,
      kill,
      groupIdentity: () => ['4242:original-start'],
      groupAlive,
      setTimer: ((callback: () => void) => {
        callbacks.push(callback)
        return { unref: vi.fn() } as unknown as NodeJS.Timeout
      }) as typeof setTimeout,
      clearTimer: vi.fn(),
    })
    fs.rmSync(checkout, { recursive: true })
    fs.symlinkSync(outside, checkout)
    stopPlay('loop-1')
    callbacks[1]()
    callbacks[2]()

    expect(kill).toHaveBeenCalledWith(-4242, 'SIGINT')
    expect(notify).toHaveBeenLastCalledWith(expect.objectContaining({
      running: false,
      error: expect.stringContaining('Could not clean the saved-round checkout'),
    }))
    expect(fs.lstatSync(checkout).isSymbolicLink()).toBe(true)
  })

  it('does not treat a reused group id as the launched process group', () => {
    expect(processGroupIdentitiesOverlap(
      ['4242:original-start', '4243:child-start'],
      ['4242:replacement-start'],
    )).toBe(false)
    expect(processGroupIdentitiesOverlap(
      ['4242:original-start', '4243:child-start'],
      ['4243:child-start'],
    )).toBe(true)
  })

  it('never adopts or signals a no-overlap process that reused the launcher group id', () => {
    const dir = workspace()
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { dev: 'vite' } }))
    const child = new EventEmitter() as ChildProcess
    Object.assign(child, { pid: 4242, stdout: new PassThrough(), stderr: new PassThrough() })
    const callbacks: Array<() => void> = []
    const kill = vi.fn()
    const groupIdentity = vi.fn()
      .mockReturnValueOnce(['4242:launcher'])
      .mockReturnValueOnce(['4242:unrelated-reuse'])
      .mockReturnValueOnce([])

    startPlay('loop-1', dir, null, null, vi.fn(), {
      spawn: (() => child) as typeof import('node:child_process').spawn,
      kill,
      groupIdentity,
      groupAlive: vi.fn(() => { throw new Error('must not authorize a reused group') }),
      setInterval: (() => ({ unref: vi.fn() }) as unknown as NodeJS.Timeout) as unknown as typeof setInterval,
      clearInterval: vi.fn(),
      setTimer: ((callback: () => void) => {
        callbacks.push(callback)
        return { unref: vi.fn() } as unknown as NodeJS.Timeout
      }) as typeof setTimeout,
      clearTimer: vi.fn(),
    })
    child.emit('exit', 0)

    expect(playState('loop-1')).toEqual(expect.objectContaining({
      running: true,
      error: expect.stringContaining('possibly unrelated group'),
    }))
    expect(kill).not.toHaveBeenCalled()
    callbacks[1]()
    expect(playState('loop-1').running).toBe(false)
  })

  it.each(['exit', 'error'] as const)('keeps Play blocked when the %s callback cannot re-probe group identity', (event) => {
    const dir = workspace()
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { dev: 'vite' } }))
    const child = new EventEmitter() as ChildProcess
    Object.assign(child, { pid: 4242, stdout: new PassThrough(), stderr: new PassThrough() })
    const callbacks: Array<() => void> = []
    const groupIdentity = vi.fn()
      .mockReturnValueOnce(['4242:launcher'])
      .mockImplementationOnce(() => { throw new Error('ps unavailable') })
      .mockReturnValue([])
    const kill = vi.fn()
    startPlay('loop-1', dir, null, null, vi.fn(), {
      spawn: (() => child) as typeof import('node:child_process').spawn,
      kill,
      groupIdentity,
      setInterval: (() => ({ unref: vi.fn() }) as unknown as NodeJS.Timeout) as unknown as typeof setInterval,
      clearInterval: vi.fn(),
      setTimer: ((callback: () => void) => {
        callbacks.push(callback)
        return { unref: vi.fn() } as unknown as NodeJS.Timeout
      }) as typeof setTimeout,
      clearTimer: vi.fn(),
    })

    expect(() => event === 'exit' ? child.emit('exit', 0) : child.emit('error', new Error('launcher failed'))).not.toThrow()
    expect(playState('loop-1')).toEqual(expect.objectContaining({
      running: true,
      error: expect.stringContaining('possibly unrelated group'),
    }))
    expect(kill).not.toHaveBeenCalled()
    callbacks[1]()
    expect(playState('loop-1').running).toBe(false)
  })

  it('reports a failed browser open without losing the running Play session', async () => {
    const dir = workspace()
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { dev: 'vite' } }))
    const child = new EventEmitter() as ChildProcess
    const stdout = new PassThrough()
    Object.assign(child, { pid: 4242, stdout, stderr: new PassThrough() })
    const notify = vi.fn()

    startPlay('loop-1', dir, null, null, notify, {
      spawn: (() => child) as typeof import('node:child_process').spawn,
      groupIdentity: () => ['4242:original-start'],
      openExternal: vi.fn(async () => { throw new Error('browser denied') }),
    })
    stdout.write('ready at http://127.0.0.1:4173/')
    await new Promise((resolve) => setImmediate(resolve))

    expect(notify).toHaveBeenLastCalledWith(expect.objectContaining({
      running: true,
      url: 'http://127.0.0.1:4173/',
      error: expect.stringContaining('browser denied'),
    }))
  })

  it('reports a synchronous spawn failure without retaining a running session', () => {
    const dir = workspace()
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { dev: 'vite' } }))
    const notify = vi.fn()
    const state = startPlay('loop-1', dir, null, null, notify, {
      spawn: (() => { throw new Error('spawn denied') }) as typeof import('node:child_process').spawn,
    })

    expect(state).toEqual(expect.objectContaining({ running: false, error: expect.stringContaining('spawn denied') }))
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ loopId: 'loop-1', running: false }))
  })

  it('supervises and stops a returned child that has no safe numeric PID', () => {
    const dir = workspace()
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { dev: 'vite' } }))
    const child = new EventEmitter() as ChildProcess
    const childKill = vi.fn()
    Object.assign(child, { pid: undefined, exitCode: null, signalCode: null, stdout: new PassThrough(), stderr: new PassThrough(), kill: childKill })
    const notify = vi.fn()
    const timers: Array<() => void> = []
    const state = startPlay('loop-1', dir, null, null, notify, {
      spawn: (() => child) as typeof import('node:child_process').spawn,
      setTimer: ((callback: () => void) => {
        timers.push(callback)
        return { unref: vi.fn() } as unknown as NodeJS.Timeout
      }) as typeof setTimeout,
    })

    expect(state).toEqual(expect.objectContaining({ running: true, error: expect.stringContaining('safe PID') }))
    expect(childKill).toHaveBeenCalledWith('SIGINT')
    timers.at(-1)?.()
    expect(childKill).toHaveBeenCalledWith('SIGKILL')
    expect(() => child.emit('error', new Error('asynchronous spawn failure'))).not.toThrow()
    expect(notify).toHaveBeenLastCalledWith(expect.objectContaining({ loopId: 'loop-1', running: false }))
  })

  it('does not signal a reused process group whose launch identity is gone', () => {
    const dir = workspace()
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { dev: 'vite' } }))
    const child = new EventEmitter() as ChildProcess
    const childKill = vi.fn()
    Object.assign(child, { pid: 4242, stdout: new PassThrough(), stderr: new PassThrough(), kill: childKill })
    const kill = vi.fn()

    startPlay('loop-1', dir, null, null, vi.fn(), {
      spawn: (() => child) as typeof import('node:child_process').spawn,
      kill,
      groupIdentity: () => ['4242:original-start'],
      groupAlive: () => false,
    })
    stopPlay('loop-1')

    expect(kill).not.toHaveBeenCalled()
  })

  it('keeps the project behind its launch gate and waits for the unverified wrapper to exit', async () => {
    const dir = workspace()
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { dev: 'vite' } }))
    const child = new EventEmitter() as ChildProcess
    const childKill = vi.fn()
    Object.assign(child, { pid: 4242, exitCode: null, signalCode: null, stdout: new PassThrough(), stderr: new PassThrough(), kill: childKill })
    const kill = vi.fn()
    const timers: Array<() => void> = []
    const notify = vi.fn()
    let gateFile = ''
    const state = startPlay('loop-1', dir, null, null, notify, {
      spawn: ((command: string, args: readonly string[]) => {
        expect(command).toBe('/bin/sh')
        gateFile = args[3]
        return child
      }) as typeof import('node:child_process').spawn,
      kill,
      groupIdentity: () => [],
      setTimer: ((callback: () => void) => {
        timers.push(callback)
        return { unref: vi.fn() } as unknown as NodeJS.Timeout
      }) as typeof setTimeout,
    })

    expect(state).toEqual(expect.objectContaining({ running: true, error: expect.stringContaining('ownership') }))
    expect(hasActivePlay()).toBe(true)
    expect(fs.existsSync(gateFile)).toBe(false)
    expect(childKill).toHaveBeenCalledWith('SIGINT')
    timers.at(-1)?.()
    expect(childKill).toHaveBeenCalledWith('SIGKILL')
    stopPlay('loop-1')
    expect(playState('loop-1')).toEqual(expect.objectContaining({ running: true, error: expect.stringContaining('launch gate') }))
    expect(kill).not.toHaveBeenCalled()
    let settled = false
    const wait = stopAllPlayAndWait().then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)
    child.emit('exit', 0)
    await wait
    expect(settled).toBe(true)
    expect(hasActivePlay()).toBe(false)
    expect(playState('loop-1').running).toBe(false)
    expect(notify).toHaveBeenLastCalledWith(expect.objectContaining({ loopId: 'loop-1', running: false }))
  })

  it('signals and settles a verified Stop even when renderer notification throws', async () => {
    const dir = workspace()
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { dev: 'vite' } }))
    const child = new EventEmitter() as ChildProcess
    Object.assign(child, { pid: 4242, exitCode: null, signalCode: null, stdout: new PassThrough(), stderr: new PassThrough() })
    const callbacks: Array<() => void> = []
    const kill = vi.fn()
    const groupAlive = vi.fn().mockReturnValueOnce(true).mockReturnValue(false)
    startPlay('loop-1', dir, null, null, () => { throw new Error('renderer destroyed') }, {
      spawn: (() => child) as typeof import('node:child_process').spawn,
      groupIdentity: () => ['4242:owned'],
      groupAlive,
      kill,
      setTimer: ((callback: () => void) => {
        callbacks.push(callback)
        return { unref: vi.fn() } as unknown as NodeJS.Timeout
      }) as typeof setTimeout,
    })

    expect(() => stopPlay('loop-1')).not.toThrow()
    expect(kill).toHaveBeenCalledWith(-4242, 'SIGINT')
    const settled = stopAllPlayAndWait()
    callbacks.at(-1)?.()
    await settled
    expect(hasActivePlay()).toBe(false)
  })

  it('signals on timeout and settles an unverified wrapper despite throwing notification', async () => {
    const dir = workspace()
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { dev: 'vite' } }))
    const verified = new EventEmitter() as ChildProcess
    Object.assign(verified, { pid: 4242, exitCode: null, signalCode: null, stdout: new PassThrough(), stderr: new PassThrough() })
    const callbacks: Array<() => void> = []
    const kill = vi.fn()
    const groupAlive = vi.fn().mockReturnValueOnce(true).mockReturnValue(false)
    startPlay('loop-1', dir, null, null, () => { throw new Error('renderer destroyed') }, {
      spawn: (() => verified) as typeof import('node:child_process').spawn,
      groupIdentity: () => ['4242:owned'],
      groupAlive,
      kill,
      setTimer: ((callback: () => void) => {
        callbacks.push(callback)
        return { unref: vi.fn() } as unknown as NodeJS.Timeout
      }) as typeof setTimeout,
    })
    callbacks[0]()
    expect(kill).toHaveBeenCalledWith(-4242, 'SIGINT')
    const verifiedSettled = stopAllPlayAndWait()
    callbacks.at(-1)?.()
    await verifiedSettled

    const unverified = new EventEmitter() as ChildProcess
    const directKill = vi.fn()
    Object.assign(unverified, { pid: undefined, exitCode: null, signalCode: null, stdout: new PassThrough(), stderr: new PassThrough(), kill: directKill })
    startPlay('loop-1', dir, null, null, () => { throw new Error('renderer destroyed') }, {
      spawn: (() => unverified) as typeof import('node:child_process').spawn,
      setTimer: ((callback: () => void) => {
        callbacks.push(callback)
        return { unref: vi.fn() } as unknown as NodeJS.Timeout
      }) as typeof setTimeout,
    })
    const unverifiedSettled = stopAllPlayAndWait()
    unverified.emit('exit', 0)
    await unverifiedSettled
    expect(directKill).toHaveBeenCalledWith('SIGINT')
    expect(hasActivePlay()).toBe(false)
  })
})
