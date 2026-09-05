import { useCallback, useEffect, useReducer, useRef } from 'react'
import { HARNESS_LABELS, harnessKinds, type HarnessAction, type HarnessKind, type HarnessState } from '../../../shared/harness'
import { initialHarnessState, reduceHarness } from '@/lib/login-state'

export type HarnessMap = Record<HarnessKind, HarnessState>
export type HarnessStateEvent = { kind: HarnessKind; action: HarnessAction }

const initialState: HarnessMap = Object.fromEntries(
  harnessKinds.map((kind) => [kind, initialHarnessState(kind, HARNESS_LABELS[kind])]),
) as HarnessMap

function stateReducer(state: HarnessMap, event: HarnessStateEvent): HarnessMap {
  return { ...state, [event.kind]: reduceHarness(state[event.kind], event.action) }
}

function message(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message ? cause.message : fallback
}

export interface HarnessConnections {
  states: HarnessMap
  dispatch: (event: HarnessStateEvent) => void
  /** The rolling login transcript per harness, for the terminal panel. */
  transcripts: React.RefObject<Record<HarnessKind, string>>
  registerWriter: (kind: HarnessKind, writer: ((data: string) => void) | null) => void
  clearTranscript: (kind: HarnessKind) => void
  /** Re-asks the CLI whether it is signed in. */
  probe: (kind: HarnessKind) => Promise<void>
}

/**
 * The shared "is this CLI here, and is it signed in" wiring: one detect and
 * probe per harness on mount, plus the login and terminal event subscriptions.
 *
 * Both the Agents tab and the first-run flow need exactly this, and the login
 * phases only make sense if one reducer owns them, so it lives here instead of
 * being rebuilt in each view.
 */
export function useHarnessConnections(): HarnessConnections {
  const [states, dispatch] = useReducer(stateReducer, initialState)
  const transcripts = useRef<Record<HarnessKind, string>>(
    Object.fromEntries(harnessKinds.map((kind) => [kind, ''])) as Record<HarnessKind, string>,
  )
  const writers = useRef<Partial<Record<HarnessKind, (data: string) => void>>>({})

  useEffect(() => {
    const removeLoginListener = window.harnesses.onLoginEvent((event) => dispatch(event))
    const removeTerminalListener = window.harnesses.onTerminalData(({ kind, data }) => {
      transcripts.current[kind] = `${transcripts.current[kind]}${data}`.slice(-32_000)
      writers.current[kind]?.(data)
    })

    void Promise.all(
      harnessKinds.map(async (kind) => {
        try {
          const detection = await window.harnesses.detect(kind)
          dispatch({ kind, action: { type: 'detected', ...detection } })
          if (!detection.found) return
          const probe = await window.harnesses.probe(kind)
          dispatch({ kind, action: { type: 'probe_finished', ...probe } })
        } catch (error) {
          dispatch({
            kind,
            action: { type: 'login_failed', error: message(error, 'Unable to check login status.') },
          })
        }
      }),
    )

    return () => {
      removeLoginListener()
      removeTerminalListener()
    }
  }, [])

  const registerWriter = useCallback((kind: HarnessKind, writer: ((data: string) => void) | null): void => {
    if (writer) writers.current[kind] = writer
    else delete writers.current[kind]
  }, [])

  const clearTranscript = useCallback((kind: HarnessKind): void => {
    transcripts.current[kind] = ''
  }, [])

  const probe = useCallback(async (kind: HarnessKind): Promise<void> => {
    dispatch({ kind, action: { type: 'probe_started' } })
    const result = await window.harnesses.probe(kind)
    dispatch({ kind, action: { type: 'probe_finished', ...result } })
  }, [])

  return { states, dispatch, transcripts, registerWriter, clearTranscript, probe }
}
