import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { assetTargets, cropScript, parseCast, scaffoldAssetTools, unbuiltCast } from './asset-phase'

/** Stands in for the installed img2threejs skill, wherever it happens to live. */
const SKILL = '/skills/img2threejs'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function workspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gauntlet-assets-'))
  dirs.push(dir)
  return dir
}

const entry = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  name: 'samoyed',
  kind: 'character',
  stills: ['images/dog.jpg'],
  locator: 'front left',
  role: 'the player',
  priority: 1,
  ...over,
})

describe('cast list', () => {
  it('reads the cast out of the manifest', () => {
    const cast = parseCast(JSON.stringify({ cast: [entry()] }))
    expect(cast).toEqual([
      { name: 'samoyed', kind: 'character', stills: ['images/dog.jpg'], locator: 'front left', role: 'the player', priority: 1 },
    ])
  })

  it('is empty when there is no cast, rather than throwing', () => {
    expect(parseCast(null)).toEqual([])
    expect(parseCast('')).toEqual([])
    expect(parseCast('{ not json')).toEqual([])
    expect(parseCast(JSON.stringify({ sources: [] }))).toEqual([])
  })

  it('builds the highest-priority entries first, so a truncated round spends where it matters', () => {
    const cast = parseCast(
      JSON.stringify({ cast: [entry({ name: 'crow', priority: 9 }), entry({ name: 'wolf', priority: 2 }), entry({ name: 'samoyed', priority: 1 })] }),
    )
    expect(cast.map((c) => c.name)).toEqual(['samoyed', 'wolf', 'crow'])
  })

  it('drops an entry whose name would escape the workspace', () => {
    // The name becomes src/assets/<name>.ts and .img2threejs/<name>/, so it is
    // rejected rather than sanitised into a path nobody asked for.
    const cast = parseCast(JSON.stringify({ cast: [entry({ name: '../../etc/passwd' }), entry({ name: 'Samoyed Dog' }), entry({ name: 'wolf' })] }))
    expect(cast.map((c) => c.name)).toEqual(['wolf'])
  })

  it('keeps the first of two entries with the same name', () => {
    const cast = parseCast(JSON.stringify({ cast: [entry({ locator: 'first' }), entry({ locator: 'second' })] }))
    expect(cast).toHaveLength(1)
    expect(cast[0]?.locator).toBe('first')
  })

  it('defaults a partial entry instead of dropping it', () => {
    const cast = parseCast(JSON.stringify({ cast: [{ name: 'wolf' }] }))
    expect(cast[0]).toMatchObject({ name: 'wolf', kind: 'prop', stills: [], priority: 100 })
  })
})

describe('re-entrant rounds', () => {
  it('owes only the entries with no factory on disk', () => {
    const dir = workspace()
    fs.mkdirSync(path.join(dir, 'src/assets'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'src/assets/samoyed.ts'), 'export const build = () => {}')
    const cast = parseCast(JSON.stringify({ cast: [entry({ name: 'samoyed' }), entry({ name: 'wolf' })] }))
    expect(unbuiltCast(dir, cast).map((c) => c.name)).toEqual(['wolf'])
  })
})

describe('routing critic findings', () => {
  it('sends model faults back to the pipeline and everything else to the implementer', () => {
    expect(
      assetTargets([
        { target: 'asset:samoyed' },
        { target: 'game' },
        { target: 'asset:wolf' },
        {},
      ]),
    ).toEqual(['samoyed', 'wolf'])
  })

  it('re-sculpts a model named twice only once', () => {
    expect(assetTargets([{ target: 'asset:samoyed' }, { target: 'asset:samoyed ' }])).toEqual(['samoyed'])
  })

  it('reads a verdict written before the phase existed as nothing to re-sculpt', () => {
    expect(assetTargets([{ }, { }])).toEqual([])
  })

  it('ignores a target that names no asset', () => {
    expect(assetTargets([{ target: 'asset:' }, { target: 'asset:   ' }])).toEqual([])
  })
})

describe('crop tool scaffolding', () => {
  it('writes the tool and rewrites it when a worker has changed it', () => {
    const dir = workspace()
    expect(scaffoldAssetTools(dir, SKILL)).toBe(true)
    const target = path.join(dir, 'tools/crop.py')
    expect(fs.readFileSync(target, 'utf8')).toBe(cropScript(SKILL))

    // Unchanged: nothing to do.
    expect(scaffoldAssetTools(dir, SKILL)).toBe(false)

    // A guard a worker can weaken is not a guard.
    fs.writeFileSync(target, 'print("always fine")')
    expect(scaffoldAssetTools(dir, SKILL)).toBe(true)
    expect(fs.readFileSync(target, 'utf8')).toBe(cropScript(SKILL))
  })

  it('ships a tool that refuses a crop the object barely fills', () => {
    // The rule probe_image.py cannot make: widening a small box until it clears
    // the 512 px floor passes every technical check and hands the pipeline a
    // scene. Keep the threshold and its reason in the shipped script.
    expect(cropScript(SKILL)).toContain('MIN_FILL = 0.25')
    expect(cropScript(SKILL)).toContain('object too small in this still')
    expect(cropScript(SKILL)).toContain('--allow-upscale')
  })

  it('points the probe at the skill it was given, not at whoever built the app', () => {
    // The path used to be one developer's home folder, so the probe fell over
    // on every other machine and again the moment the app was renamed.
    const script = cropScript('/Users/someone/Application Support/App/skills/img2threejs')

    expect(script).toContain('"/Users/someone/Application Support/App/skills/img2threejs"')
    expect(script).not.toContain('/Users/john/')
  })
})
