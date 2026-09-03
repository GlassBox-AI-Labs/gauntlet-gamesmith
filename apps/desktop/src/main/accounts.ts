import fs from 'node:fs'
import path from 'node:path'
import type { AccountsState, HarnessAccount, HarnessKind } from '../shared/harness'
import { PRIMARY_ACCOUNT_ID } from '../shared/harness'

/**
 * Both CLIs key their saved credentials to the config directory they were
 * signed in with, so moving an existing home would silently log the user out.
 * The primary account therefore keeps the original path —
 * `harnesses/<kind>` — and only extra accounts get a subfolder.
 */
export { PRIMARY_ACCOUNT_ID }

/**
 * Config-dir entries every account shares instead of keeping its own copy.
 *
 * For Claude, `projects` holds the session transcripts a run resumes from and
 * `skills` holds the scaffolded asset tools — sharing them is what lets you
 * switch accounts between rounds and still continue the same session. Codex
 * keeps nothing the app reads back, so its accounts stay fully separate.
 */
const SHARED_ENTRIES: Record<HarnessKind, readonly string[]> = {
  claude: ['projects', 'skills'],
  codex: [],
}

const ACCOUNTS_FILE = 'accounts.json'

/**
 * How long an account is treated as spent once it reports a usage limit.
 *
 * Claude's subscription limit runs on a five-hour window. The exact reset time
 * is only in the CLI's error prose, which is not worth parsing — waiting out a
 * full window is wrong by minutes at most, and only ever errs toward leaving
 * an account alone a little longer than it needed.
 */
export const LIMIT_WINDOW_MS = 5 * 60 * 60 * 1000
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/

type AccountsFile = Partial<Record<HarnessKind, AccountsState>>

export function isAccountId(value: unknown): value is string {
  return typeof value === 'string' && ID_PATTERN.test(value)
}

function defaultState(): AccountsState {
  return { activeId: PRIMARY_ACCOUNT_ID, accounts: [{ id: PRIMARY_ACCOUNT_ID, label: 'Account 1' }] }
}

function readFile(root: string): AccountsFile {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(root, ACCOUNTS_FILE), 'utf8')) as unknown
    return parsed && typeof parsed === 'object' ? (parsed as AccountsFile) : {}
  } catch {
    return {}
  }
}

/** Registered accounts for a harness, repaired if the file on disk is unusable. */
export function readAccounts(root: string, kind: HarnessKind): AccountsState {
  const stored = readFile(root)[kind]
  const accounts = (stored?.accounts ?? []).filter(
    (account): account is HarnessAccount => isAccountId(account?.id) && typeof account?.label === 'string',
  )
  if (accounts.length === 0) return defaultState()
  // The primary account is never removable, so a file missing it is corrupt.
  if (!accounts.some((account) => account.id === PRIMARY_ACCOUNT_ID)) {
    accounts.unshift({ id: PRIMARY_ACCOUNT_ID, label: 'Account 1' })
  }
  const activeId = accounts.some((account) => account.id === stored?.activeId)
    ? String(stored?.activeId)
    : PRIMARY_ACCOUNT_ID
  return { activeId, accounts }
}

export function writeAccounts(root: string, kind: HarnessKind, state: AccountsState): AccountsState {
  const file = readFile(root)
  file[kind] = state
  fs.mkdirSync(root, { recursive: true })
  fs.writeFileSync(path.join(root, ACCOUNTS_FILE), `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 })
  return state
}

/** Where a single account's credentials live. */
export function accountDir(root: string, kind: HarnessKind, accountId: string): string {
  const base = path.join(root, kind)
  return accountId === PRIMARY_ACCOUNT_ID ? base : path.join(base, 'accounts', accountId)
}

/** The transcripts and skills every account reads and writes through. */
export function sharedDir(root: string, kind: HarnessKind): string {
  return path.join(root, kind)
}

function ensureDir(dir: string): string {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  fs.chmodSync(dir, 0o700)
  return dir
}

/**
 * Create an account's config dir and point its shared entries at the harness
 * folder, so every account writes session transcripts to the same place.
 *
 * A real directory already sitting where a link belongs is left alone unless
 * it is empty — an account that has already recorded sessions of its own keeps
 * them rather than having them hidden behind a link.
 */
export function prepareAccountDir(root: string, kind: HarnessKind, accountId: string): string {
  const shared = ensureDir(sharedDir(root, kind))
  const dir = ensureDir(accountDir(root, kind, accountId))
  for (const entry of SHARED_ENTRIES[kind]) ensureDir(path.join(shared, entry))
  if (dir === shared) return dir

  for (const entry of SHARED_ENTRIES[kind]) {
    const link = path.join(dir, entry)
    try {
      if (fs.lstatSync(link).isSymbolicLink()) continue
      if (fs.readdirSync(link).length > 0) continue
      fs.rmdirSync(link)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') continue
    }
    // Relative so the links survive the app folder being moved or renamed.
    fs.symlinkSync(path.join('..', '..', entry), link, 'dir')
  }
  return dir
}

function nextAccountId(state: AccountsState): string {
  for (let n = 2; ; n += 1) {
    const id = `account-${n}`
    if (!state.accounts.some((account) => account.id === id)) return id
  }
}

/** Register a fresh, signed-out account and make it the active one. */
export function addAccount(root: string, kind: HarnessKind): AccountsState {
  const state = readAccounts(root, kind)
  const id = nextAccountId(state)
  const next: AccountsState = {
    activeId: id,
    accounts: [...state.accounts, { id, label: `Account ${state.accounts.length + 1}` }],
  }
  prepareAccountDir(root, kind, id)
  return writeAccounts(root, kind, next)
}

export function switchAccount(root: string, kind: HarnessKind, accountId: string): AccountsState {
  const state = readAccounts(root, kind)
  if (!state.accounts.some((account) => account.id === accountId)) return state
  prepareAccountDir(root, kind, accountId)
  return writeAccounts(root, kind, { ...state, activeId: accountId })
}

/**
 * Forget an extra account and delete its credentials.
 *
 * The primary account is not removable: its folder is the shared transcript
 * store, so deleting it would take every run's session history with it.
 */
export function removeAccount(root: string, kind: HarnessKind, accountId: string): AccountsState {
  const state = readAccounts(root, kind)
  if (accountId === PRIMARY_ACCOUNT_ID || !state.accounts.some((account) => account.id === accountId)) return state
  const accounts = state.accounts.filter((account) => account.id !== accountId)
  const activeId = state.activeId === accountId ? PRIMARY_ACCOUNT_ID : state.activeId
  fs.rmSync(accountDir(root, kind, accountId), { recursive: true, force: true })
  prepareAccountDir(root, kind, activeId)
  return writeAccounts(root, kind, { activeId, accounts })
}

/**
 * Read the reset time out of a CLI's own limit message.
 *
 * Both CLIs say when the window reopens — "Your limit will reset at 3pm" — and
 * that beats assuming a full window: an account with twenty minutes left on
 * its window would otherwise be parked for five hours. Returns null when the
 * message says nothing useful, and the caller falls back to the full window.
 */
export function parseResetAt(error: string, now = Date.now()): number | null {
  const match = /reset(?:s|ting)?\s+(?:at|in)?\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i.exec(error)
  if (!match) return null
  const meridiem = match[3]?.toLowerCase()
  let hour = Number(match[1])
  if (hour > 23 || (meridiem && hour > 12)) return null
  if (meridiem === 'pm' && hour < 12) hour += 12
  if (meridiem === 'am' && hour === 12) hour = 0

  const reset = new Date(now)
  reset.setHours(hour, Number(match[2] ?? 0), 0, 0)
  // A clock time already past today means tomorrow.
  if (reset.getTime() <= now) reset.setDate(reset.getDate() + 1)
  const delay = reset.getTime() - now
  return delay > LIMIT_WINDOW_MS ? null : reset.getTime()
}

/** True while an account is still inside the usage window it exhausted. */
export function isCooling(account: HarnessAccount, now = Date.now()): boolean {
  const until = account.cooldownUntil ? Date.parse(account.cooldownUntil) : NaN
  return Number.isFinite(until) && until > now
}

/** Park an account for the rest of its usage window so rotation skips it. */
export function markLimited(
  root: string,
  kind: HarnessKind,
  accountId: string,
  until = Date.now() + LIMIT_WINDOW_MS,
): AccountsState {
  const state = readAccounts(root, kind)
  const cooldownUntil = new Date(until).toISOString()
  return writeAccounts(root, kind, {
    ...state,
    accounts: state.accounts.map((account) => (account.id === accountId ? { ...account, cooldownUntil } : account)),
  })
}

/** When every account is spent, the moment the first one frees up. */
export function earliestReset(state: AccountsState, now = Date.now()): number | null {
  const times = state.accounts
    .map((account) => (account.cooldownUntil ? Date.parse(account.cooldownUntil) : NaN))
    .filter((time) => Number.isFinite(time) && time > now)
  return times.length === state.accounts.length && times.length > 0 ? Math.min(...times) : null
}

/** Signing in again means the account is usable, whatever it said before. */
export function clearCooldown(root: string, kind: HarnessKind, accountId: string): AccountsState {
  const state = readAccounts(root, kind)
  return writeAccounts(root, kind, {
    ...state,
    accounts: state.accounts.map(({ cooldownUntil, ...account }) =>
      account.id === accountId ? account : { ...account, cooldownUntil },
    ),
  })
}

/** Name the active account after the signed-in email once a probe reports one. */
export function labelAccount(root: string, kind: HarnessKind, accountId: string, label: string): AccountsState {
  const state = readAccounts(root, kind)
  const target = state.accounts.find((account) => account.id === accountId)
  if (!target || !label || target.label === label) return state
  return writeAccounts(root, kind, {
    ...state,
    accounts: state.accounts.map((account) => (account.id === accountId ? { ...account, label } : account)),
  })
}
