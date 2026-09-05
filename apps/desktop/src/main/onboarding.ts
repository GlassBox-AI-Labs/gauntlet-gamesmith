import fs from 'node:fs'
import path from 'node:path'
import { harnessKinds, type HarnessKind } from '../shared/harness'
import { ONBOARDING_VERSION, pendingOnboarding, type OnboardingState } from '../shared/onboarding'
import { isIsoTimestamp } from '../shared/persisted-data'
import { readExactFileDescriptor } from './bounded-fd'

const ONBOARDING_FILE = 'onboarding.json'
const MAX_ONBOARDING_FILE_BYTES = 8 * 1024

/**
 * Whether the first-run flow still needs to be shown, stored beside the other
 * user-data registries.
 *
 * It is deliberately not in SQLite: the answer is one flag that has to be read
 * before the ledger opens, and a corrupt or missing file simply means "show the
 * flow again", which is the safe direction to fail.
 */
export class OnboardingStore {
  constructor(private readonly root: string) {}

  /** The stored state, or a pending one when the file is missing or unusable. */
  read(): OnboardingState {
    return normalize(this.readFile())
  }

  /**
   * Records that the flow is done. `harness` is what the user connected, or
   * null when they moved on without connecting one.
   */
  complete(harness: HarnessKind | null): OnboardingState {
    return this.write({
      completed: true,
      version: ONBOARDING_VERSION,
      harness,
      completedAt: new Date().toISOString(),
    })
  }

  /** Puts the flow back so it runs again on the next open. */
  reset(): OnboardingState {
    return this.write(pendingOnboarding())
  }

  private readFile(): unknown {
    let descriptor: number | null = null
    try {
      const filePath = path.join(this.root, ONBOARDING_FILE)
      descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0))
      const opened = fs.fstatSync(descriptor)
      const linked = fs.lstatSync(filePath)
      if (
        !opened.isFile()
        || opened.nlink !== 1
        || !linked.isFile()
        || linked.isSymbolicLink()
        || linked.nlink !== 1
        || linked.dev !== opened.dev
        || linked.ino !== opened.ino
      ) return null
      const bytes = readExactFileDescriptor(descriptor, opened.size, MAX_ONBOARDING_FILE_BYTES, 'Onboarding state')
      return JSON.parse(bytes.toString('utf8')) as unknown
    } catch {
      return null
    } finally {
      if (descriptor !== null) fs.closeSync(descriptor)
    }
  }

  private write(state: OnboardingState): OnboardingState {
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 })
    const target = path.join(this.root, ONBOARDING_FILE)
    const body = Buffer.from(`${JSON.stringify(state, null, 2)}\n`, 'utf8')
    const descriptor = fs.openSync(target, fs.constants.O_RDWR | fs.constants.O_CREAT | (fs.constants.O_NOFOLLOW ?? 0), 0o600)
    try {
      const opened = fs.fstatSync(descriptor)
      const linked = fs.lstatSync(target)
      if (
        !opened.isFile()
        || opened.nlink !== 1
        || !linked.isFile()
        || linked.isSymbolicLink()
        || linked.nlink !== 1
        || linked.dev !== opened.dev
        || linked.ino !== opened.ino
      ) throw new Error('Onboarding state is not a unique regular file.')
      fs.ftruncateSync(descriptor, 0)
      fs.writeFileSync(descriptor, body)
      fs.fchmodSync(descriptor, 0o600)
      fs.fsyncSync(descriptor)
    } finally {
      fs.closeSync(descriptor)
    }
    return state
  }
}

/**
 * Reads a stored record defensively. Anything unrecognized falls back to
 * pending rather than throwing, so a hand-edited or truncated file costs the
 * user one extra tour instead of a failed launch.
 */
function normalize(value: unknown): OnboardingState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return pendingOnboarding()
  const record = value as Record<string, unknown>
  if (record.completed !== true) return pendingOnboarding()
  const harness = record.harness
  const version = record.version
  return {
    completed: true,
    // An unknown version still counts as completed; only the number is repaired.
    version: typeof version === 'number' && Number.isInteger(version) && version > 0 ? version : ONBOARDING_VERSION,
    harness: typeof harness === 'string' && harnessKinds.includes(harness as HarnessKind) ? harness as HarnessKind : null,
    completedAt: isIsoTimestamp(record.completedAt) ? record.completedAt : null,
  }
}
