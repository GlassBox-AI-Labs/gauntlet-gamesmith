import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createBuildAttachments } from './build-attachments'
import { referencePackFingerprint } from './phase-contracts'
const roots: string[] = []
const stores: ReturnType<typeof createBuildAttachments>[] = []
function attachmentStore(roots: () => string[]) { const store = createBuildAttachments(roots); stores.push(store); return store }
function root(): string { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-context-')); roots.push(dir); return dir }
afterEach(() => { for (const store of stores.splice(0)) store.dispose(); for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true }) })
describe('build attachment snapshots', () => {
  it('publishes original bytes and provenance after the source changes or disappears', async () => {
    const source = path.join(root(), 'notes.txt'); fs.writeFileSync(source, 'Original context')
    const store = attachmentStore(() => [])
    const [item] = await store.add([source]); fs.writeFileSync(source, 'Changed context')
    const workspace = root(); const prepared = store.prepare([item.id])!
    store.remove(item.id); fs.unlinkSync(source)
    const result = prepared.publish(workspace, 'reference/build-1')
    expect(fs.readFileSync(path.join(workspace, result.paths[0]), 'utf8')).toBe('Original context')
    const manifest = JSON.parse(fs.readFileSync(path.join(workspace, 'reference/build-1/supplied/manifest.json'), 'utf8'))
    expect(manifest.files[0]).toMatchObject({ original: 'notes.txt', bytes: 16 })
    expect(JSON.stringify(manifest)).not.toContain(source)
    expect(referencePackFingerprint(workspace, 'reference/build-1/supplied')).toBe(result.fingerprint)
    fs.writeFileSync(path.join(workspace, result.paths[0]), 'tampered')
    expect(referencePackFingerprint(workspace, 'reference/build-1/supplied')).not.toBe(result.fingerprint)
  })
  it('never follows symlinks or copies credential/generated files during folder ingestion', async () => {
    const source = root(); fs.writeFileSync(path.join(source, 'reference.md'), 'brief')
    fs.mkdirSync(path.join(source, '.codex')); fs.writeFileSync(path.join(source, '.codex/auth.json'), 'not read')
    fs.writeFileSync(path.join(source, 'credentials.json'), 'not read')
    fs.symlinkSync(path.join(source, 'reference.md'), path.join(source, 'linked.txt'))
    const store = attachmentStore(() => []); const [item] = await store.add([source])
    expect(item.files).toBe(1); expect(item.skipped).toBe(3)
    expect(store.folder(item.id)).toBe(fs.realpathSync(source))
    await expect(store.add([path.join(source, '.codex/auth.json')])).rejects.toThrow()
    await expect(store.add([path.join(source, 'linked.txt')])).rejects.toThrow()
  })
  it('rejects unknown IDs, private roots, oversized files, and partial batches', async () => {
    const source = root(); const file = path.join(source, 'image.png'); fs.writeFileSync(file, 'image')
    await expect(attachmentStore(() => [source]).add([file])).rejects.toThrow('private')
    const store = attachmentStore(() => [])
    expect(() => store.prepare(['00000000-0000-4000-8000-000000000000'])).toThrow('no longer available')
    const oversized = path.join(source, 'large.txt'); fs.writeFileSync(oversized, ''); fs.truncateSync(oversized, 1024 * 1024 * 1024 + 1)
    await expect(store.add([file, oversized])).rejects.toThrow('1 GiB')
    const [item] = await store.add([file]); expect(store.preview(item.id)).toBe('data:image/png;base64,aW1hZ2U=')
    expect(() => store.folder(item.id)).toThrow('not a folder')
  })
})

it('snapshots folders larger than the previous 100-file and 20 MB limits without reading whole files', async () => {
  const source = root()
  for (let n=0;n<120;n++) fs.writeFileSync(path.join(source, `source-${n}.ts`), 'export {}')
  const large = path.join(source, 'scene.glb'); fs.writeFileSync(large, ''); fs.truncateSync(large, 25*1024*1024)
  const store = attachmentStore(() => [])
  try {
    let yielded = false, progressed = false
    setImmediate(() => { yielded = true })
    const [item] = await store.add([source], value => { progressed ||= value.bytes > 20 * 1024 * 1024 })
    expect(yielded).toBe(true); expect(progressed).toBe(true)
    expect(item.files).toBe(121); expect(item.bytes).toBeGreaterThan(25*1024*1024)
    const result = store.prepare([item.id])!.publish(root(), 'reference/large-game')
    expect(result.files).toBe(121); expect(result.bytes).toBe(item.bytes)
  } finally { store.dispose() }
})
