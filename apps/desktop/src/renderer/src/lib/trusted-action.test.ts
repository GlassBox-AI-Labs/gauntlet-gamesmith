import { describe, expect, it, vi } from 'vitest'
import type { LoopRecord } from '../../../shared/loop'
import { withExistingRunTrust } from './trusted-action'

const loop = { id: 'run-a', workspaceDir: '/games/a', playTrusted: false } as LoopRecord

describe('privileged action continuation', () => {
  it.each(['Play', 'Resume'])('continues %s on the captured ID and consults main even when renderer trust is stale', async (entry) => {
    const trust = vi.fn(async () => ({ ok: true as const, value: { ...loop, executionTrusted: true } }))
    const action = vi.fn(async () => entry)
    expect(await withExistingRunTrust(loop, trust, () => true, action)).toBe(entry)
    expect(action).toHaveBeenCalledWith('run-a')
    trust.mockClear()
    await withExistingRunTrust({ ...loop, executionTrusted: true }, trust, () => true, action)
    await withExistingRunTrust({ ...loop, playTrusted: true }, trust, () => true, action)
    expect(trust).toHaveBeenCalledTimes(2)
  })

  it.each(['cancel', 'failure', 'wrong-run', 'wrong-folder', 'rejected-ipc'])('%s never starts the action', async (kind) => {
    const action = vi.fn()
    const trust = vi.fn(async () => {
      if (kind === 'rejected-ipc') throw new Error('IPC unavailable')
      if (kind === 'failure') return { ok: false as const, error: 'history mismatch' }
      return { ok: true as const, value: kind === 'cancel' ? null : { ...loop,
        id: kind === 'wrong-run' ? 'run-b' : loop.id,
        workspaceDir: kind === 'wrong-folder' ? '/games/b' : loop.workspaceDir } }
    })
    await withExistingRunTrust(loop, trust, () => true, action).catch(() => {})
    expect(action).not.toHaveBeenCalled()
  })

  it.each(['another-run', 'away-and-back', 'unmounted'])('discards pending confirmation after %s selection changes', async () => {
    let generation = 0
    const capturedGeneration = generation
    let resolve!: (value: { ok: true; value: LoopRecord }) => void
    const trust = vi.fn(() => new Promise<{ ok: true; value: LoopRecord }>((done) => { resolve = done }))
    const action = vi.fn()
    const pending = withExistingRunTrust(loop, trust, () => generation === capturedGeneration, action)
    generation += 1
    resolve({ ok: true, value: { ...loop, executionTrusted: true } })
    expect(await pending).toBeUndefined()
    expect(trust).toHaveBeenCalledWith('run-a')
    expect(action).not.toHaveBeenCalled()
  })
})
