import { describe, expect, it } from 'vitest'
import {
  assertHarnessKind,
  assertLoopId,
  parseLogLimit,
  parseLoopListOffset,
  parseRunPageOffset,
  parseRunPromptRequest,
  parseOptionalRound,
  parseRenameInput,
  parseStartLoopInput,
  parseTerminalInput,
  parseTerminalResize,
  renameTrustError,
} from './ipc-input'

const loopId = '123e4567-e89b-42d3-a456-426614174000'
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
  it('accepts only declared harnesses and UUID loop ids', () => {
    expect(assertHarnessKind('claude')).toBe('claude')
    expect(assertLoopId(loopId)).toBe(loopId)
    expect(() => assertHarnessKind('bash')).toThrow('Unsupported harness')
    expect(() => assertLoopId('../loop')).toThrow('Invalid loop id')
  })

  it('parses a complete loop start without coercing values', () => {
    expect(parseStartLoopInput(validStart)).toEqual(validStart)
    expect(() => parseStartLoopInput({ ...validStart, maxRounds: '5' })).toThrow('Max rounds')
    expect(() => parseStartLoopInput({ ...validStart, budgetUsd: Number.POSITIVE_INFINITY })).toThrow('Budget')
    expect(() => parseStartLoopInput({ ...validStart, criticModel: 'unknown-model' })).toThrow('Critic model')
    expect(() => parseStartLoopInput({ ...validStart, prompt: '' })).toThrow('Goal')
    expect(parseStartLoopInput({ ...validStart, prompt: '  Build it exactly.\n' }).prompt).toBe('  Build it exactly.\n')
    expect(() => parseStartLoopInput({ ...validStart, prompt: ' \n\t ' })).toThrow('Goal')
  })

  it('bounds titles, limits, and rounds', () => {
    expect(parseRenameInput(loopId, ' New name ')).toEqual({ loopId, title: 'New name' })
    expect(parseLogLimit(99)).toBe(99)
    expect(() => parseLogLimit(9_999)).toThrow('between 1 and 2000')
    expect(() => parseLogLimit(0)).toThrow('between 1 and 2000')
    expect(parseLoopListOffset(undefined)).toBe(0)
    expect(parseLoopListOffset(100)).toBe(100)
    expect(() => parseLoopListOffset(-1)).toThrow('Loop-list offset')
    expect(() => parseLoopListOffset(Number.MAX_SAFE_INTEGER)).toThrow('Loop-list offset')
    expect(parseRunPageOffset(undefined)).toBe(0)
    expect(parseRunPageOffset(200)).toBe(200)
    expect(() => parseRunPageOffset(50_001)).toThrow('Run-page offset')
    expect(parseRunPromptRequest(loopId, 'implement', 2)).toEqual({ loopId, role: 'implement', round: 2 })
    expect(parseRunPromptRequest(loopId, 'reference', 0)).toEqual({ loopId, role: 'reference', round: 0 })
    expect(() => parseRunPromptRequest(loopId, 'shell', 1)).toThrow('Invalid run role')
    expect(() => parseRunPromptRequest(loopId, 'critique', 0)).toThrow('must be positive')
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


it.each(['ultra', 'ultracode'])('rejects %s for new runs', (orchestratorEffort) => {
  expect(() => parseStartLoopInput({ ...validStart, orchestratorEffort })).toThrow()
})
