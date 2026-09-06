import { harnessKinds, type HarnessKind } from '../shared/harness'
import type { PhaseRole, StartBuildInput } from '../shared/build'
import { isRecordId } from '../shared/record-id'
import {
  AGENT_EFFORTS,
  AGENT_MODEL_CHOICES,
  SOLO_SUBAGENT,
} from '../shared/models'

const modelIds = new Set(AGENT_MODEL_CHOICES.map(({ id }) => id))
const agentEfforts = new Set<string>(AGENT_EFFORTS)


function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object.`)
  return value as Record<string, unknown>
}

function boundedString(value: unknown, label: string, max: number, allowEmpty = false): string {
  if (typeof value !== 'string') throw new Error(`${label} must be a string.`)
  const result = value.trim()
  if ((!allowEmpty && !result) || result.length > max) {
    throw new Error(`${label} must be ${allowEmpty ? 'at most' : 'between 1 and'} ${max} characters.`)
  }
  return result
}

function goalString(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Goal must be a string.')
  if (!value.trim() || value.length > 100_000) throw new Error('Goal must be between 1 and 100000 characters.')
  return value
}

function model(value: unknown, label: string, nullable = false): string | null {
  if (nullable && (value === null || value === SOLO_SUBAGENT)) return null
  const id = boundedString(value, label, 100)
  if (!modelIds.has(id)) throw new Error(`${label} is not supported.`)
  return id
}

function effort(value: unknown, label: string, allowed: Set<string>): string {
  const result = boundedString(value, label, 20)
  if (!allowed.has(result)) throw new Error(`${label} is not supported.`)
  return result
}

export function assertHarnessKind(value: unknown): HarnessKind {
  if (typeof value !== 'string' || !harnessKinds.includes(value as HarnessKind)) {
    throw new Error('Unsupported harness.')
  }
  return value as HarnessKind
}

/**
 * The harness recorded at the end of onboarding. Null is a real answer: it
 * means the user finished the flow without connecting one.
 */
export function parseOnboardingHarness(value: unknown): HarnessKind | null {
  if (value === null || value === undefined) return null
  return assertHarnessKind(value)
}

export function assertBuildId(value: unknown): string {
  if (!isRecordId(value)) throw new Error('Invalid build id.')
  return value
}

export function parseStartBuildInput(value: unknown): StartBuildInput {
  const input = record(value, 'Build input')
  const maxRounds = input.maxRounds
  if (typeof maxRounds !== 'number' || !Number.isInteger(maxRounds) || maxRounds < 1 || maxRounds > 100) {
    throw new Error('Max rounds must be an integer between 1 and 100.')
  }
  const budgetUsd = input.budgetUsd
  if (budgetUsd !== null && (typeof budgetUsd !== 'number' || !Number.isFinite(budgetUsd) || budgetUsd <= 0)) {
    throw new Error('Budget must be null or a positive finite number.')
  }
  if (input.referenceMode !== undefined && !['web', 'files', 'skip'].includes(input.referenceMode as string)) throw new Error('Invalid reference mode.')
  const attachmentIds = input.attachmentIds
  if (attachmentIds !== undefined && (!Array.isArray(attachmentIds) || attachmentIds.length > 100 || attachmentIds.some((id) => typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)))) throw new Error('Invalid attachment selection.')
  if (input.referenceMode === 'files' && (!Array.isArray(attachmentIds) || attachmentIds.length === 0)) throw new Error('Files-only Reference Study requires attachments.')
  return {
    ...(input.referenceMode !== undefined ? { referenceMode: input.referenceMode as StartBuildInput['referenceMode'] } : {}),
    ...(attachmentIds !== undefined ? { attachmentIds: [...new Set(attachmentIds as string[])] } : {}),
    prompt: goalString(input.prompt),
    workspaceDir: boundedString(input.workspaceDir, 'Workspace path', 8_192),
    maxRounds,
    budgetUsd,
    orchestratorModel: model(input.orchestratorModel, 'Orchestrator model')!,
    orchestratorEffort: effort(input.orchestratorEffort, 'Orchestrator effort', agentEfforts),
    subagentModel: model(input.subagentModel, 'Subagent model', true),
    subagentEffort: effort(input.subagentEffort, 'Subagent effort', agentEfforts),
    criticModel: model(input.criticModel, 'Critic model')!,
    criticEffort: effort(input.criticEffort, 'Critic effort', agentEfforts),
    researchModel: model(input.researchModel, 'Research model', true),
    researchEffort: effort(input.researchEffort, 'Research effort', agentEfforts),
    assetModel: model(input.assetModel, 'Asset model', true),
    assetEffort: effort(input.assetEffort, 'Asset effort', agentEfforts),
  }
}

export function parseRenameInput(buildId: unknown, title: unknown): { buildId: string; title: string } {
  return { buildId: assertBuildId(buildId), title: boundedString(title, 'Title', 80) }
}

export function parseDeleteBuildsInput(buildIds: unknown, deleteFiles: unknown): { buildIds: string[]; deleteFiles: boolean } {
  if (!Array.isArray(buildIds) || buildIds.length === 0 || buildIds.length > 100) {
    throw new Error('Build deletion requires between 1 and 100 build ids.')
  }
  if (typeof deleteFiles !== 'boolean') throw new Error('Delete-files flag must be a boolean.')
  return { buildIds: [...new Set(buildIds.map(assertBuildId))], deleteFiles }
}

export function renameTrustError(playTrusted: boolean): string | null {
  return playTrusted
    ? null
    : 'Untrusted history (imported or created before trust provenance shipped) is read-only and cannot be renamed.'
}

export function parseLogLimit(value: unknown): number {
  if (value === undefined) return 800
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 2_000) {
    throw new Error('Log limit must be an integer between 1 and 2000.')
  }
  return value
}

export function parseBuildListOffset(value: unknown): number {
  if (value === undefined) return 0
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > 1_000_000) {
    throw new Error('Build-list offset must be a safe integer between 0 and 1000000.')
  }
  return value
}

export function parseAttemptPageOffset(value: unknown): number {
  if (value === undefined) return 0
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > 50_000) {
    throw new Error('Build-page offset must be a safe integer between 0 and 50000.')
  }
  return value
}

export function parseAttemptPromptRequest(buildId: unknown, role: unknown, round: unknown): { buildId: string; role: PhaseRole; round: number } {
  if (role !== 'reference' && role !== 'assets' && role !== 'implement' && role !== 'critique') throw new Error('Invalid build role.')
  if (typeof round !== 'number' || !Number.isSafeInteger(round) || round < 0 || round > 10_000) {
    throw new Error('Prompt round must be an integer between 0 and 10000.')
  }
  if (role === 'reference' && round !== 0) throw new Error('Reference Study prompt round must be zero.')
  if (role !== 'reference' && round === 0) throw new Error('Asset, implementation, and critique prompt rounds must be positive.')
  return { buildId: assertBuildId(buildId), role, round }
}

export function parseOptionalRound(value: unknown): number | null {
  if (value == null) return null
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 10_000) {
    throw new Error('Round must be a positive integer.')
  }
  return value
}

export function parseTerminalInput(value: unknown): { kind: HarnessKind; data: string } {
  const input = record(value, 'Terminal input')
  if (typeof input.data !== 'string' || input.data.length > 16_384) throw new Error('Invalid terminal input.')
  return { kind: assertHarnessKind(input.kind), data: input.data }
}

export function parseTerminalResize(value: unknown): { kind: HarnessKind; cols: number; rows: number } {
  const input = record(value, 'Terminal size')
  if (
    typeof input.cols !== 'number' ||
    !Number.isInteger(input.cols) ||
    input.cols < 20 ||
    input.cols > 300 ||
    typeof input.rows !== 'number' ||
    !Number.isInteger(input.rows) ||
    input.rows < 5 ||
    input.rows > 100
  ) {
    throw new Error('Invalid terminal size.')
  }
  return { kind: assertHarnessKind(input.kind), cols: input.cols, rows: input.rows }
}
