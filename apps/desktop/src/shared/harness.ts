export const harnessKinds = ['claude', 'codex'] as const

export type HarnessKind = (typeof harnessKinds)[number]

export const HARNESS_LABELS: Record<HarnessKind, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
}
export type LoginPhase =
  | 'checking'
  | 'not_found'
  | 'installing'
  | 'logged_out'
  | 'signing_in'
  | 'awaiting_browser'
  | 'logged_in'
  | 'signing_out'
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
  | { type: 'install_started' }
  | { type: 'install_failed'; error: string }
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
  | { type: 'logout_started' }
  | { type: 'logout_failed'; error: string }

/** Whether the app can install this CLI here, and what it would run. */
export interface InstallOffer {
  available: boolean
  /** The exact command, shown before it runs and as the copy-paste fallback. */
  command: string | null
}

export interface DetectionResult {
  found: boolean
  version: string | null
  error: string | null
}

export interface ProbeResult {
  loggedIn: boolean
  billingMode?: 'subscription' | 'api_key' | 'unknown'
  authMethod?: string | null
  details?: HarnessDetail[]
  error?: string | null
}

/**
 * The account that owns the harness folder itself, and so the shared session
 * transcripts. It can be signed out of, but never removed.
 */
export const PRIMARY_ACCOUNT_ID = 'primary'

export interface HarnessAccount {
  id: string
  label: string
  /** Set when the account reports a usage limit; it is skipped until then. */
  cooldownUntil?: string
}

export interface AccountsState {
  activeId: string
  accounts: HarnessAccount[]
}

export interface LogoutResult {
  ok: boolean
  error?: string
}

/** The result of moving off a usage-limited account onto the next one. */
export interface AccountRotation {
  ok: boolean
  from: string
  to?: string
  reason?: string
  /** When every account is spent, the epoch ms the first one frees up. */
  resetAt?: number
}

/** An account change, or the reason it was refused. */
export interface AccountsResult {
  ok: boolean
  state: AccountsState
  error?: string
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
  installOffer(kind: HarnessKind): Promise<InstallOffer>
  startInstall(kind: HarnessKind): Promise<void>
  startLogin(kind: HarnessKind): Promise<void>
  cancelLogin(kind: HarnessKind): Promise<void>
  logout(kind: HarnessKind): Promise<LogoutResult>
  accounts(kind: HarnessKind): Promise<AccountsState>
  addAccount(kind: HarnessKind): Promise<AccountsResult>
  switchAccount(kind: HarnessKind, accountId: string): Promise<AccountsResult>
  removeAccount(kind: HarnessKind, accountId: string): Promise<AccountsResult>
  writeTerminal(kind: HarnessKind, data: string): void
  resizeTerminal(kind: HarnessKind, cols: number, rows: number): void
  onLoginEvent(listener: (event: LoginEvent) => void): () => void
  onAccountsChanged(listener: (kind: HarnessKind) => void): () => void
  onTerminalData(listener: (event: TerminalDataEvent) => void): () => void
}
