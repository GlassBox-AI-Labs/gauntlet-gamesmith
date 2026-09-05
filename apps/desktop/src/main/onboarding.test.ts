import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ONBOARDING_VERSION } from '../shared/onboarding'
import { OnboardingStore } from './onboarding'

let root: string

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'onboarding-'))
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

function storedFile(): string {
  return path.join(root, 'onboarding.json')
}

describe('OnboardingStore', () => {
  it('reports a fresh install as not onboarded', () => {
    expect(new OnboardingStore(root).read()).toEqual({
      completed: false,
      version: ONBOARDING_VERSION,
      harness: null,
      completedAt: null,
    })
  })

  it('remembers completion across store instances', () => {
    const written = new OnboardingStore(root).complete('claude')
    expect(written.completed).toBe(true)
    expect(written.harness).toBe('claude')

    const reread = new OnboardingStore(root).read()
    expect(reread.completed).toBe(true)
    expect(reread.harness).toBe('claude')
    expect(reread.completedAt).toBe(written.completedAt)
  })

  it('records completion without a connected harness', () => {
    new OnboardingStore(root).complete(null)
    expect(new OnboardingStore(root).read()).toMatchObject({ completed: true, harness: null })
  })

  it('creates the user-data directory when it does not exist yet', () => {
    const nested = path.join(root, 'missing', 'deeper')
    new OnboardingStore(nested).complete('codex')
    expect(new OnboardingStore(nested).read().harness).toBe('codex')
  })

  it('replays the flow after a reset', () => {
    const store = new OnboardingStore(root)
    store.complete('claude')
    expect(store.reset().completed).toBe(false)
    expect(store.read().completed).toBe(false)
  })

  it('treats a corrupt file as a fresh install rather than throwing', () => {
    fs.writeFileSync(storedFile(), '{ this is not json')
    expect(new OnboardingStore(root).read().completed).toBe(false)
  })

  it('ignores a record that is not an object', () => {
    fs.writeFileSync(storedFile(), '"done"')
    expect(new OnboardingStore(root).read().completed).toBe(false)
  })

  it('keeps a completed record from an unknown future version', () => {
    fs.writeFileSync(storedFile(), JSON.stringify({ completed: true, version: 99, harness: 'codex', completedAt: null }))
    const state = new OnboardingStore(root).read()
    expect(state.completed).toBe(true)
    expect(state.version).toBe(99)
    expect(state.harness).toBe('codex')
  })

  it('drops an unrecognized harness but keeps the completed flag', () => {
    fs.writeFileSync(storedFile(), JSON.stringify({ completed: true, version: 1, harness: 'kimi', completedAt: 'nope' }))
    expect(new OnboardingStore(root).read()).toEqual({
      completed: true,
      version: 1,
      harness: null,
      completedAt: null,
    })
  })

  it('does not follow a symlink when reading', () => {
    const target = path.join(root, 'elsewhere.json')
    fs.writeFileSync(target, JSON.stringify({ completed: true, version: 1, harness: 'claude', completedAt: null }))
    fs.symlinkSync(target, storedFile())
    expect(new OnboardingStore(root).read().completed).toBe(false)
  })

  it('refuses to write through a symlink', () => {
    const target = path.join(root, 'elsewhere.json')
    fs.writeFileSync(target, '{}')
    fs.symlinkSync(target, storedFile())
    expect(() => new OnboardingStore(root).complete('claude')).toThrow()
    expect(fs.readFileSync(target, 'utf8')).toBe('{}')
  })

  it('rejects a file larger than the storage limit', () => {
    fs.writeFileSync(storedFile(), `{"completed":true,"pad":"${'x'.repeat(9 * 1024)}"}`)
    expect(new OnboardingStore(root).read().completed).toBe(false)
  })
})
