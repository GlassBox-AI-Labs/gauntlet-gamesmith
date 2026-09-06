import type { OperationResult } from './result'
import { isRecordId } from './record-id'
import { MAX_CONTEXT_FILE_BYTES } from './attachments'
import { AGENT_MODEL_CHOICES, isCodexModel, MODEL_IDS } from './models'

export const MAX_STEERING_MESSAGE = 12_000
export const MAX_STEERING_FILES = 10
export const DEFAULT_STEERING_MODEL = MODEL_IDS.codexSol
export const STEERING_MODEL_CHOICES = AGENT_MODEL_CHOICES.filter(choice => isCodexModel(choice.id))
export function steeringModel(value: unknown): string {
  if (typeof value !== 'string' || !STEERING_MODEL_CHOICES.some(choice => choice.id === value)) throw new Error('Choose a supported Codex steering model.')
  return value
}
export interface SteeringAttachment {
  id: string
  sourceId: string
  name: string
  kind: 'image' | 'file'
  path: string
  bytes: number
  sha256: string
}
export interface SteeringAssetChange {
  target: string
  operation: 'sculpt' | 'use-file'
  attachmentIds: string[]
}
export interface SteeringMessage {
  id: string
  buildId: string
  role: 'user' | 'assistant' | 'system'
  content: string
  createdAt: string
  attemptId: string | null
  attachments?: SteeringAttachment[]
}
export interface SteeringDirective {
  id: string
  buildId: string
  messageId: string
  text: string
  sourceMessageIds: string[]
  attachmentIds?: string[]
  assetChanges?: SteeringAssetChange[]
  withdrawn: boolean
  firstAttemptId: string | null
  firstRound: number | null
}
export interface RequirementSnapshot {
  implementationAttemptId: string
  directives: Pick<SteeringDirective, 'id' | 'text' | 'attachmentIds' | 'assetChanges'>[]
  attachments?: SteeringAttachment[]
  /** Asset work accepted for this round; persistent requirements do not rebuild on every round. */
  assetWork?: SteeringAssetChange[]
}
export interface SteeringState {
  buildId: string
  model: string
  messages: SteeringMessage[]
  directives: SteeringDirective[]
  busy: boolean
}
export interface SteeringApi {
  history(buildId: string): Promise<OperationResult<SteeringState>>
  setModel(input: { buildId: string; model: string }): Promise<OperationResult<SteeringState>>
  send(input: { buildId: string; messageId: string; content: string; attachmentIds?: string[] }): Promise<OperationResult<SteeringState>>
  preview(input: { buildId: string; attachmentId: string }): Promise<OperationResult<string>>
  cancel(buildId: string): Promise<OperationResult<void>>
  withdraw(input: { buildId: string; directiveId: string }): Promise<OperationResult<SteeringState>>
  onUpdate(listener: (state: SteeringState) => void): () => void
}
export function steeringId(value: unknown): string {
  if (typeof value !== 'string' || !/^[\w-]{1,100}$/.test(value)) throw new Error('Invalid run or message ID.')
  return value
}
export function steeringIds(value: unknown, limit = 100): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > limit) throw new Error('Invalid steering attachment list.')
  const result = value.map(steeringId)
  if (new Set(result).size !== result.length) throw new Error('Duplicate steering IDs.')
  return result
}
export function steeringInput(value: unknown): { buildId: string; messageId: string; content: string; attachmentIds: string[] } {
  if (!value || typeof value !== 'object') throw new Error('Invalid steering message.')
  const raw = value as Record<string, unknown>, attachmentIds = steeringIds(raw.attachmentIds, MAX_STEERING_FILES)
  if (typeof raw.content !== 'string' || (!raw.content.trim() && !attachmentIds.length) || raw.content.length > MAX_STEERING_MESSAGE) throw new Error('Add a message or attachment (up to 12,000 characters and 10 files).')
  return { buildId: steeringId(raw.buildId), messageId: steeringId(raw.messageId), content: raw.content.trim(), attachmentIds }
}
export function steeringAttachments(value: unknown, buildId: string): SteeringAttachment[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 100) throw new Error('Invalid stored steering attachments.')
  const files = value.map(raw => {
    if (!raw || typeof raw !== 'object') throw new Error('Invalid stored steering attachment.')
    const file = raw as SteeringAttachment
    if (!isRecordId(file.id) || !isRecordId(file.sourceId) || typeof file.name !== 'string' || !file.name || file.name.length > 240 || !['image', 'file'].includes(file.kind) || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || file.bytes > MAX_CONTEXT_FILE_BYTES || typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error('Invalid stored steering attachment.')
    const prefix = `.gauntlet-gamesmith/steering/${buildId}/${file.id}/`
    if (typeof file.path !== 'string' || !file.path.startsWith(prefix) || !/^[a-zA-Z0-9_-][a-zA-Z0-9._-]{0,119}$/.test(file.path.slice(prefix.length))) throw new Error('Invalid stored steering attachment path.')
    return { id: file.id, sourceId: file.sourceId, name: file.name, kind: file.kind, path: file.path, bytes: file.bytes, sha256: file.sha256 }
  })
  if (new Set(files.map(file => file.id)).size !== files.length) throw new Error('Duplicate stored steering attachments.')
  return files
}
export function steeringAssetChanges(value: unknown): SteeringAssetChange[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 100) throw new Error('Invalid steering asset work.')
  return value.map(raw => {
    if (!raw || typeof raw !== 'object') throw new Error('Invalid steering asset change.')
    const change = raw as SteeringAssetChange
    if (typeof change.target !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(change.target) || change.target.length > 64 || !['sculpt', 'use-file'].includes(change.operation)) throw new Error('Invalid steering asset target.')
    return { target: change.target, operation: change.operation, attachmentIds: steeringIds(change.attachmentIds) }
  })
}
export interface SteeringReply {
  reply: string
  directives: { text: string; sourceMessageIds: string[]; attachmentIds?: string[]; assetChanges?: SteeringAssetChange[] }[]
}
export const STEERING_REPLY_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['reply', 'directives'], properties: {
    reply: { type: 'string' }, directives: { type: 'array', items: {
      type: 'object', additionalProperties: false, required: ['text', 'sourceMessageIds', 'attachmentIds', 'assetChanges'], properties: {
        text: { type: 'string' }, sourceMessageIds: { type: 'array', items: { type: 'string' } }, attachmentIds: { type: 'array', items: { type: 'string' } },
        assetChanges: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['target', 'operation', 'attachmentIds'], properties: {
          target: { type: 'string' }, operation: { type: 'string', enum: ['sculpt', 'use-file'] }, attachmentIds: { type: 'array', items: { type: 'string' } },
        } } },
      },
    } },
  },
}
export function parseSteeringReply(text: string, userMessageIds: Set<string>, messages: SteeringMessage[] = []): SteeringReply {
  const value = JSON.parse(text) as SteeringReply
  if (!value || typeof value.reply !== 'string' || !value.reply.trim() || value.reply.length > 16000 || !Array.isArray(value.directives) || value.directives.length > 12) throw new Error('The chat agent returned an invalid response. Please retry.')
  const directives = value.directives.map(directive => {
    if (!directive || typeof directive.text !== 'string' || !directive.text.trim() || directive.text.length > 6000) throw new Error('The chat agent returned an invalid direction. Please retry.')
    const sourceMessageIds = steeringIds(directive.sourceMessageIds)
    if (!sourceMessageIds.length || sourceMessageIds.some(id => !userMessageIds.has(id))) throw new Error('The chat agent returned an invalid direction source. Please retry.')
    const attachmentIds = steeringIds(directive.attachmentIds), assetChanges = steeringAssetChanges(directive.assetChanges)
    const allowed = new Set(messages.filter(message => message.role === 'user' && sourceMessageIds.includes(message.id)).flatMap(message => message.attachments?.map(file => file.id) ?? []))
    if (attachmentIds.some(id => !allowed.has(id)) || assetChanges.some(change => change.attachmentIds.some(id => !attachmentIds.includes(id)) || (change.operation === 'use-file' && !change.attachmentIds.length))) throw new Error('The chat agent referenced an attachment outside your instructions. Please retry.')
    return { text: directive.text, sourceMessageIds, attachmentIds, assetChanges }
  })
  return { reply: value.reply, directives }
}
