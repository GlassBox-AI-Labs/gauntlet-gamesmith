import type { HarnessKind } from './harness'

/**
 * Bumped only when a later release needs to tell old records apart. A stored
 * `completed: true` keeps its meaning across versions, so upgrading never
 * replays the flow at someone who already finished it.
 */
export const ONBOARDING_VERSION = 1

export interface OnboardingState {
  /** True once the flow was finished or deliberately skipped. */
  completed: boolean
  version: number
  /** The harness the user connected during the flow, when they connected one. */
  harness: HarnessKind | null
  completedAt: string | null
}

export interface OnboardingApi {
  get(): Promise<OnboardingState>
  complete(harness: HarnessKind | null): Promise<OnboardingState>
  /** Replays the flow from the start; used by "Show the tour again". */
  reset(): Promise<OnboardingState>
}

export function pendingOnboarding(): OnboardingState {
  return { completed: false, version: ONBOARDING_VERSION, harness: null, completedAt: null }
}
