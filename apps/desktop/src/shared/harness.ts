export const harnessKinds = ['claude', 'codex'] as const

export type HarnessKind = (typeof harnessKinds)[number]
export type LoginPhase =
  | 'checking'
  | 'not_found'
  | 'logged_out'
  | 'signing_in'
  | 'awaiting_browser'
  | 'logged_in'
  | 'error'

export type HarnessDetail = readonly [label: string, value: string]

export interface HarnessState {
  kind: HarnessKind
  label: string
  phase: LoginPhase
  found: boolean
  version: string | null
  authMethod: string | null
  details: HarnessDetail[]
  url: string | null
  error: string | null
}

export type HarnessAction =
  | { type: 'detected'; found: boolean; version?: string | null; error?: string | null }
  | { type: 'probe_started' }
  | {
      type: 'probe_finished'
      loggedIn: boolean
      authMethod?: string | null
      details?: HarnessDetail[]
      error?: string | null
    }
  | { type: 'login_started' }
  | { type: 'login_url'; url: string }
  | { type: 'login_cancelled' }
  | { type: 'login_failed'; error: string }

export interface DetectionResult {
  found: boolean
  version: string | null
  error: string | null
}

export interface ProbeResult {
  loggedIn: boolean
  authMethod?: string | null
  details?: HarnessDetail[]
  error?: string | null
}

export interface LoginEvent {
  kind: HarnessKind
  action: HarnessAction
}

export interface TerminalDataEvent {
  kind: HarnessKind
  data: string
}

export interface HarnessApi {
  detect(kind: HarnessKind): Promise<DetectionResult>
  probe(kind: HarnessKind): Promise<ProbeResult>
  startLogin(kind: HarnessKind): Promise<void>
  cancelLogin(kind: HarnessKind): Promise<void>
  writeTerminal(kind: HarnessKind, data: string): void
  resizeTerminal(kind: HarnessKind, cols: number, rows: number): void
  onLoginEvent(listener: (event: LoginEvent) => void): () => void
  onTerminalData(listener: (event: TerminalDataEvent) => void): () => void
}
