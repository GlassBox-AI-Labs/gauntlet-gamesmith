import { describe, expect, it } from 'vitest'
import { PoseBuffer, type Pose } from './smoothing'
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
    // A 10-units/s car should never jump a car length between 60 Hz frames.
    expect(maxStep).toBeLessThan(0.5)
    expect(last).toBeGreaterThan(25)
  })
})
