import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PRIMARY_ACCOUNT_ID } from '../shared/harness'
import {
  accountDir,
  addAccount,
  clearCooldown,
  earliestReset,
  isAccountId,
  isCooling,
  LIMIT_WINDOW_MS,
  markLimited,
  parseResetAt,
  labelAccount,
  prepareAccountDir,
  readAccounts,
  removeAccount,
  switchAccount,
} from './accounts'

let root: string

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'gamesmith-accounts-'))
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('harness accounts', () => {
  it('starts with one account living at the original harness folder', () => {
    const state = readAccounts(root, 'claude')

    expect(state.activeId).toBe(PRIMARY_ACCOUNT_ID)
    expect(state.accounts).toHaveLength(1)
    // Moving this folder would drop the saved login, so it has to stay put.
    expect(accountDir(root, 'claude', PRIMARY_ACCOUNT_ID)).toBe(path.join(root, 'claude'))
  })

  it('gives an added account its own folder that shares transcripts and skills', () => {
    prepareAccountDir(root, 'claude', PRIMARY_ACCOUNT_ID)
    fs.writeFileSync(path.join(root, 'claude', 'projects', 'session.jsonl'), '{}\n')

    const state = addAccount(root, 'claude')
    const dir = accountDir(root, 'claude', state.activeId)

    expect(state.activeId).not.toBe(PRIMARY_ACCOUNT_ID)
    expect(fs.lstatSync(path.join(dir, 'projects')).isSymbolicLink()).toBe(true)
    // The whole point: the second account can resume the first one's session.
    expect(fs.readFileSync(path.join(dir, 'projects', 'session.jsonl'), 'utf8')).toBe('{}\n')
    expect(fs.lstatSync(path.join(dir, 'skills')).isSymbolicLink()).toBe(true)
  })

  it('keeps credentials apart even though transcripts are shared', () => {
    const second = addAccount(root, 'claude').activeId
    const primaryDir = prepareAccountDir(root, 'claude', PRIMARY_ACCOUNT_ID)
    const secondDir = prepareAccountDir(root, 'claude', second)
    fs.writeFileSync(path.join(primaryDir, '.credentials.json'), 'first')

    expect(fs.existsSync(path.join(secondDir, '.credentials.json'))).toBe(false)
  })

  it('switches the active account and remembers it', () => {
    const second = addAccount(root, 'claude').activeId
    switchAccount(root, 'claude', PRIMARY_ACCOUNT_ID)

    expect(readAccounts(root, 'claude').activeId).toBe(PRIMARY_ACCOUNT_ID)

    switchAccount(root, 'claude', second)

    expect(readAccounts(root, 'claude').activeId).toBe(second)
  })

  it('ignores a switch to an account that does not exist', () => {
    expect(switchAccount(root, 'claude', 'account-9').activeId).toBe(PRIMARY_ACCOUNT_ID)
  })

  it('keeps codex accounts fully separate, since nothing is read back from them', () => {
    const second = addAccount(root, 'codex').activeId
    const dir = accountDir(root, 'codex', second)

    expect(fs.existsSync(dir)).toBe(true)
    expect(fs.existsSync(path.join(dir, 'projects'))).toBe(false)
  })

  it('keeps each harness on its own account list', () => {
    addAccount(root, 'claude')

    expect(readAccounts(root, 'codex').accounts).toHaveLength(1)
    expect(readAccounts(root, 'claude').accounts).toHaveLength(2)
  })

  it('removes an extra account and falls back to the primary one', () => {
    const second = addAccount(root, 'claude').activeId
    const dir = accountDir(root, 'claude', second)
    const state = removeAccount(root, 'claude', second)

    expect(state.activeId).toBe(PRIMARY_ACCOUNT_ID)
    expect(state.accounts).toHaveLength(1)
    expect(fs.existsSync(dir)).toBe(false)
  })

  it('refuses to remove the primary account, which holds the shared history', () => {
    prepareAccountDir(root, 'claude', PRIMARY_ACCOUNT_ID)
    fs.writeFileSync(path.join(root, 'claude', 'projects', 'session.jsonl'), '{}\n')

    const state = removeAccount(root, 'claude', PRIMARY_ACCOUNT_ID)

    expect(state.accounts).toHaveLength(1)
    expect(fs.existsSync(path.join(root, 'claude', 'projects', 'session.jsonl'))).toBe(true)
  })

  it('renames an account once a probe reports its email', () => {
    labelAccount(root, 'claude', PRIMARY_ACCOUNT_ID, 'first@example.com')

    expect(readAccounts(root, 'claude').accounts[0].label).toBe('first@example.com')
  })

  it('rebuilds a corrupt account file rather than losing the harness', () => {
    fs.writeFileSync(path.join(root, 'accounts.json'), 'not json')

    expect(readAccounts(root, 'claude').activeId).toBe(PRIMARY_ACCOUNT_ID)
  })

  it('bounds the private account registry before parsing it', () => {
    fs.writeFileSync(path.join(root, 'accounts.json'), ' '.repeat(64 * 1024 + 1))

    expect(readAccounts(root, 'claude')).toEqual({
      activeId: PRIMARY_ACCOUNT_ID,
      accounts: [{ id: PRIMARY_ACCOUNT_ID, label: 'Account 1' }],
    })
  })

  it('refuses to write through a forged account-registry symlink', () => {
    const outside = path.join(root, 'outside.json')
    fs.writeFileSync(outside, 'outside bytes')
    fs.symlinkSync(outside, path.join(root, 'accounts.json'))

    expect(() => markLimited(root, 'claude', PRIMARY_ACCOUNT_ID)).toThrow()
    expect(fs.readFileSync(outside, 'utf8')).toBe('outside bytes')
  })

  it('falls back to the primary account when the stored active one is gone', () => {
    fs.writeFileSync(
      path.join(root, 'accounts.json'),
      JSON.stringify({ claude: { activeId: 'account-7', accounts: [{ id: PRIMARY_ACCOUNT_ID, label: 'Account 1' }] } }),
    )

    expect(readAccounts(root, 'claude').activeId).toBe(PRIMARY_ACCOUNT_ID)
  })

  it('rejects ids that would escape the harness folder', () => {
    expect(isAccountId('account-2')).toBe(true)
    expect(isAccountId('../../etc')).toBe(false)
    expect(isAccountId('a/b')).toBe(false)
  })

  it('leaves an account its own transcripts when it already has some', () => {
    const second = addAccount(root, 'claude').activeId
    const dir = accountDir(root, 'claude', second)
    fs.rmSync(path.join(dir, 'projects'))
    fs.mkdirSync(path.join(dir, 'projects'))
    fs.writeFileSync(path.join(dir, 'projects', 'own.jsonl'), '{}\n')

    prepareAccountDir(root, 'claude', second)

    expect(fs.lstatSync(path.join(dir, 'projects')).isSymbolicLink()).toBe(false)
    expect(fs.existsSync(path.join(dir, 'projects', 'own.jsonl'))).toBe(true)
  })

  it('refuses a forged shared-directory link that escapes the harness store', () => {
    prepareAccountDir(root, 'claude', PRIMARY_ACCOUNT_ID)
    const account = path.join(root, 'claude', 'accounts', 'account-2')
    const outside = path.join(root, 'outside')
    fs.mkdirSync(account, { recursive: true })
    fs.mkdirSync(outside)
    fs.symlinkSync(outside, path.join(account, 'projects'))

    expect(() => addAccount(root, 'claude')).toThrow(/outside the harness store/i)
  })

  it('parks a limited account for its usage window', () => {
    const now = Date.parse('2026-09-02T12:00:00.000Z')
    markLimited(root, 'claude', PRIMARY_ACCOUNT_ID, now + LIMIT_WINDOW_MS)
    const [primary] = readAccounts(root, 'claude').accounts

    expect(isCooling(primary, now)).toBe(true)
    // Four hours in it is still spent; five hours on it is usable again.
    expect(isCooling(primary, now + 4 * 60 * 60 * 1000)).toBe(true)
    expect(isCooling(primary, now + LIMIT_WINDOW_MS + 1)).toBe(false)
  })

  it('treats an account with no cooldown as usable', () => {
    expect(isCooling({ id: PRIMARY_ACCOUNT_ID, label: 'Account 1' })).toBe(false)
    expect(isCooling({ id: 'account-2', label: 'x', cooldownUntil: 'not a date' })).toBe(false)
  })

  it('parks only the account that hit the limit', () => {
    const second = addAccount(root, 'claude').activeId
    markLimited(root, 'claude', second)
    const state = readAccounts(root, 'claude')

    expect(isCooling(state.accounts.find((a) => a.id === second)!)).toBe(true)
    expect(isCooling(state.accounts.find((a) => a.id === PRIMARY_ACCOUNT_ID)!)).toBe(false)
  })

  it('frees a parked account when it signs in again', () => {
    markLimited(root, 'claude', PRIMARY_ACCOUNT_ID)
    clearCooldown(root, 'claude', PRIMARY_ACCOUNT_ID)

    expect(isCooling(readAccounts(root, 'claude').accounts[0])).toBe(false)
  })

  it('keeps the cooldown through a switch and a rename', () => {
    const second = addAccount(root, 'claude').activeId
    markLimited(root, 'claude', second)
    switchAccount(root, 'claude', PRIMARY_ACCOUNT_ID)
    labelAccount(root, 'claude', PRIMARY_ACCOUNT_ID, 'first@example.com')
    const state = readAccounts(root, 'claude')

    expect(isCooling(state.accounts.find((a) => a.id === second)!)).toBe(true)
  })

  it('takes the reset time from the CLI message instead of assuming a full window', () => {
    const now = Date.parse('2026-09-02T14:30:00')
    const at3pm = parseResetAt('Claude usage limit reached. Your limit will reset at 3pm.', now)

    expect(at3pm).toBe(Date.parse('2026-09-02T15:00:00'))
    // Half an hour, not the five hours a blind window would have cost.
    expect(at3pm! - now).toBe(30 * 60 * 1000)
  })

  it('reads the reset time out of the message Claude Code actually prints', () => {
    const now = Date.parse('2026-09-03T01:00:00')
    const real = "You've hit your session limit · resets 3:20am (America/Chicago)"

    expect(parseResetAt(real, now)).toBe(Date.parse('2026-09-03T03:20:00'))
  })

  it('reads the clock formats the CLIs use', () => {
    const now = Date.parse('2026-09-02T10:00:00')

    expect(parseResetAt('resets at 11:45am', now)).toBe(Date.parse('2026-09-02T11:45:00'))
    expect(parseResetAt('limit will reset at 14:20', now)).toBe(Date.parse('2026-09-02T14:20:00'))
    expect(parseResetAt('reset at 12am', Date.parse('2026-09-02T21:00:00'))).toBe(
      Date.parse('2026-09-03T00:00:00'),
    )
  })

  it('gives up on a message with no usable time', () => {
    expect(parseResetAt('rate limit exceeded')).toBeNull()
    expect(parseResetAt('reset at 33pm')).toBeNull()
    // A time so far out it cannot be this window is not worth trusting: 9am
    // read at 10am means tomorrow, 23 hours away.
    expect(parseResetAt('reset at 9am', Date.parse('2026-09-02T10:00:00'))).toBeNull()
    expect(parseResetAt('reset at 12am', Date.parse('2026-09-02T10:00:00'))).toBeNull()
  })

  it('reports when the first account frees up, only once all are spent', () => {
    const second = addAccount(root, 'claude').activeId
    const now = Date.parse('2026-09-02T12:00:00.000Z')
    markLimited(root, 'claude', second, now + 60_000)

    // One account still usable: nothing to wait for.
    expect(earliestReset(readAccounts(root, 'claude'), now)).toBeNull()

    markLimited(root, 'claude', PRIMARY_ACCOUNT_ID, now + 600_000)

    expect(earliestReset(readAccounts(root, 'claude'), now)).toBe(now + 60_000)
  })
})
