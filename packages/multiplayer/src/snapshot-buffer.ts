import type { State } from './index'
import type { SnapshotBuffer as PublicSnapshotBuffer, SnapshotInterpolation, SnapshotBufferOptions } from './browser-api'
export type { SnapshotInterpolation, SnapshotBufferOptions } from './browser-api'

interface Sample<T> { at: number; state: T }

/** Shared timing and jitter handling; the game decides how its fields interpolate. */
export class SnapshotBuffer<T extends State = State> implements PublicSnapshotBuffer<T> {
  private samples: Sample<T>[] = []
  private lastSeq = -1
  private lastRender = -Infinity
  private delay: number
  private jitter = 0
  private lastArrival: number | null = null
  private lastAt = 0
  private readonly options: Required<SnapshotBufferOptions>

  constructor(private readonly interpolation: SnapshotInterpolation<T>, options: SnapshotBufferOptions = {}) {
    this.options = { minDelayMs: 80, maxDelayMs: 180, maxExtrapolateMs: 80, ...options }
    const { minDelayMs, maxDelayMs, maxExtrapolateMs } = this.options
    if (![minDelayMs, maxDelayMs, maxExtrapolateMs].every(n => Number.isFinite(n) && n >= 0) || maxDelayMs < minDelayMs) {
      throw new Error('Invalid snapshot timing options.')
    }
    this.delay = Math.max(minDelayMs, Math.min(maxDelayMs, 100))
  }

  push(at: number, seq: number, state: T, arrival: number): void {
    if (!Number.isFinite(at) || !Number.isFinite(arrival) || !Number.isSafeInteger(seq) || seq < 0 || seq <= this.lastSeq) return
    if (!state || Object.values(state).some(value => typeof value === 'number' ? !Number.isFinite(value) : typeof value !== 'boolean' && typeof value !== 'string')) return
    if (this.samples.length && at <= this.samples.at(-1)!.at) return
    if (this.lastArrival !== null) {
      this.jitter += (Math.abs((arrival - this.lastArrival) - (at - this.lastAt)) - this.jitter) * 0.1
      const wanted = Math.min(this.options.maxDelayMs, Math.max(this.options.minDelayMs, 80 + this.jitter * 2))
      this.delay += (wanted - this.delay) * 0.1
    }
    this.lastArrival = arrival; this.lastAt = at; this.lastSeq = seq
    const previous = this.samples.at(-1)
    if (previous && this.interpolation.discontinuity?.(previous.state, state)) this.samples = []
    this.samples.push({ at, state: { ...state } })
    if (this.samples.length > 32) this.samples.shift()
  }

  sample(serverNow: number): T | null {
    if (!this.samples.length || !Number.isFinite(serverNow)) return null
    const at = Math.max(this.lastRender, serverNow - this.delay)
    this.lastRender = at
    while (this.samples.length > 2 && this.samples[1].at <= at) this.samples.shift()
    const a = this.samples[0], b = this.samples[1]
    if (at <= a.at) return { ...a.state }
    if (b && at <= b.at) return { ...this.interpolation.interpolate(a.state, b.state, (at - a.at) / (b.at - a.at)) }
    const last = this.samples.at(-1)!
    const seconds = Math.min(this.options.maxExtrapolateMs, Math.max(0, at - last.at)) / 1000
    return { ...(this.interpolation.extrapolate?.(last.state, seconds) ?? last.state) }
  }

  diagnostics() { return { bufferMs: this.delay, jitterMs: this.jitter, samples: this.samples.length } }
}
