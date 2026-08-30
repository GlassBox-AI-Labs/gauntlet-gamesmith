import { describe, expect, it } from 'vitest'
import { initialHarnessState, reduceHarness } from './login-state'

describe('harness login state', () => {
  it('reaches connected only after a successful probe', () => {
    let state = initialHarnessState('claude', 'Claude Code')
    state = reduceHarness(state, { type: 'detected', found: true, version: '2.1.251' })
    state = reduceHarness(state, { type: 'login_started' })
    state = reduceHarness(state, { type: 'login_url', url: 'https://example.com/login' })

    expect(state.phase).toBe('awaiting_browser')

    state = reduceHarness(state, {
      type: 'probe_finished',
      loggedIn: true,
      authMethod: 'claude.ai',
      details: [['Provider', 'Anthropic API']],
    })

    expect(state.phase).toBe('logged_in')
    expect(state.authMethod).toBe('claude.ai')
  })

  it('returns to disconnected after cancellation', () => {
    let state = initialHarnessState('codex', 'Codex')
    state = reduceHarness(state, { type: 'detected', found: true, version: 'codex-cli 0.147.0' })
    state = reduceHarness(state, { type: 'login_started' })
    state = reduceHarness(state, { type: 'login_cancelled' })

    expect(state.phase).toBe('logged_out')
    expect(state.url).toBeNull()
  })
})
