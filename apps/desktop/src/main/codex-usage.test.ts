import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { codexTokens, readCodexUsage, usageForThread } from './codex-usage'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-home-'))
const day = new Date().toISOString().slice(0, 10)

function rollout(name: string, usages: { input: number; cached: number; output: number }[], done = false): void {
  const dir = path.join(home, 'sessions', '2026', '08', '31')
  fs.mkdirSync(dir, { recursive: true })
  const lines = usages.map((u) =>
    JSON.stringify({
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: { total_token_usage: { input_tokens: u.input, cached_input_tokens: u.cached, cache_write_input_tokens: 0, output_tokens: u.output } },
      },
    }),
  )
  if (done) lines.push(JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete', last_agent_message: 'done' } }))
  fs.writeFileSync(path.join(dir, name), `${lines.join('\n')}\n`)
}

afterAll(() => fs.rmSync(home, { recursive: true, force: true }))

describe('codexTokens', () => {
  it('does not bill the cached share twice', () => {
    // Real session: 21,176 input of which 11,008 cached, 5 out.
    expect(codexTokens({ input_tokens: 21_176, cached_input_tokens: 11_008, cache_write_input_tokens: 0, output_tokens: 5 })).toEqual({
      input: 10_168,
      output: 5,
      cacheRead: 11_008,
      cacheWrite: 0,
    })
  })

  it('normalizes malformed, negative, and non-finite stream counters to zero', () => {
    expect(codexTokens({
      input_tokens: '100',
      cached_input_tokens: -1,
      cache_write_input_tokens: Number.NaN,
      output_tokens: Number.POSITIVE_INFINITY,
    })).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
  })

  it('normalizes fractional and unsafe stream counters to zero', () => {
    expect(codexTokens({
      input_tokens: Number.MAX_SAFE_INTEGER + 1,
      cached_input_tokens: 1.25,
      cache_write_input_tokens: 2.5,
      output_tokens: 3.75,
    })).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
  })
})

describe('readCodexUsage', () => {
  it('takes the last cumulative count per session, not the sum of them', () => {
    rollout(`rollout-${day}T10-00-00-aaaabbbbcccc.jsonl`, [
      { input: 1_000, cached: 0, output: 10 },
      { input: 3_000, cached: 1_000, output: 40 },
    ])
    const agents = readCodexUsage(home, Date.now() - 60_000, 'gpt-5.6-sol')
    expect(agents).toHaveLength(1)
    expect(agents[0].tokens).toEqual({ input: 2_000, output: 40, cacheRead: 1_000, cacheWrite: 0 })
    expect(agents[0].costUsd).toBeCloseTo((2_000 * 4 + 40 * 20 + 1_000 * 0.4) / 1_000_000, 10)
    expect(agents[0].done).toBe(false)
  })

  it('ignores sessions that started before the build', () => {
    expect(readCodexUsage(home, Date.now() + 60_000, 'gpt-5.6-sol')).toEqual([])
    rollout('rollout-2020-01-01T10-00-00-oldoldoldold.jsonl', [{ input: 9_000, cached: 0, output: 900 }])
    expect(readCodexUsage(home, Date.now() - 60_000, 'gpt-5.6-sol')).toHaveLength(1)
  })

  it('uses the complete Codex thread id and reports terminal sessions done', () => {
    const id = '01995d1e-0a2b-7e01-b3c4-8b1f2a3d4e5f'
    rollout(`rollout-${day}T11-00-00-${id}.jsonl`, [{ input: 100, cached: 0, output: 10 }], true)
    const agent = readCodexUsage(home, Date.now() - 60_000, 'gpt-5.6-sol').find((item) => item.id === `codex:${id}`)
    expect(agent).toMatchObject({ id: `codex:${id}`, done: true, state: 'done' })
    expect(usageForThread(home, id)).toEqual({ input: 100, output: 10, cacheRead: 0, cacheWrite: 0 })
    expect(usageForThread(home, '../escape')).toBeNull()
  })

  it('does not follow rollout symlinks or scan an unbounded whole-file fallback', () => {
    const dir = path.join(home, 'sessions', '2026', '08', '31')
    fs.mkdirSync(dir, { recursive: true })
    const symlinkId = '33333333-3333-4333-8333-333333333333'
    const outside = path.join(home, 'outside-rollout.jsonl')
    fs.writeFileSync(outside, `${JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 999, output_tokens: 9 } } } })}\n`)
    fs.symlinkSync(outside, path.join(dir, `rollout-${day}T12-00-00-${symlinkId}.jsonl`))

    const oversizedId = '44444444-4444-4444-8444-444444444444'
    const oversized = path.join(dir, `rollout-${day}T13-00-00-${oversizedId}.jsonl`)
    fs.writeFileSync(oversized, `${JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 999, output_tokens: 9 } } } })}\n`)
    fs.appendFileSync(oversized, `${'x'.repeat(8 * 1024 * 1024 + 1)}\n`)

    const ids = readCodexUsage(home, Date.now() - 60_000, 'gpt-5.6-sol').map((agent) => agent.id)
    expect(ids).not.toContain(`codex:${symlinkId}`)
    expect(ids).not.toContain(`codex:${oversizedId}`)
  })

  it('does not follow a planted sessions-directory symlink or read hard-linked rollouts', () => {
    const linkedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-linked-home-'))
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-linked-outside-'))
    const id = '55555555-5555-4555-8555-555555555555'
    const outsideRollout = path.join(outside, `rollout-${day}T14-00-00-${id}.jsonl`)
    fs.writeFileSync(outsideRollout, `${JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 999, output_tokens: 9 } } } })}\n`)
    fs.symlinkSync(outside, path.join(linkedHome, 'sessions'))
    try {
      expect(readCodexUsage(linkedHome, Date.now() - 60_000, 'gpt-5.6-sol')).toEqual([])
      expect(usageForThread(linkedHome, id)).toBeNull()
    } finally {
      fs.rmSync(linkedHome, { recursive: true, force: true })
      fs.rmSync(outside, { recursive: true, force: true })
    }

    const hardlinkId = '66666666-6666-4666-8666-666666666666'
    const hardlinkSource = path.join(home, 'outside-hardlink-rollout.jsonl')
    fs.writeFileSync(hardlinkSource, `${JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 999, output_tokens: 9 } } } })}\n`)
    const destination = path.join(home, 'sessions', '2026', '08', '31', `rollout-${day}T15-00-00-${hardlinkId}.jsonl`)
    fs.linkSync(hardlinkSource, destination)
    expect(usageForThread(home, hardlinkId)).toBeNull()
  })

  it('caps the number of matching rollout sessions before reading their contents', () => {
    const cappedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-capped-home-'))
    const directory = path.join(cappedHome, 'sessions', '2026', '09', '02')
    fs.mkdirSync(directory, { recursive: true })
    try {
      for (let index = 0; index < 257; index += 1) {
        fs.writeFileSync(path.join(directory, `rollout-${day}T16-00-00-${String(index).padStart(12, '0')}.jsonl`), '')
      }
      expect(() => readCodexUsage(cappedHome, Date.now() - 60_000, 'gpt-5.6-sol')).toThrow(/exceeds 256 matching sessions/)
    } finally {
      fs.rmSync(cappedHome, { recursive: true, force: true })
    }
  })
})
