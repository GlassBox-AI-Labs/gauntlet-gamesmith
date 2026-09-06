import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { Ledger } from './ledger'
import { SteeringStore } from './steering-store'
import { SteeringService } from './steering'
import { SteeringAttachments } from './steering-attachments'
import { steeringCastWork } from './steering-assets'
import { createRunAttachments } from './run-attachments'
import { copyRunFolder } from './run-transfer'
import { resolveModels } from '../shared/models'
import { parseSteeringReply, steeringAttachments, steeringInput, type SteeringMessage } from '../shared/steering'
import { consultArgs } from './steering-agent'

let root: string, ledger: Ledger
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF9kAAAAASUVORK5CYII=', 'base64')
function setup() {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'steering-files-'))
  const workspaceDir = path.join(root, 'game'); fs.mkdirSync(workspaceDir)
  ledger = new Ledger(path.join(root, 'ledger.db'))
  const loop = ledger.createLoop({ prompt: 'Build a game', workspaceDir, maxRounds: 5, budgetUsd: null, models: resolveModels({}, {}) })
  const drafts = createRunAttachments(() => []), files = new SteeringAttachments(ledger, drafts), store = new SteeringStore(ledger)
  return { loop, drafts, files, store }
}
afterEach(() => { try { ledger?.close() } catch {} if (root) fs.rmSync(root, { recursive: true, force: true }) })
const flush = () => new Promise(resolve => setTimeout(resolve, 0))

it('sends immutable image copies to the consult and shares them with implementation and critique across export/import', async () => {
  const { loop, drafts, files, store } = setup()
  const original = path.join(root, 'character.png'); fs.writeFileSync(original, png)
  const [draft] = drafts.add([original]); fs.writeFileSync(original, 'changed after selection')
  let calls = 0, imagePaths: string[] = []
  const service = new SteeringService(ledger, async input => {
    calls++; imagePaths = input.imagePaths ?? []
    const source = store.steeringState(loop.id).messages.at(-1)!, id = source.attachments![0].id
    expect(input.prompt).toContain(id)
    return { text: JSON.stringify({ reply: 'I’ll rebuild the player using this image.', directives: [{ text: 'Rebuild the player to match this reference.', sourceMessageIds: [source.id], attachmentIds: [id], assetChanges: [{ target: 'player', operation: 'sculpt', attachmentIds: [id] }] }] }), tokens: null, sessionId: null }
  }, () => {}, files)
  const input = { loopId: loop.id, messageId: crypto.randomUUID(), content: 'Make the player look like this.', attachmentIds: [draft.id] }
  service.message(input); await flush()
  service.message(input)
  expect(calls).toBe(1)
  const attachment = service.history(loop.id).messages[0].attachments![0]
  expect(fs.readFileSync(imagePaths[0])).toEqual(png)
  expect(service.preview({ loopId: loop.id, attachmentId: attachment.id })).toEqual(png)
  drafts.remove(draft.id); fs.rmSync(original)
  const run = ledger.createRun({ loopId: loop.id, round: 1, role: 'implement', harness: 'codex', prompt: 'Implement' })
  const frozen = store.freezeRunRequirements(run.id), snapshot = store.requirementsForRun(run.id)!
  expect(frozen.prompt).toContain(attachment.path)
  expect(snapshot.attachments).toEqual([attachment])
  expect(snapshot.assetWork).toHaveLength(1)
  expect(steeringCastWork(snapshot, [], [])[0]).toMatchObject({ name: 'player', stills: [attachment.path] })
  ledger.patchRun(run.id, { status: 'succeeded' })
  const review = ledger.createRun({ loopId: loop.id, round: 1, role: 'critique', harness: 'codex', prompt: 'Critique' })
  store.freezeRunRequirements(review.id)
  expect(store.requirementsForRun(review.id)).toEqual(snapshot)
  ledger.patchRun(review.id, { status: 'succeeded' })
  const next = ledger.createRun({ loopId: loop.id, round: 2, role: 'implement', harness: 'codex', prompt: 'Next' })
  store.freezeRunRequirements(next.id)
  expect(store.requirementsForRun(next.id)?.attachments).toEqual([attachment])
  expect(store.requirementsForRun(next.id)?.assetWork).toEqual([])
  ledger.patchRun(next.id, { status: 'succeeded' }); ledger.patchLoop(loop.id, { status: 'stopped' })
  ledger.prepareRunFolder(loop.id); ledger.close()
  const exported = path.join(root, 'exported'); await copyRunFolder(loop.workspaceDir, exported)
  ledger = new Ledger(path.join(root, 'imported.db')); ledger.importRunFolder(exported)
  expect(new SteeringStore(ledger).requirementsForRun(run.id)).toEqual(snapshot)
  expect(new SteeringAttachments(ledger).read(loop.id, attachment)).toEqual(png)
})

it('accepts an attachment-only question, preserves it through clarification, and applies a direct replacement only after confirmation', async () => {
  const { loop, drafts, files, store } = setup()
  const original = path.join(root, 'player.glb'); fs.writeFileSync(original, 'model fixture')
  const [draft] = drafts.add([original])
  const service = new SteeringService(ledger, async () => {
    const users = store.steeringState(loop.id).messages.filter(message => message.role === 'user')
    const id = users[0].attachments![0].id
    return { text: JSON.stringify(users.length === 1 ? { reply: 'Should this replace the player or serve as a reference?', directives: [] } : { reply: 'I’ll replace the player with your model.', directives: [{ text: 'Use the supplied model as the player.', sourceMessageIds: users.map(message => message.id), attachmentIds: [id], assetChanges: [{ target: 'player', operation: 'use-file', attachmentIds: [id] }] }] }), tokens: null, sessionId: null }
  }, () => {}, files)
  service.message({ loopId: loop.id, messageId: crypto.randomUUID(), content: '', attachmentIds: [draft.id] }); await flush()
  expect(service.history(loop.id).directives).toEqual([])
  const first = ledger.createRun({ loopId: loop.id, round: 1, role: 'implement', harness: 'codex', prompt: 'Implement' })
  store.freezeRunRequirements(first.id)
  expect(store.requirementsForRun(first.id)?.attachments).toEqual([])
  service.message({ loopId: loop.id, messageId: crypto.randomUUID(), content: 'Replace the player.' }); await flush()
  const next = ledger.createRun({ loopId: loop.id, round: 2, role: 'implement', harness: 'codex', prompt: 'Implement next' })
  store.freezeRunRequirements(next.id)
  const snapshot = store.requirementsForRun(next.id)!
  expect(snapshot.attachments).toHaveLength(1)
  expect(snapshot.assetWork?.[0].operation).toBe('use-file')
  const oldCast = { name: 'player', kind: 'character', stills: [], locator: '', role: '', priority: 1 }
  expect(steeringCastWork(snapshot, [oldCast], [oldCast])).toEqual([])
  expect(store.requirementsForRun(first.id)?.attachments).toEqual([])
})

it('rejects altered, linked, cross-run, and traversal attachment reads', () => {
  const { loop, drafts, files } = setup()
  const original = path.join(root, 'reference.png'); fs.writeFileSync(original, png)
  const [draft] = drafts.add([original]), prepared = files.prepare(loop.id, [draft.id], [])
  prepared.publish()
  const file = prepared.files[0], absolute = path.join(loop.workspaceDir, file.path)
  fs.writeFileSync(absolute, 'modified')
  expect(() => files.verify(loop.id, [file])).toThrow('changed')
  fs.rmSync(absolute); fs.symlinkSync(original, absolute)
  expect(() => files.verify(loop.id, [file])).toThrow()
  expect(() => steeringAttachments([{ ...file, path: '../outside.png' }], loop.id)).toThrow()
  expect(() => files.read(crypto.randomUUID(), file)).toThrow()
})

it('rejects attachments without source authorization and passes image paths as separate CLI arguments', () => {
  setup()
  const message: SteeringMessage = { id: 'user', loopId: 'loop', role: 'user', content: 'Reference', createdAt: '', attemptId: null }
  const reply = { reply: 'Ready', directives: [{ text: 'Replace player', sourceMessageIds: ['user'], attachmentIds: ['invented'], assetChanges: [] }] }
  expect(() => parseSteeringReply(JSON.stringify(reply), new Set(['user']), [message])).toThrow('outside your instructions')
  expect(() => steeringInput({ loopId: 'run', messageId: 'message', content: '', attachmentIds: Array.from({ length: 11 }, (_, index) => `id-${index}`) })).toThrow()
  const input = { attemptId: 'id', model: 'model', prompt: 'prompt', workspaceDir: root, signal: new AbortController().signal, imagePaths: ['/path with spaces/image.png'] }
  const args = consultArgs(input, '/schema.json')
  expect(args.slice(-3)).toEqual(['--image', '/path with spaces/image.png', '-'])
})
