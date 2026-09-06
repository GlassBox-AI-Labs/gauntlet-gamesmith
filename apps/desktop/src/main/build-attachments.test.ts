import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createBuildAttachments } from './build-attachments'
import { referencePackFingerprint } from './phase-contracts'
const roots: string[] = []
function root(): string { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-context-')); roots.push(dir); return dir }
afterEach(() => { for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true }) })
describe('build attachment snapshots', () => {
  it('publishes original bytes and provenance after the source changes or disappears', () => {
    const source = path.join(root(), 'notes.txt'); fs.writeFileSync(source, 'Original context')
    const store = createBuildAttachments(() => [])
    const [item] = store.add([source]); fs.writeFileSync(source, 'Changed context')
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
  it('never follows symlinks or copies credential/generated files during folder ingestion', () => {
    const source = root(); fs.writeFileSync(path.join(source, 'reference.md'), 'brief')
    fs.mkdirSync(path.join(source, '.codex')); fs.writeFileSync(path.join(source, '.codex/auth.json'), 'not read')
    fs.writeFileSync(path.join(source, 'credentials.json'), 'not read')
    fs.symlinkSync(path.join(source, 'reference.md'), path.join(source, 'linked.txt'))
    const store = createBuildAttachments(() => []); const [item] = store.add([source])
    expect(item.files).toBe(1); expect(item.skipped).toBe(3)
    expect(store.folder(item.id)).toBe(fs.realpathSync(source))
    expect(() => store.add([path.join(source, '.codex/auth.json')])).toThrow()
    expect(() => store.add([path.join(source, 'linked.txt')])).toThrow()
  })
  it('rejects unknown IDs, private roots, oversized files, and partial batches', () => {
    const source = root(); const file = path.join(source, 'image.png'); fs.writeFileSync(file, 'image')
    expect(() => createBuildAttachments(() => [source]).add([file])).toThrow('private')
    const store = createBuildAttachments(() => [])
    expect(() => store.prepare(['00000000-0000-4000-8000-000000000000'])).toThrow('no longer available')
    const oversized = path.join(source, 'large.txt'); fs.writeFileSync(oversized, ''); fs.truncateSync(oversized, 21 * 1024 * 1024)
    expect(() => store.add([file, oversized])).toThrow('20 MB')
    const [item] = store.add([file]); expect(store.preview(item.id)).toBe('data:image/png;base64,aW1hZ2U=')
    expect(() => store.folder(item.id)).toThrow('not a folder')
  })
})
