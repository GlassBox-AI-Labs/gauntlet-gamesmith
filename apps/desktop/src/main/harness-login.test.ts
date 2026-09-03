import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { spawn } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HarnessLoginManager } from './harness-login'

function fakeSpawn(responses: Map<string, { stdout?: string; stderr?: string; code?: number }>): typeof spawn {
  return ((command: string, args: string[], options: unknown) => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough
      stderr: PassThrough
      kill: ReturnType<typeof vi.fn>
      options: unknown
    }
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.kill = vi.fn(() => true)
    child.options = options
    const response = responses.get(`${command} ${args.join(' ')}`) ?? { code: 1, stderr: 'unexpected command' }
    queueMicrotask(() => {
      if (response.stdout) child.stdout.write(response.stdout)
      if (response.stderr) child.stderr.write(response.stderr)
      child.stdout.end()
      child.stderr.end()
      child.emit('close', response.code ?? 0)
    })
    return child
  }) as unknown as typeof spawn
}

afterEach(() => vi.useRealTimers())

describe('HarnessLoginManager', () => {
  it('detects and probes through a bounded, explicit command plan', async () => {
    const spawnCommand = vi.fn(fakeSpawn(new Map([
      ['/installed/claude --version', { stdout: 'claude 9.1\n' }],
      ['/installed/claude auth status --json', { stdout: '{"loggedIn":true,"authMethod":"oauth"}' }],
    ])))
    const manager = new HarnessLoginManager(
      '/safe/home',
      { action: vi.fn(), terminal: vi.fn() },
      {
        spawnCommand: spawnCommand as unknown as typeof spawn,
        cliHome: (kind) => `/private/${kind}`,
        cliExecutable: (kind) => `/installed/${kind}`,
        env: (overrides) => ({ PATH: '/bin', ...overrides, NO_COLOR: '1' }),
      },
    )

    await expect(manager.detect('claude')).resolves.toMatchObject({ found: true, version: 'claude 9.1' })
    await expect(manager.probe('claude')).resolves.toMatchObject({ loggedIn: true, authMethod: 'oauth' })
    for (const call of spawnCommand.mock.calls) {
      expect(call[0]).toBe('/installed/claude')
      expect(call[2]).toMatchObject({ cwd: '/safe/home', stdio: ['ignore', 'pipe', 'pipe'] })
    }
  })

  it('redacts credential-shaped version and detection error output', async () => {
    const spawnCommand = vi.fn(fakeSpawn(new Map([
      ['claude --version', { stdout: 'claude sk-proj-abcdefghijklmnopqrstuvwxyz\n' }],
      ['codex --version', { stderr: 'PASSWORD=two word secret', code: 1 }],
    ])))
    const manager = new HarnessLoginManager(
      '/safe/home',
      { action: vi.fn(), terminal: vi.fn() },
      {
        spawnCommand: spawnCommand as unknown as typeof spawn,
        cliHome: (kind) => `/private/${kind}`,
        cliExecutable: (kind) => kind,
      },
    )

    await expect(manager.detect('claude')).resolves.toEqual({
      found: true,
      version: 'claude [REDACTED]',
      error: null,
    })
    await expect(manager.detect('codex')).resolves.toEqual({
      found: false,
      version: 'PASSWORD=[REDACTED]',
      error: 'PASSWORD=[REDACTED]',
    })
  })

  it('SIGINTs a wedged probe, then applies a bounded SIGKILL fallback', async () => {
    vi.useFakeTimers()
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough
      stderr: PassThrough
      kill: ReturnType<typeof vi.fn>
    }
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.kill = vi.fn(() => true)
    const manager = new HarnessLoginManager(
      '/safe/home',
      { action: vi.fn(), terminal: vi.fn() },
      {
        spawnCommand: vi.fn(() => child) as unknown as typeof spawn,
        cliHome: (kind) => `/private/${kind}`,
        cliExecutable: (kind) => kind,
      },
    )

    const detection = manager.detect('codex')
    await vi.advanceTimersByTimeAsync(8_000)
    await expect(detection).resolves.toMatchObject({ found: false, error: 'Command timed out.' })
    expect(child.kill).toHaveBeenCalledWith('SIGINT')
    expect(child.kill).not.toHaveBeenCalledWith('SIGKILL')

    await vi.advanceTimersByTimeAsync(3_000)
    expect(child.kill).toHaveBeenCalledWith('SIGKILL')
  })
})
