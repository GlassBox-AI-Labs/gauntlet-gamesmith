import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { assetPassProgress, assetTargets, cropScript, parseCast, scaffoldAssetTools, unbuiltCast } from './asset-phase'

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

describe('pass progress', () => {
  const spec = (dir: string, name: string, passes: string[], completed: string[], currentPass: string) => {
    const specDir = path.join(dir, '.img2threejs', name)
    fs.mkdirSync(specDir, { recursive: true })
    fs.writeFileSync(
      path.join(specDir, 'object-sculpt-spec.json'),
      JSON.stringify({ sculptPipeline: { passOrder: passes, completedPasses: completed, currentPass } }),
    )
  }
  const factory = (dir: string, name: string) => {
    fs.mkdirSync(path.join(dir, 'src/assets'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'src/assets', `${name}.ts`), 'export const x = 1\n')
  }
  const PASSES = ['blockout', 'structural-pass', 'form-refinement', 'material-pass']

  it('still owes an entry that has a factory but stopped at the first pass', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gauntlet-passes-'))
    factory(dir, 'samoyed')
    spec(dir, 'samoyed', PASSES, ['blockout'], 'structural-pass')

    // The real bug: a file existed, so this used to report nothing owed and
    // froze the model at its roughest pass forever.
    expect(unbuiltCast(dir, [{ name: 'samoyed' } as never]).map((e) => e.name)).toEqual(['samoyed'])
    expect(assetPassProgress(dir, 'samoyed')).toEqual({ completed: 1, total: 4, currentPass: 'structural-pass' })
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('owes nothing once every pass completed', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gauntlet-passes-'))
    factory(dir, 'gravestone')
    spec(dir, 'gravestone', PASSES, PASSES, 'material-pass')

    expect(unbuiltCast(dir, [{ name: 'gravestone' } as never])).toEqual([])
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('falls back to the factory file when there is no spec to consult', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gauntlet-passes-'))
    factory(dir, 'legacy')

    expect(assetPassProgress(dir, 'legacy')).toBeNull()
    // An entry sculpted before passes were recorded must not rebuild forever.
    expect(unbuiltCast(dir, [{ name: 'legacy' } as never])).toEqual([])
    expect(unbuiltCast(dir, [{ name: 'never-built' } as never]).map((e) => e.name)).toEqual(['never-built'])
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('falls back rather than trusting a spec it cannot read', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gauntlet-passes-'))
    factory(dir, 'broken')
    const specDir = path.join(dir, '.img2threejs', 'broken')
    fs.mkdirSync(specDir, { recursive: true })
    fs.writeFileSync(path.join(specDir, 'object-sculpt-spec.json'), 'not json')

    expect(assetPassProgress(dir, 'broken')).toBeNull()
    expect(unbuiltCast(dir, [{ name: 'broken' } as never])).toEqual([])
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('counts only passes the order actually lists', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gauntlet-passes-'))
    spec(dir, 'odd', PASSES, ['blockout', 'not-a-real-pass'], 'structural-pass')

    expect(assetPassProgress(dir, 'odd')?.completed).toBe(1)
    fs.rmSync(dir, { recursive: true, force: true })
  })
})
