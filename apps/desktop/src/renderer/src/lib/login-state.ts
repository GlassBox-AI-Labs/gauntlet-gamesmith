import type { HarnessAction, HarnessKind, HarnessState } from '../../../shared/harness'

export function initialHarnessState(kind: HarnessKind, label: string): HarnessState {
  return {
    kind,
    label,
    phase: 'checking',
    found: false,
    version: null,
    authMethod: null,
    details: [],
    url: null,
    error: null,
  }
}

export function reduceHarness(state: HarnessState, action: HarnessAction): HarnessState {
  switch (action.type) {
    case 'detected':
      return {
        ...state,
        found: action.found,
        version: action.version ?? null,
        phase: action.found ? 'logged_out' : 'not_found',
        error: action.error ?? null,
      }
    case 'probe_started':
      return { ...state, phase: 'checking', error: null }
    case 'probe_finished':
      return {
        ...state,
        phase: action.loggedIn ? 'logged_in' : 'logged_out',
        authMethod: action.authMethod ?? null,
        details: action.details ?? state.details,
        error: action.error ?? null,
      }
    case 'login_started':
      return { ...state, phase: 'signing_in', url: null, error: null }
    case 'login_url':
      return { ...state, phase: 'awaiting_browser', url: action.url }
    case 'login_cancelled':
      return { ...state, phase: 'logged_out', url: null }
    case 'login_failed':
      return { ...state, phase: 'error', error: action.error, url: null }
  }
}
