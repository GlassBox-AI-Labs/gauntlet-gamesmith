import { describe, expect, it } from 'vitest'
import {
  assertHarnessKind,
  assertBuildId,
  parseLogLimit,
  parseBuildListOffset,
  parseAttemptPageOffset,
  parseAttemptPromptRequest,
  parseOptionalRound,
  parseRenameInput,
  parseStartBuildInput,
  parseTerminalInput,
  parseTerminalResize,
  renameTrustError,
} from './ipc-input'

const buildId = '123e4567-e89b-42d3-a456-426614174000'
const validStart = {
  prompt: 'Build it',
  workspaceDir: '/tmp/game',
  maxRounds: 5,
  budgetUsd: 10,
  orchestratorModel: 'claude-opus-5',
  orchestratorEffort: 'high',
  subagentModel: 'gpt-5.6-sol',
  subagentEffort: 'high',
  criticModel: 'gpt-5.6-sol',
  criticEffort: 'max',
  researchModel: null,
  researchEffort: 'medium',
  assetModel: 'claude-opus-5',
  assetEffort: 'high',
}

describe('IPC input validation', () => {
  it('accepts only declared harnesses and UUID build ids', () => {
    expect(assertHarnessKind('claude')).toBe('claude')
    expect(assertBuildId(buildId)).toBe(buildId)
    expect(() => assertHarnessKind('bash')).toThrow('Unsupported harness')
    expect(() => assertBuildId('../build')).toThrow('Invalid build id')
  })

  it('parses a complete build start without coercing values', () => {
    expect(parseStartBuildInput(validStart)).toEqual(validStart)
    expect(() => parseStartBuildInput({ ...validStart, maxRounds: '5' })).toThrow('Max rounds')
    expect(() => parseStartBuildInput({ ...validStart, budgetUsd: Number.POSITIVE_INFINITY })).toThrow('Budget')
    expect(() => parseStartBuildInput({ ...validStart, criticModel: 'unknown-model' })).toThrow('Critic model')
    expect(() => parseStartBuildInput({ ...validStart, prompt: '' })).toThrow('Goal')
    expect(parseStartBuildInput({ ...validStart, prompt: '  Build it exactly.\n' }).prompt).toBe('  Build it exactly.\n')
    expect(() => parseStartBuildInput({ ...validStart, prompt: ' \n\t ' })).toThrow('Goal')
  })

  it('bounds titles, limits, and rounds', () => {
    expect(parseRenameInput(buildId, ' New name ')).toEqual({ buildId, title: 'New name' })
    expect(parseLogLimit(99)).toBe(99)
    expect(() => parseLogLimit(9_999)).toThrow('between 1 and 2000')
    expect(() => parseLogLimit(0)).toThrow('between 1 and 2000')
    expect(parseBuildListOffset(undefined)).toBe(0)
    expect(parseBuildListOffset(100)).toBe(100)
    expect(() => parseBuildListOffset(-1)).toThrow('Build-list offset')
    expect(() => parseBuildListOffset(Number.MAX_SAFE_INTEGER)).toThrow('Build-list offset')
    expect(parseAttemptPageOffset(undefined)).toBe(0)
    expect(parseAttemptPageOffset(200)).toBe(200)
    expect(() => parseAttemptPageOffset(50_001)).toThrow('Build-page offset')
    expect(parseAttemptPromptRequest(buildId, 'implement', 2)).toEqual({ buildId, role: 'implement', round: 2 })
    expect(parseAttemptPromptRequest(buildId, 'reference', 0)).toEqual({ buildId, role: 'reference', round: 0 })
    expect(() => parseAttemptPromptRequest(buildId, 'shell', 1)).toThrow('Invalid build role')
    expect(() => parseAttemptPromptRequest(buildId, 'critique', 0)).toThrow('must be positive')
    expect(parseOptionalRound(null)).toBeNull()
    expect(parseOptionalRound(2)).toBe(2)
    expect(() => parseOptionalRound(1.5)).toThrow('Round')
  })

  it('keeps imported and pre-trust-provenance history read-only at the rename boundary', () => {
    expect(renameTrustError(false)).toMatch(/read-only/)
    expect(renameTrustError(false)).toMatch(/created before trust provenance shipped/)
    expect(renameTrustError(true)).toBeNull()
  })

  it('validates terminal payload shape and does not clamp attacker input', () => {
    expect(parseTerminalInput({ kind: 'codex', data: 'x' })).toEqual({ kind: 'codex', data: 'x' })
    expect(parseTerminalResize({ kind: 'claude', cols: 80, rows: 24 })).toEqual({ kind: 'claude', cols: 80, rows: 24 })
    expect(() => parseTerminalInput({ kind: 'codex', data: 1 })).toThrow('Invalid terminal input')
    expect(() => parseTerminalResize({ kind: 'claude', cols: '80', rows: 24 })).toThrow('Invalid terminal size')
  })
})


it.each(['ultra', 'ultracode'])('rejects %s for new builds', (orchestratorEffort) => {
  expect(() => parseStartBuildInput({ ...validStart, orchestratorEffort })).toThrow()
})
