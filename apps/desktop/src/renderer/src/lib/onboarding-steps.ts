import { HARNESS_LABELS, type HarnessKind, type HarnessState } from '../../../shared/harness'

export const ONBOARDING_STEPS = ['welcome', 'connect', 'tour', 'ready'] as const

export type OnboardingStep = (typeof ONBOARDING_STEPS)[number]

export const STEP_TITLES: Record<OnboardingStep, string> = {
  welcome: 'Welcome',
  connect: 'Connect an agent',
  tour: 'How it works',
  ready: 'You are ready',
}

export interface TourCard {
  title: string
  body: string
}

/**
 * The tour, in the order the app actually does these things. Kept as data so
 * the copy can be read and corrected without touching the view.
 */
export const TOUR_CARDS: readonly TourCard[] = [
  {
    title: 'Describe the game you want',
    body: 'Write it in plain words, like "a top-down game where you dodge asteroids". Pick a folder to keep it in, and press start.',
  },
  {
    title: 'It looks things up first',
    body: 'Before writing any code, the app collects real reference material — pictures, video, and notes — and freezes it. Every later step works from that same pack, so the game has something concrete to aim at.',
  },
  {
    title: 'It builds, then criticizes its own work',
    body: 'One agent writes the game. A second one plays it and writes down what is wrong. Those complaints become the instructions for the next round. This repeats until the critic is satisfied or you stop it.',
  },
  {
    title: 'Play it and share it',
    body: 'Press Play at any point to open the game in your browser. Export packs the whole build — code, reference material, and history — into one folder you can send to someone else.',
  },
]

export function stepIndex(step: OnboardingStep): number {
  return ONBOARDING_STEPS.indexOf(step)
}

export function nextStep(step: OnboardingStep): OnboardingStep | null {
  return ONBOARDING_STEPS[stepIndex(step) + 1] ?? null
}

export function previousStep(step: OnboardingStep): OnboardingStep | null {
  return stepIndex(step) === 0 ? null : ONBOARDING_STEPS[stepIndex(step) - 1] ?? null
}

export function isConnected(state: HarnessState): boolean {
  return state.phase === 'logged_in'
}

/** The harness to record as the one the user set up, if any. */
export function connectedHarness(states: Record<HarnessKind, HarnessState>): HarnessKind | null {
  return (Object.keys(states) as HarnessKind[]).find((kind) => isConnected(states[kind])) ?? null
}

/**
 * What the connect step should say about a harness right now.
 *
 * `blocked` is the case that matters: the CLI is not on the machine, so no
 * amount of clicking sign-in will help and the install command must be shown
 * instead.
 */
export type ConnectStatus = 'checking' | 'blocked' | 'installing' | 'ready' | 'working' | 'connected' | 'failed'

export function connectStatus(state: HarnessState): ConnectStatus {
  switch (state.phase) {
    case 'checking':
      return 'checking'
    case 'not_found':
      return 'blocked'
    case 'installing':
      return 'installing'
    case 'signing_in':
    case 'awaiting_browser':
    case 'signing_out':
      return 'working'
    case 'logged_in':
      return 'connected'
    case 'error':
      return 'failed'
    case 'logged_out':
      return 'ready'
  }
}

export function connectStatusLabel(state: HarnessState): string {
  switch (connectStatus(state)) {
    case 'checking':
      return 'Looking for it…'
    case 'blocked':
      return state.error ?? `${HARNESS_LABELS[state.kind]} is not installed yet`
    case 'installing':
      return 'Installing…'
    case 'working':
      return 'Finish signing in'
    case 'connected':
      return 'Connected'
    case 'failed':
      return state.error ?? 'Sign-in failed'
    case 'ready':
      return 'Installed, not signed in'
  }
}

/**
 * Whether the connect step is satisfied. One connected agent is enough — the
 * app only needs a single one to run.
 */
export function canLeaveConnectStep(states: Record<HarnessKind, HarnessState>): boolean {
  return connectedHarness(states) !== null
}

/**
 * Whether every harness has finished being checked. Until then the step cannot
 * honestly say an agent is missing.
 */
export function connectStepSettled(states: Record<HarnessKind, HarnessState>): boolean {
  return (Object.keys(states) as HarnessKind[]).every((kind) => states[kind].phase !== 'checking')
}

/**
 * The sentence under the connect step's continue button. It has to be honest
 * when nothing is connected, because the app cannot run a single round without
 * an agent.
 */
export function connectFooterNote(states: Record<HarnessKind, HarnessState>): string {
  const connected = connectedHarness(states)
  if (connected) return `${HARNESS_LABELS[connected]} is connected. Your own subscription pays for the work.`
  return 'You can look around without connecting one, but a build cannot start until an agent is signed in.'
}
