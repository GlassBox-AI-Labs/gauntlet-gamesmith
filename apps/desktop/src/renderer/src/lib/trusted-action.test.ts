import { describe, expect, it, vi } from 'vitest'
import type { BuildRecord } from '../../../shared/build'
import { withExistingBuildTrust } from './trusted-action'

const build = { id: 'build-a', workspaceDir: '/games/a', playTrusted: false } as BuildRecord

describe('privileged action continuation', () => {
  it.each(['Play', 'Resume'])('continues %s on the captured ID and consults main even when renderer trust is stale', async (entry) => {
    const trust = vi.fn(async () => ({ ok: true as const, value: { ...build, executionTrusted: true } }))
    const action = vi.fn(async () => entry)
    expect(await withExistingBuildTrust(build, trust, () => true, action)).toBe(entry)
    expect(action).toHaveBeenCalledWith('build-a')
    trust.mockClear()
    await withExistingBuildTrust({ ...build, executionTrusted: true }, trust, () => true, action)
    await withExistingBuildTrust({ ...build, playTrusted: true }, trust, () => true, action)
    expect(trust).toHaveBeenCalledTimes(2)
  })

  it.each(['cancel', 'failure', 'wrong-build', 'wrong-folder', 'rejected-ipc'])('%s never starts the action', async (kind) => {
    const action = vi.fn()
    const trust = vi.fn(async () => {
      if (kind === 'rejected-ipc') throw new Error('IPC unavailable')
      if (kind === 'failure') return { ok: false as const, error: 'history mismatch' }
      return { ok: true as const, value: kind === 'cancel' ? null : { ...build,
        id: kind === 'wrong-build' ? 'build-b' : build.id,
        workspaceDir: kind === 'wrong-folder' ? '/games/b' : build.workspaceDir } }
    })
    await withExistingBuildTrust(build, trust, () => true, action).catch(() => {})
    expect(action).not.toHaveBeenCalled()
  })

  it.each(['another-build', 'away-and-back', 'unmounted'])('discards pending confirmation after %s selection changes', async () => {
    let generation = 0
    const capturedGeneration = generation
    let resolve!: (value: { ok: true; value: BuildRecord }) => void
    const trust = vi.fn(() => new Promise<{ ok: true; value: BuildRecord }>((done) => { resolve = done }))
    const action = vi.fn()
    const pending = withExistingBuildTrust(build, trust, () => generation === capturedGeneration, action)
    generation += 1
    resolve({ ok: true, value: { ...build, executionTrusted: true } })
    expect(await pending).toBeUndefined()
    expect(trust).toHaveBeenCalledWith('build-a')
    expect(action).not.toHaveBeenCalled()
  })
})
