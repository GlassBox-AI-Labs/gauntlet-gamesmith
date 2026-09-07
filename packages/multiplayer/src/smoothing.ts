import type { PoseBuffer as PublicPoseBuffer } from './browser-api'
/** A timestamped pose buffer shared by every game. Render time always moves forward. */
export interface Pose { x: number; z: number; heading: number; s: number; vx: number; vz: number; speed: number }
interface Sample { at: number; seq: number; pose: Pose }
const wrap = (r: number) => Math.atan2(Math.sin(r), Math.cos(r))
export class PoseBuffer implements PublicPoseBuffer {
  private samples: Sample[] = []
  private lastSeq = -1
  private lastRender = -Infinity
  private delay = 100
  private jitter = 0
  private lastArrival = 0
  private lastAt = 0
  constructor(private readonly options = { minDelayMs: 80, maxDelayMs: 180, maxExtrapolateMs: 80, teleportDistance: 50 }) {}
  push(at: number, seq: number, pose: Pose, arrival: number): void {
    if (!Number.isFinite(at) || !Number.isFinite(arrival) || seq <= this.lastSeq || Object.values(pose).some(v => !Number.isFinite(v))) return
    if (this.samples.length && at <= this.samples.at(-1)!.at) return
    if (this.lastArrival) {
      this.jitter += (Math.abs((arrival - this.lastArrival) - (at - this.lastAt)) - this.jitter) * 0.1
      const wanted = Math.min(this.options.maxDelayMs, Math.max(this.options.minDelayMs, 80 + this.jitter * 2))
      this.delay += (wanted - this.delay) * 0.1
    }
    this.lastArrival = arrival; this.lastAt = at; this.lastSeq = seq
    const previous = this.samples.at(-1)
    if (previous && Math.hypot(pose.x - previous.pose.x, pose.z - previous.pose.z) > this.options.teleportDistance) this.samples = []
    this.samples.push({ at, seq, pose: { ...pose } })
    if (this.samples.length > 32) this.samples.shift()
  }
  sample(serverNow: number): Pose | null {
    if (!this.samples.length) return null
    const at = Math.max(this.lastRender, serverNow - this.delay)
    this.lastRender = at
    while (this.samples.length > 2 && this.samples[1].at <= at) this.samples.shift()
    const a = this.samples[0], b = this.samples[1]
    if (at <= a.at) return { ...a.pose }
    if (b && at <= b.at) {
      const t = (at - a.at) / (b.at - a.at), result = { ...a.pose }
      for (const key of ['x', 'z', 's', 'vx', 'vz', 'speed'] as const) result[key] += (b.pose[key] - a.pose[key]) * t
      result.heading += wrap(b.pose.heading - a.pose.heading) * t
      return result
    }
    const last = this.samples.at(-1)!, dt = Math.min(this.options.maxExtrapolateMs, Math.max(0, at - last.at)) / 1000
    return { ...last.pose, x: last.pose.x + last.pose.vx * dt, z: last.pose.z + last.pose.vz * dt, s: last.pose.s + last.pose.speed * dt }
  }
  diagnostics() { return { bufferMs: this.delay, jitterMs: this.jitter, samples: this.samples.length } }
}
