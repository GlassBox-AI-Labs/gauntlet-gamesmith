import fs from 'node:fs'
import path from 'node:path'
import type { AccountsState, HarnessAccount, HarnessKind } from '../shared/harness'
import { PRIMARY_ACCOUNT_ID } from '../shared/harness'
import { isIsoTimestamp } from '../shared/persisted-data'
import { readExactFileDescriptor } from './bounded-fd'

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
 * For Claude, `projects` holds the session transcripts a build resumes from and
 * `skills` holds the scaffolded asset tools — sharing them is what lets you
 * switch accounts between rounds and still continue the same session. Codex
 * keeps nothing the app reads back, so its accounts stay fully separate.
 */
const SHARED_ENTRIES: Record<HarnessKind, readonly string[]> = {
  claude: ['projects', 'skills'],
  codex: [],
}

const ACCOUNTS_FILE = 'accounts.json'
const MAX_ACCOUNTS_FILE_BYTES = 64 * 1024
const MAX_ACCOUNTS_PER_HARNESS = 32
const MAX_ACCOUNT_LABEL_LENGTH = 256

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
  let descriptor: number | null = null
  try {
    const filePath = path.join(root, ACCOUNTS_FILE)
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
    ) return {}
    const parsed = JSON.parse(readExactFileDescriptor(descriptor, opened.size, MAX_ACCOUNTS_FILE_BYTES, 'Account registry').toString('utf8')) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as AccountsFile : {}
  } catch {
    return {}
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor)
  }
}

/** Registered accounts for a harness, repaired if the file on disk is unusable. */
export function readAccounts(root: string, kind: HarnessKind): AccountsState {
  const stored = readFile(root)[kind]
  const candidates = stored && typeof stored === 'object' && Array.isArray(stored.accounts)
    ? stored.accounts.slice(0, MAX_ACCOUNTS_PER_HARNESS)
    : []
  const seen = new Set<string>()
  const accounts = candidates.filter((account): account is HarnessAccount => {
    if (
      !account
      || typeof account !== 'object'
      || !isAccountId(account.id)
      || seen.has(account.id)
      || typeof account.label !== 'string'
      || account.label.length === 0
      || account.label.length > MAX_ACCOUNT_LABEL_LENGTH
      || (account.cooldownUntil !== undefined && !isIsoTimestamp(account.cooldownUntil))
    ) return false
    seen.add(account.id)
    return true
  })
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
  if (
    state.accounts.length === 0
    || state.accounts.length > MAX_ACCOUNTS_PER_HARNESS
    || !state.accounts.some((account) => account.id === state.activeId)
    || state.accounts.some((account) =>
      !isAccountId(account.id)
      || typeof account.label !== 'string'
      || account.label.length === 0
      || account.label.length > MAX_ACCOUNT_LABEL_LENGTH
      || (account.cooldownUntil !== undefined && !isIsoTimestamp(account.cooldownUntil)),
    )
  ) throw new Error('Refusing to persist an invalid account registry state.')
  const file = readFile(root)
  file[kind] = state
  ensureRoot(root)
  const target = path.join(root, ACCOUNTS_FILE)
  const body = Buffer.from(`${JSON.stringify(file, null, 2)}\n`, 'utf8')
  if (body.length > MAX_ACCOUNTS_FILE_BYTES) throw new Error('Account registry exceeds its storage limit.')
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
    ) throw new Error('Account registry is not a unique regular file.')
    fs.ftruncateSync(descriptor, 0)
    fs.writeFileSync(descriptor, body)
    fs.fchmodSync(descriptor, 0o600)
    fs.fsyncSync(descriptor)
  } finally {
    fs.closeSync(descriptor)
  }
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

function ensureRoot(root: string): string {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 })
  const resolved = path.resolve(root)
  const stat = fs.lstatSync(resolved)
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('Harness account root must be a real directory.')
  }
  const canonical = fs.realpathSync(resolved)
  fs.chmodSync(canonical, 0o700)
  return canonical
}

function ensureTree(root: string, segments: readonly string[]): string {
  const canonicalRoot = ensureRoot(root)
  let current = canonicalRoot
  for (const segment of segments) {
    if (!isAccountId(segment) && !SHARED_ENTRIES.claude.includes(segment) && segment !== 'accounts' && segment !== 'claude' && segment !== 'codex') {
      throw new Error('Invalid harness account directory segment.')
    }
    current = path.join(current, segment)
    try {
      const stat = fs.lstatSync(current)
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Harness account path must contain only real directories.')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      fs.mkdirSync(current, { mode: 0o700 })
    }
    if (fs.realpathSync(current) !== current) throw new Error('Harness account path escaped its private root.')
    fs.chmodSync(current, 0o700)
  }
  return current
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
  if (!isAccountId(accountId)) throw new Error('Invalid account id.')
  const shared = ensureTree(root, [kind])
  const dir = accountId === PRIMARY_ACCOUNT_ID ? shared : ensureTree(root, [kind, 'accounts', accountId])
  for (const entry of SHARED_ENTRIES[kind]) ensureTree(root, [kind, entry])
  if (dir === shared) return dir

  for (const entry of SHARED_ENTRIES[kind]) {
    const link = path.join(dir, entry)
    let existing: fs.Stats | null = null
    try {
      existing = fs.lstatSync(link)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    if (existing?.isSymbolicLink()) {
      if (fs.realpathSync(link) !== path.join(shared, entry)) throw new Error('Shared account link points outside the harness store.')
      continue
    }
    if (existing) {
      if (!existing.isDirectory()) throw new Error('Shared account entry is neither a real directory nor the expected link.')
      if (fs.readdirSync(link).length > 0) continue
      fs.rmdirSync(link)
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
  if (state.accounts.length >= MAX_ACCOUNTS_PER_HARNESS) return state
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
 * store, so deleting it would take every build's session history with it.
 */
export function removeAccount(root: string, kind: HarnessKind, accountId: string): AccountsState {
  const state = readAccounts(root, kind)
  if (accountId === PRIMARY_ACCOUNT_ID || !state.accounts.some((account) => account.id === accountId)) return state
  const accounts = state.accounts.filter((account) => account.id !== accountId)
  const activeId = state.activeId === accountId ? PRIMARY_ACCOUNT_ID : state.activeId
  const target = accountDir(root, kind, accountId)
  try {
    const targetStat = fs.lstatSync(target)
    const expected = path.join(fs.realpathSync(root), kind, 'accounts', accountId)
    if (!targetStat.isDirectory() || targetStat.isSymbolicLink() || fs.realpathSync(target) !== expected) {
      throw new Error('Refusing to remove an unsafe account directory.')
    }
    fs.rmSync(target, { recursive: true, force: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
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
  const safeLabel = label.trim().slice(0, MAX_ACCOUNT_LABEL_LENGTH)
  if (!target || !safeLabel || target.label === safeLabel) return state
  return writeAccounts(root, kind, {
    ...state,
    accounts: state.accounts.map((account) => (account.id === accountId ? { ...account, label: safeLabel } : account)),
  })
}
