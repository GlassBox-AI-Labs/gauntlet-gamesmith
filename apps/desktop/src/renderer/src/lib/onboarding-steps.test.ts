import { describe, expect, it } from 'vitest'
import type { HarnessKind, HarnessState, LoginPhase } from '../../../shared/harness'
import { HARNESS_LABELS } from '../../../shared/harness'
import { initialHarnessState } from './login-state'
import {
  ONBOARDING_STEPS,
  canLeaveConnectStep,
  connectFooterNote,
  connectStatus,
  connectStatusLabel,
  connectStepSettled,
  connectedHarness,
  nextStep,
  previousStep,
  stepIndex,
} from './onboarding-steps'

function harness(kind: HarnessKind, phase: LoginPhase, error: string | null = null): HarnessState {
  return { ...initialHarnessState(kind, HARNESS_LABELS[kind]), phase, error }
}

function states(claude: LoginPhase, codex: LoginPhase): Record<HarnessKind, HarnessState> {
  return { claude: harness('claude', claude), codex: harness('codex', codex) }
}

describe('step order', () => {
  it('walks forward through every step and stops at the end', () => {
    const visited = ['welcome']
    let step = nextStep('welcome')
    while (step) {
      visited.push(step)
      step = nextStep(step)
    }
    expect(visited).toEqual([...ONBOARDING_STEPS])
  })

  it('has no step before the first one', () => {
    expect(previousStep('welcome')).toBeNull()
    expect(previousStep('connect')).toBe('welcome')
  })

  it('orders steps by their index', () => {
    expect(stepIndex('welcome')).toBe(0)
    expect(stepIndex('ready')).toBe(ONBOARDING_STEPS.length - 1)
  })
})

describe('connect status', () => {
  it('calls a missing CLI blocked so the install command is shown', () => {
    expect(connectStatus(harness('claude', 'not_found'))).toBe('blocked')
    expect(connectStatusLabel(harness('claude', 'not_found'))).toContain('not installed')
  })

  it('treats both signing-in phases as work in progress', () => {
    expect(connectStatus(harness('codex', 'signing_in'))).toBe('working')
    expect(connectStatus(harness('codex', 'awaiting_browser'))).toBe('working')
  })

  it('reports an installed but signed-out CLI as ready to sign in', () => {
    expect(connectStatus(harness('claude', 'logged_out'))).toBe('ready')
  })

  it('surfaces the real sign-in error rather than a generic one', () => {
    expect(connectStatusLabel(harness('claude', 'error', 'Browser never returned.'))).toBe('Browser never returned.')
  })

  it('falls back to a generic message when a failure carries no text', () => {
    expect(connectStatusLabel(harness('claude', 'error'))).toBe('Sign-in failed')
  })
})

describe('leaving the connect step', () => {
  it('is satisfied by a single connected agent', () => {
    expect(canLeaveConnectStep(states('logged_in', 'not_found'))).toBe(true)
    expect(canLeaveConnectStep(states('not_found', 'logged_in'))).toBe(true)
  })

  it('is not satisfied while nothing is connected', () => {
    expect(canLeaveConnectStep(states('logged_out', 'not_found'))).toBe(false)
  })

  it('waits for both checks before claiming anything is missing', () => {
    expect(connectStepSettled(states('checking', 'logged_out'))).toBe(false)
    expect(connectStepSettled(states('not_found', 'logged_out'))).toBe(true)
  })

  it('names the connected harness, preferring Claude when both are signed in', () => {
    expect(connectedHarness(states('logged_in', 'logged_in'))).toBe('claude')
    expect(connectedHarness(states('logged_out', 'logged_in'))).toBe('codex')
    expect(connectedHarness(states('logged_out', 'logged_out'))).toBeNull()
  })

  it('warns plainly that runs cannot start without an agent', () => {
    expect(connectFooterNote(states('logged_out', 'logged_out'))).toContain('cannot start')
    expect(connectFooterNote(states('logged_in', 'logged_out'))).toContain(HARNESS_LABELS.claude)
  })
})

describe('installing state', () => {
  it('reports an install in progress as its own status', () => {
    expect(connectStatus(harness('claude', 'installing'))).toBe('installing')
    expect(connectStatusLabel(harness('claude', 'installing'))).toBe('Installing…')
  })

  it('shows why an install failed instead of the generic missing-CLI line', () => {
    expect(connectStatusLabel(harness('codex', 'not_found', 'The installer exited 1.')))
      .toBe('The installer exited 1.')
  })

  it('still names the missing CLI when there is no failure to report', () => {
    expect(connectStatusLabel(harness('codex', 'not_found'))).toContain('not installed')
  })

  it('does not count an in-progress install as settled or connected', () => {
    expect(connectStepSettled(states('installing', 'not_found'))).toBe(true)
    expect(canLeaveConnectStep(states('installing', 'not_found'))).toBe(false)
  })
})
