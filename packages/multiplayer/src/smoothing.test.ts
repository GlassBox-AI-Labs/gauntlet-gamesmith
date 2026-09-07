import { describe, expect, it } from 'vitest'
import { SnapshotBuffer, TransformBuffer, PoseBuffer, type Pose, type Transform } from './smoothing'
const pose = (x: number, s = x, heading = 0): Pose => ({ x, z: 0, s, heading, vx: 10, vz: 0, speed: 10 })
describe('remote pose presentation', () => {
  it('interpolates ramp progress on the same timeline as position and takes the short rotation', () => {
    const buffer = new PoseBuffer()
    buffer.push(1000, 1, pose(0, 100, Math.PI - 0.1), 1000)
    buffer.push(1100, 2, pose(10, 200, -Math.PI + 0.1), 1100)
    const p = buffer.sample(1150)!
    expect(p.s).toBeCloseTo(100 + p.x * 10)
    expect(Math.abs(p.heading)).toBeGreaterThan(3)
  })
  it('ignores stale snapshots and stops extrapolating through an outage', () => {
    const buffer = new PoseBuffer()
    buffer.push(1000, 2, pose(10), 1000)
    buffer.push(1100, 1, pose(-100), 1100)
    expect(buffer.sample(1500)!.x).toBeCloseTo(10.8)
    expect(buffer.sample(9000)!.x).toBeCloseTo(10.8)
  })
  it('keeps remote motion continuous under alternating delivery jitter', () => {
    const buffer = new PoseBuffer()
    const messages = Array.from({ length: 80 }, (_, seq) => ({ seq, at: 1000 + seq * 40, arrival: 1000 + seq * 40 + (seq % 3 === 0 ? 80 : 20) }))
    messages.sort((a,b) => a.arrival-b.arrival)
    let last = 0, maxStep = 0
    for (let now = 1000; now < 4000; now += 16) {
      while (messages[0]?.arrival <= now) { const m = messages.shift()!; buffer.push(m.at,m.seq,pose((m.at-1000)/100),m.arrival) }
      const current = buffer.sample(now)
      if (current) { maxStep = Math.max(maxStep, Math.abs(current.x-last)); last=current.x }
    }
    // A 10-units/s entity should move continuously between 60 Hz frames.
    expect(maxStep).toBeLessThan(0.5)
    expect(last).toBeGreaterThan(25)
  })
})

const fixedDelay = { minDelayMs: 100, maxDelayMs: 100 }
const transform = (x: number, y = 0, z = 0): Transform => ({ x, y, z, vx: 1, vy: 2, vz: 3, qx: 0, qy: 0, qz: 0, qw: 1 })
describe('spatial presentation across genres', () => {
  it('interpolates all three axes and normalized rotation without track fields', () => {
    const buffer = new TransformBuffer(fixedDelay)
    buffer.push(1000, 1, transform(0), 1000)
    buffer.push(1100, 2, { ...transform(10, 6, -2), qy: 1, qw: 0 }, 1100)
    const state = buffer.sample(1150)!
    expect(state).toMatchObject({ x: 5, y: 3, z: -1 })
    expect(state.qy).toBeCloseTo(Math.SQRT1_2)
    expect(state.qw).toBeCloseTo(Math.SQRT1_2)
    expect(state).not.toHaveProperty('s')
    expect(state).not.toHaveProperty('speed')
  })

  it('keeps equivalent quaternion signs stable and bounds vertical extrapolation', () => {
    const buffer = new TransformBuffer(fixedDelay)
    buffer.push(1000, 1, transform(0), 1000)
    buffer.push(1100, 2, { ...transform(0, 10), qw: -2 }, 1100)
    expect(Math.abs(buffer.sample(1150)!.qw)).toBeCloseTo(1)
    const stopped = buffer.sample(2000)!
    expect(stopped).toMatchObject({ x: 0.08, y: 10.16, z: 0.24 })
    expect(buffer.sample(9000)).toEqual(stopped)
  })

  it('resets interpolation on vertical teleports and rejects invalid transforms', () => {
    const buffer = new TransformBuffer({ ...fixedDelay, teleportDistance: 20 })
    buffer.push(1000, 1, transform(0), 1000)
    buffer.push(1100, 2, transform(0, 100), 1100)
    expect(buffer.sample(1150)!.y).toBe(100)
    buffer.push(1200, 3, { ...transform(999), qw: 0 }, 1200)
    buffer.push(1300, 4, { ...transform(999), y: NaN }, 1300)
    expect(buffer.diagnostics().samples).toBe(1)
  })
})

describe('game-defined presentation', () => {
  it('smooths continuous puzzle progress while preserving discrete choices and revisions', () => {
    type Puzzle = { progress: number; switchOn: boolean; phase: string; revision: number }
    const buffer = new SnapshotBuffer<Puzzle>({
      interpolate: (a, b, t) => ({ ...(t < 1 ? a : b), progress: a.progress + (b.progress - a.progress) * t }),
    }, fixedDelay)
    buffer.push(1000, 1, { progress: 0, switchOn: false, phase: 'waiting', revision: 1 }, 1000)
    buffer.push(1100, 2, { progress: 1, switchOn: true, phase: 'open', revision: 2 }, 1100)
    expect(buffer.sample(1150)).toEqual({ progress: 0.5, switchOn: false, phase: 'waiting', revision: 1 })
    expect(buffer.sample(1200)).toEqual({ progress: 1, switchOn: true, phase: 'open', revision: 2 })
    expect(buffer.sample(9000)).toEqual({ progress: 1, switchOn: true, phase: 'open', revision: 2 })
  })

  it('isolates snapshots from caller mutation, rejects stale frames and bounds retained history', () => {
    const buffer = new SnapshotBuffer<{ selected: string }>({ interpolate: a => ({ ...a }) }, fixedDelay)
    const state = { selected: 'bridge' }
    buffer.push(1000, 2, state, 1000)
    state.selected = 'mutated'
    buffer.push(1100, 1, state, 1100)
    const shown = buffer.sample(1200)!
    expect(shown.selected).toBe('bridge')
    shown.selected = 'mutated result'
    expect(buffer.sample(1250)!.selected).toBe('bridge')
    for (let i = 3; i < 100; i++) buffer.push(1000 + i * 40, i, { selected: `choice-${i}` }, 1000 + i * 40)
    expect(buffer.diagnostics().samples).toBe(32)
    const now = buffer.sample(6000)
    expect(buffer.sample(5000)).toEqual(now)
  })

  it('rejects invalid timing options instead of making the render clock unusable', () => {
    expect(() => new SnapshotBuffer({ interpolate: a => ({ ...a }) }, { minDelayMs: 200, maxDelayMs: 100 })).toThrow('timing')
    expect(() => new TransformBuffer({ maxExtrapolateMs: Infinity })).toThrow('timing')
    expect(() => new TransformBuffer({ teleportDistance: 0 })).toThrow('Teleport')
  })
})
