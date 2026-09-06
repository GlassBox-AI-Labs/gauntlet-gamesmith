import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { captureWorkspaceIdentity } from './workspace-boundary'
import { referencePackDir, scanReferencePack } from './reference-pack'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function workspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gauntlet-reference-'))
  dirs.push(dir)
  return dir
}

describe('Reference Pack', () => {
  it('scopes each pack to its loop', () => {
    expect(referencePackDir('loop-123')).toBe('reference/loop-123')
    expect(() => referencePackDir('../elsewhere')).toThrow('Invalid loop id')
  })

  it('validates and inventories a completed pack', () => {
    const dir = workspace()
    const root = referencePackDir('loop-123')
    for (const subdir of ['images', 'motion', 'video', 'journey']) fs.mkdirSync(path.join(dir, root, subdir), { recursive: true })
    for (let i = 0; i < 8; i += 1) {
      fs.writeFileSync(path.join(dir, root, 'images', `still-${i}.jpg`), 'image')
      fs.writeFileSync(path.join(dir, root, 'motion', `frame-${i}.png`), 'frame')
    }
    for (const shot of ['01-title', '02-main-menu', '03-intro', '04-level-1-start']) {
      fs.writeFileSync(path.join(dir, root, 'journey', `${shot}.png`), 'shot')
    }
    fs.writeFileSync(path.join(dir, root, 'video', 'gameplay.webm'), 'video')
    fs.writeFileSync(path.join(dir, root, 'README.md'), '# Target\n\nProgression model: level-based')
    fs.writeFileSync(path.join(dir, root, 'journey.md'), '# Main menu → Level 1')
    fs.writeFileSync(path.join(dir, root, 'story.md'), '# Premise')
    fs.writeFileSync(path.join(dir, root, 'research.md'), '# What players say\n\n## Expert gameplay dossier')
    fs.writeFileSync(path.join(dir, root, 'cast.md'), '# Cast\n\n- samoyed — the player dog')
    const files = [
      ...Array.from({ length: 8 }, (_, index) => `images/still-${index}.jpg`),
      ...Array.from({ length: 8 }, (_, index) => `motion/frame-${index}.png`),
      ...['01-title', '02-main-menu', '03-intro', '04-level-1-start'].map((name) => `journey/${name}.png`),
      'video/gameplay.webm',
    ]
    fs.writeFileSync(
      path.join(dir, root, 'manifest.json'),
      JSON.stringify({
        title: 'Reference Game',
        sources: files.map((file) => ({ url: 'https://example.com', file })),
        cast: [{ name: 'samoyed', kind: 'character', stills: ['images/still-0.jpg'], locator: 'front left', role: 'the player', priority: 1 }],
      }),
    )

    const pack = scanReferencePack(dir, root)
    expect(pack.issues).toEqual([])
    expect(pack.ready).toBe(true)
    expect(pack.castCount).toBe(1)
    expect(pack.images).toHaveLength(8)
    expect(pack.motion).toHaveLength(8)
    expect(pack.videos).toHaveLength(1)
    expect(pack.journey).toEqual([
      `${root}/journey/01-title.png`,
      `${root}/journey/02-main-menu.png`,
      `${root}/journey/03-intro.png`,
      `${root}/journey/04-level-1-start.png`,
    ])
    expect(pack.readme).toContain('# Target')
    expect(pack.journeyMd).toContain('Main menu')
    expect(pack.storyMd).toContain('Premise')
    expect(pack.researchMd).toContain('What players say')

    const credentialName = `ghp_${'a'.repeat(36)}.png`
    fs.writeFileSync(path.join(dir, root, 'images', credentialName), 'do not project this path')
    const filtered = scanReferencePack(dir, root)
    expect(filtered.ready).toBe(true)
    expect(filtered.images.join('\n')).not.toContain(credentialName)
    expect(filtered.warnings).toContain('credential-shaped artifact paths were omitted from the display projection')

    fs.truncateSync(path.join(dir, root, 'video', 'gameplay.webm'), 512 * 1024 * 1024 + 1)
    const oversizedVideo = scanReferencePack(dir, root)
    expect(oversizedVideo.videos).toEqual([])
    expect(oversizedVideo.ready).toBe(false)
    expect(oversizedVideo.issues).toContain('needs a gameplay video')
    expect(oversizedVideo.warnings).toContain('projected media exceeds its byte or display-count safety limit and was truncated')
  })

  it('rejects a shallow study that cannot make the critic a game expert', () => {
    const dir = workspace()
    const root = referencePackDir('loop-123')
    fs.mkdirSync(path.join(dir, root), { recursive: true })
    fs.writeFileSync(path.join(dir, root, 'README.md'), '# Visual mood board')
    fs.writeFileSync(path.join(dir, root, 'research.md'), '# A few reviews')

    const pack = scanReferencePack(dir, root)
    expect(pack.issues).toContain('research.md needs an Expert gameplay dossier for the critic')
    expect(pack.issues).toContain('README.md needs a level-based or non-level-based progression classification')
  })

  it('validates a manifest larger than the display cap without truncating it', () => {
    const dir = workspace()
    const root = referencePackDir('loop-123')
    fs.mkdirSync(path.join(dir, root), { recursive: true })
    const sources = Array.from({ length: 200 }, (_, index) => ({
      url: `https://example.com/source-${index}`,
      note: 'a consulted deep-research source with a reasonably long note attached to it',
    }))
    fs.writeFileSync(path.join(dir, root, 'manifest.json'), JSON.stringify({ title: 'Reference Game', sources }, null, 2))

    const pack = scanReferencePack(dir, root)
    expect(pack.manifest!.length).toBeGreaterThan(12_000)
    expect(pack.issues).not.toContain('manifest.json is not valid JSON')
  })

  it('redacts credentials from every document projected over IPC while validating the raw manifest', () => {
    const dir = workspace()
    const root = referencePackDir('loop-123')
    fs.mkdirSync(path.join(dir, root), { recursive: true })
    const token = `ghp_${'a'.repeat(36)}`
    fs.writeFileSync(path.join(dir, root, 'README.md'), `Progression model: level-based\n${token}`)
    fs.writeFileSync(path.join(dir, root, 'research.md'), `Expert gameplay dossier\nAuthorization: Bearer ${token}`)
    fs.writeFileSync(path.join(dir, root, 'journey.md'), `OPENAI_API_KEY=${token}`)
    fs.writeFileSync(path.join(dir, root, 'story.md'), `{"password":"two word secret"}`)
    fs.writeFileSync(path.join(dir, root, 'manifest.json'), JSON.stringify({
      title: 'Reference Game',
      sources: [{ url: 'https://example.com', note: `Authorization: Bearer ${token}` }],
    }))

    const pack = scanReferencePack(dir, root)
    for (const projected of [pack.readme, pack.researchMd, pack.journeyMd, pack.storyMd, pack.manifest]) {
      expect(projected).not.toContain(token)
      expect(projected).toContain('[REDACTED]')
    }
    expect(pack.issues).not.toContain('manifest.json is not valid JSON')
  })

  it('counts an mkv gameplay clip as the required video', () => {
    const dir = workspace()
    const root = referencePackDir('loop-123')
    for (const subdir of ['images', 'motion', 'video', 'journey']) fs.mkdirSync(path.join(dir, root, subdir), { recursive: true })
    for (let i = 0; i < 8; i += 1) {
      fs.writeFileSync(path.join(dir, root, 'images', `still-${i}.jpg`), 'image')
      fs.writeFileSync(path.join(dir, root, 'motion', `frame-${i}.png`), 'frame')
    }
    for (const shot of ['01-title', '02-main-menu', '03-intro', '04-level-1-start']) {
      fs.writeFileSync(path.join(dir, root, 'journey', `${shot}.png`), 'shot')
    }
    fs.writeFileSync(path.join(dir, root, 'video', 'aaa-gameplay.mkv'), 'video')
    fs.writeFileSync(path.join(dir, root, 'README.md'), '# Target\n\nProgression model: level-based')
    fs.writeFileSync(path.join(dir, root, 'journey.md'), '# Main menu → Level 1')
    fs.writeFileSync(path.join(dir, root, 'story.md'), '# Premise')
    fs.writeFileSync(path.join(dir, root, 'research.md'), '# What players say\n\n## Expert gameplay dossier')
    fs.writeFileSync(path.join(dir, root, 'cast.md'), 'None — the look is shaders and bloom.')
    // Every downloaded file needs its own attribution, or the pack is not ready
    // for reasons that have nothing to do with the clip's container format.
    const evidence = [
      ...Array.from({ length: 8 }, (_, i) => `images/still-${i}.jpg`),
      ...Array.from({ length: 8 }, (_, i) => `motion/frame-${i}.png`),
      ...['01-title', '02-main-menu', '03-intro', '04-level-1-start'].map((shot) => `journey/${shot}.png`),
      'video/aaa-gameplay.mkv',
    ]
    fs.writeFileSync(path.join(dir, root, 'manifest.json'), JSON.stringify({
      title: 'Reference Game',
      sources: evidence.map((file) => ({ url: 'https://example.com', file })),
    }))

    const pack = scanReferencePack(dir, root)
    expect(pack.issues).toEqual([])
    expect(pack.ready).toBe(true)
    expect(pack.videos).toEqual([`${root}/video/aaa-gameplay.mkv`])
    expect(pack.issues).not.toContain('needs a gameplay video')
  })

  it('returns actionable issues for an incomplete pack', () => {
    const dir = workspace()
    const root = referencePackDir('loop-123')
    fs.mkdirSync(path.join(dir, root), { recursive: true })
    fs.writeFileSync(path.join(dir, root, 'manifest.json'), '{bad json')

    const pack = scanReferencePack(dir, root)
    expect(pack.ready).toBe(false)
    expect(pack.issues).toContain('needs at least 8 stills (0 found)')
    expect(pack.issues).toContain('needs at least 8 motion frames (0 found)')
    expect(pack.issues).toContain('needs a gameplay video')
    expect(pack.issues).toContain('needs at least 4 ordered journey shots (0 found)')
    expect(pack.issues).toContain('needs research.md with the deep-research findings')
    expect(pack.issues).toContain('needs journey.md with the main menu → Level 1 walkthrough')
    expect(pack.issues).toContain('needs story.md with the premise, progression, and captured dialog')
    expect(pack.issues).toContain('needs README.md with the target brief')
    expect(pack.issues).toContain('manifest.json is not valid JSON')
  })

  it('accepts a game with nothing worth sculpting', () => {
    const dir = workspace()
    const root = referencePackDir('loop-none')
    completePack(dir, root)
    fs.writeFileSync(path.join(dir, root, 'cast.md'), 'none — the look is neon walls, bloom and glow trails, not models.')

    const pack = scanReferencePack(dir, root)
    expect(pack.issues).toEqual([])
    expect(pack.castCount).toBe(0)
  })

  it('faults a cast written in prose but never put in the manifest', () => {
    const dir = workspace()
    const root = referencePackDir('loop-prose')
    completePack(dir, root)
    fs.writeFileSync(path.join(dir, root, 'cast.md'), '# Cast\n\n- samoyed — the player dog')

    const pack = scanReferencePack(dir, root)
    expect(pack.issues).toContain('cast.md lists objects but manifest.json has no matching "cast" array')
  })

  it('faults a cast entry that names no frame to crop from', () => {
    const dir = workspace()
    const root = referencePackDir('loop-noframe')
    completePack(dir, root)
    fs.writeFileSync(path.join(dir, root, 'cast.md'), '# Cast\n\n- samoyed')
    fs.writeFileSync(
      path.join(dir, root, 'manifest.json'),
      JSON.stringify({ sources: [{ url: 'https://example.com' }], cast: [{ name: 'samoyed', stills: [] }] }),
    )

    const pack = scanReferencePack(dir, root)
    expect(pack.issues).toContain('cast entries name no reference frame: samoyed')
  })

  it('reads isolated object shots as their own source', () => {
    const dir = workspace()
    const root = referencePackDir('loop-objects')
    completePack(dir, root)
    fs.mkdirSync(path.join(dir, root, 'objects'), { recursive: true })
    fs.writeFileSync(path.join(dir, root, 'objects', 'samoyed-01.jpg'), 'shot')

    expect(scanReferencePack(dir, root).objects).toEqual([`${root}/objects/samoyed-01.jpg`])
  })

  it('refuses symlinked and oversized machine-readable inputs before reading them', () => {
    const dir = workspace()
    const root = referencePackDir('loop-123')
    fs.mkdirSync(path.join(dir, root), { recursive: true })
    const outside = path.join(dir, 'outside.json')
    fs.writeFileSync(outside, JSON.stringify({ sources: [{ url: 'https://secret.test' }] }))
    fs.symlinkSync(outside, path.join(dir, root, 'manifest.json'))
    expect(scanReferencePack(dir, root).issues).toContain('needs manifest.json with source attribution')

    fs.unlinkSync(path.join(dir, root, 'manifest.json'))
    fs.linkSync(outside, path.join(dir, root, 'manifest.json'))
    expect(scanReferencePack(dir, root).issues).toContain('needs manifest.json with source attribution')

    fs.unlinkSync(path.join(dir, root, 'manifest.json'))
    fs.writeFileSync(path.join(dir, root, 'manifest.json'), ' '.repeat(1_000_001))
    expect(scanReferencePack(dir, root).issues).toContain('needs manifest.json with source attribution')
  })

  it('rejects a symlinked pack root and invalid or escaping source entries', () => {
    const dir = workspace()
    const root = referencePackDir('loop-123')
    const outside = path.join(dir, 'outside')
    fs.mkdirSync(outside, { recursive: true })
    fs.writeFileSync(path.join(outside, 'manifest.json'), JSON.stringify({ title: 'Secret', sources: [{ url: 'https://example.com' }] }))
    fs.mkdirSync(path.dirname(path.join(dir, root)), { recursive: true })
    fs.symlinkSync(outside, path.join(dir, root))
    expect(scanReferencePack(dir, root).manifest).toBeNull()

    fs.unlinkSync(path.join(dir, root))
    fs.mkdirSync(path.join(dir, root, 'images'), { recursive: true })
    fs.writeFileSync(path.join(dir, root, 'images', 'still.jpg'), 'image')
    fs.writeFileSync(
      path.join(dir, root, 'manifest.json'),
      JSON.stringify({ title: 'Reference Game', sources: [{ url: 'file:///etc/passwd', file: '../outside' }] }),
    )
    const issues = scanReferencePack(dir, root).issues
    expect(issues).toContain('manifest.json contains an invalid source entry')
    expect(issues).toContain('manifest.json lacks attribution for 1 downloaded evidence file')
  })

  it('does not demand a source URL for an agent-written note in an evidence directory', () => {
    const dir = workspace()
    const root = referencePackDir('loop-123')
    fs.mkdirSync(path.join(dir, root, 'images'), { recursive: true })
    fs.mkdirSync(path.join(dir, root, 'objects'), { recursive: true })
    fs.writeFileSync(path.join(dir, root, 'images', 'still.jpg'), 'image')
    // What the protocol asks for when no clean one-object shot exists.
    fs.writeFileSync(path.join(dir, root, 'objects', 'README.md'), 'No isolated object reference was located.')
    fs.writeFileSync(
      path.join(dir, root, 'manifest.json'),
      JSON.stringify({ title: 'Reference Game', sources: [{ url: 'https://example.com/still.jpg', file: 'images/still.jpg' }] }),
    )
    const issues = scanReferencePack(dir, root).issues
    expect(issues).not.toContain('manifest.json lacks attribution for 1 downloaded evidence file')

    // An actual downloaded file in the same directory still has to be attributed.
    fs.writeFileSync(path.join(dir, root, 'objects', 'virus.jpg'), 'image')
    expect(scanReferencePack(dir, root).issues).toContain('manifest.json lacks attribution for 1 downloaded evidence file')
  })

  it('fails closed when the inventory exceeds its file-count cap', () => {
    const dir = workspace()
    const root = referencePackDir('loop-123')
    const images = path.join(dir, root, 'images')
    fs.mkdirSync(images, { recursive: true })
    for (let index = 0; index < 301; index += 1) fs.writeFileSync(path.join(images, `${index}.png`), 'x')
    expect(scanReferencePack(dir, root).issues).toContain('inventory exceeds 300 files or 2000 entries and was truncated')
  })

  it('excludes oversized images and surfaces the bounded projection', () => {
    const dir = workspace()
    const root = referencePackDir('loop-123')
    const images = path.join(dir, root, 'images')
    fs.mkdirSync(images, { recursive: true })
    const oversized = path.join(images, 'oversized.png')
    fs.writeFileSync(oversized, '')
    fs.truncateSync(oversized, 32 * 1024 * 1024 + 1)

    const pack = scanReferencePack(dir, root)
    expect(pack.images).toEqual([])
    expect(pack.warnings).toContain('projected media exceeds its byte or display-count safety limit and was truncated')
  })

  it('keeps a complete pack ready when only extra display media is truncated', () => {
    const dir = workspace()
    const root = referencePackDir('loop-123')
    for (const subdir of ['images', 'motion', 'video', 'journey']) fs.mkdirSync(path.join(dir, root, subdir), { recursive: true })
    const files = [
      ...Array.from({ length: 25 }, (_, index) => `images/still-${index}.jpg`),
      ...Array.from({ length: 8 }, (_, index) => `motion/frame-${index}.png`),
      ...Array.from({ length: 4 }, (_, index) => `journey/0${index + 1}.png`),
      'video/gameplay.webm',
    ]
    for (const file of files) fs.writeFileSync(path.join(dir, root, file), 'media')
    fs.writeFileSync(path.join(dir, root, 'README.md'), 'Progression model: level-based')
    fs.writeFileSync(path.join(dir, root, 'research.md'), 'Expert gameplay dossier')
    fs.writeFileSync(path.join(dir, root, 'journey.md'), 'Main menu to Level 1')
    fs.writeFileSync(path.join(dir, root, 'story.md'), 'Premise and progression')
    fs.writeFileSync(path.join(dir, root, 'cast.md'), 'none')
    fs.writeFileSync(path.join(dir, root, 'manifest.json'), JSON.stringify({
      title: 'Reference Game',
      sources: files.map((file) => ({ url: 'https://example.test/source', file })),
    }))

    const pack = scanReferencePack(dir, root)
    expect(pack.ready).toBe(true)
    expect(pack.images).toHaveLength(24)
    expect(pack.warnings).toContain('projected media exceeds its byte or display-count safety limit and was truncated')
  })
})

/** Everything a pack needs except a cast, so a test can vary just that. */
function completePack(dir: string, root: string): void {
  for (const subdir of ['images', 'motion', 'video', 'journey']) fs.mkdirSync(path.join(dir, root, subdir), { recursive: true })
  for (let i = 0; i < 8; i += 1) {
    fs.writeFileSync(path.join(dir, root, 'images', `still-${i}.jpg`), 'image')
    fs.writeFileSync(path.join(dir, root, 'motion', `frame-${i}.png`), 'frame')
  }
  for (const shot of ['01-title', '02-main-menu', '03-intro', '04-level-1-start']) {
    fs.writeFileSync(path.join(dir, root, 'journey', `${shot}.png`), 'shot')
  }
  fs.writeFileSync(path.join(dir, root, 'video', 'gameplay.webm'), 'video')
  fs.writeFileSync(path.join(dir, root, 'README.md'), '# Target\n\nProgression model: level-based')
  fs.writeFileSync(path.join(dir, root, 'journey.md'), '# Main menu → Level 1')
  fs.writeFileSync(path.join(dir, root, 'story.md'), '# Premise')
  fs.writeFileSync(path.join(dir, root, 'research.md'), '# What players say\n\n## Expert gameplay dossier')
  const files = [
    ...Array.from({ length: 8 }, (_, index) => `images/still-${index}.jpg`),
    ...Array.from({ length: 8 }, (_, index) => `motion/frame-${index}.png`),
    ...['01-title', '02-main-menu', '03-intro', '04-level-1-start'].map((name) => `journey/${name}.png`),
    'video/gameplay.webm',
  ]
  fs.writeFileSync(path.join(dir, root, 'manifest.json'), JSON.stringify({
    title: 'Reference Game',
    sources: files.map((file) => ({ url: 'https://example.com', file })),
  }))
}

it('accepts grounded files-only evidence without web media quotas, while old runs retain them', () => {
  const dir = workspace(); const reference = 'reference/local-study'; const target = path.join(dir, reference)
  fs.mkdirSync(path.join(target, 'supplied'), { recursive: true })
  fs.writeFileSync(path.join(target, 'supplied/brief.txt'), 'brief')
  for (const [name, text] of Object.entries({ 'README.md': 'Progression model: non-level-based', 'research.md': 'Expert gameplay dossier', 'journey.md': 'Unknown from supplied files', 'story.md': 'Unknown', 'cast.md': 'none' })) fs.writeFileSync(path.join(target, name), text)
  fs.writeFileSync(path.join(target, 'manifest.json'), JSON.stringify({ title: 'Supplied target', sources: [{ file: 'supplied/brief.txt', note: 'Design brief' }], cast: [] }))
  const captured = captureWorkspaceIdentity(dir, [])
  expect(scanReferencePack(dir, reference, { ...captured, models: { referenceMode: 'files' } }).ready).toBe(true)
  expect(scanReferencePack(dir, reference, captured).ready).toBe(false)
})
