import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { codexTokens, readCodexUsage } from './codex-usage'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-home-'))
const day = new Date().toISOString().slice(0, 10)

function rollout(name: string, usages: { input: number; cached: number; output: number }[]): void {
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
  })

  it('ignores sessions that started before the run', () => {
    expect(readCodexUsage(home, Date.now() + 60_000, 'gpt-5.6-sol')).toEqual([])
    rollout('rollout-2020-01-01T10-00-00-oldoldoldold.jsonl', [{ input: 9_000, cached: 0, output: 900 }])
    expect(readCodexUsage(home, Date.now() - 60_000, 'gpt-5.6-sol')).toHaveLength(1)
  })
})
