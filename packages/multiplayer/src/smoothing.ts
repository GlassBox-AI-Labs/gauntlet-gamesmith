import { SnapshotBuffer } from './snapshot-buffer'
import type { PoseBuffer as PublicPoseBuffer, TransformBuffer as PublicTransformBuffer, SnapshotBufferOptions } from './browser-api'
export { SnapshotBuffer } from './snapshot-buffer'
export type { SnapshotInterpolation, SnapshotBufferOptions } from './snapshot-buffer'

/** Position, velocity and quaternion rotation for avatars, objects and vehicles. */
export type Transform = {
  x: number; y: number; z: number
  vx: number; vy: number; vz: number
  qx: number; qy: number; qz: number; qw: number
}
export type TransformBufferOptions = SnapshotBufferOptions & { teleportDistance?: number }
const coordinates = ['x', 'y', 'z', 'vx', 'vy', 'vz'] as const
const rotation = ['qx', 'qy', 'qz', 'qw'] as const

function teleportThreshold(value = 50): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error('Teleport distance must be positive.')
  return value
}

/** Optional spatial adapter. Non-spatial games can use SnapshotBuffer directly. */
export class TransformBuffer extends SnapshotBuffer<Transform> implements PublicTransformBuffer {
  constructor(options: TransformBufferOptions = {}) {
    const teleportDistance = teleportThreshold(options.teleportDistance)
    super({
      interpolate(a, b, t) {
        const result = { ...a }
        for (const key of coordinates) result[key] += (b[key] - a[key]) * t
        // q and -q describe the same orientation. Normalize the shortest-path blend.
        const sign = rotation.reduce((dot, key) => dot + a[key] * b[key], 0) < 0 ? -1 : 1
        for (const key of rotation) result[key] += (sign * b[key] - a[key]) * t
        const length = Math.hypot(result.qx, result.qy, result.qz, result.qw)
        for (const key of rotation) result[key] /= length
        return result
      },
      extrapolate: (state, seconds) => ({ ...state, x: state.x + state.vx * seconds, y: state.y + state.vy * seconds, z: state.z + state.vz * seconds }),
      discontinuity: (a, b) => Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z) > teleportDistance,
    }, options)
  }

  override push(at: number, seq: number, state: Transform, arrival: number): void {
    if ([...coordinates, ...rotation].some(key => !Number.isFinite(state[key]))) return
    const length = Math.hypot(state.qx, state.qy, state.qz, state.qw)
    if (!Number.isFinite(length) || length < 1e-9) return
    super.push(at, seq, { ...state, qx: state.qx / length, qy: state.qy / length, qz: state.qz / length, qw: state.qw / length }, arrival)
  }
}

/** Legacy track-motion adapter, retained for games already using this shape. */
export type Pose = { x: number; z: number; heading: number; s: number; vx: number; vz: number; speed: number }
const wrap = (r: number) => Math.atan2(Math.sin(r), Math.cos(r))
export class PoseBuffer extends SnapshotBuffer<Pose> implements PublicPoseBuffer {
  constructor(options: TransformBufferOptions = {}) {
    const teleportDistance = teleportThreshold(options.teleportDistance)
    super({
      interpolate(a, b, t) {
        const result = { ...a }
        for (const key of ['x', 'z', 's', 'vx', 'vz', 'speed'] as const) result[key] += (b[key] - a[key]) * t
        result.heading += wrap(b.heading - a.heading) * t
        return result
      },
      extrapolate: (state, seconds) => ({ ...state, x: state.x + state.vx * seconds, z: state.z + state.vz * seconds, s: state.s + state.speed * seconds }),
      discontinuity: (a, b) => Math.hypot(b.x - a.x, b.z - a.z) > teleportDistance,
    }, options)
  }
}
