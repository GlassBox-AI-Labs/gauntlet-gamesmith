import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { ENGINE_DEPS, engineContract, engineGateRules } from '../shared/engine-stack'
import { scaffoldEngine } from './engine-stack'

function workspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'engine-stack-'))
}

interface GateCheck {
  id: string
  ok: boolean
  violations: { file: string; line: number; text: string }[]
  notes?: { file: string; line: number; text: string }[]
}
interface GateReport {
  ok: boolean
  checks: GateCheck[]
}

/** Run the scaffolded gate and give back its verdict. */
function runGate(dir: string): { code: number; report: GateReport } {
  try {
    const stdout = execFileSync('node', ['tools/engine-gate.mjs'], { cwd: dir, encoding: 'utf8' })
    return { code: 0, report: JSON.parse(stdout) }
  } catch (error) {
    const err = error as { status: number; stdout: string }
    return { code: err.status, report: JSON.parse(err.stdout) }
  }
}

const failed = (report: GateReport): string[] =>
  report.checks.filter((c) => !c.ok).map((c) => c.id)

describe('engineContract', () => {
  it('spells out the bitECS 0.4 API, because every model remembers the 0.3 one', () => {
    const contract = engineContract()
    expect(contract).toContain('createWorld')
    expect(contract).toContain('DO NOT EXIST')
    expect(contract).toContain('defineComponent')
  })

  it('pins every dependency exactly and bans the React path', () => {
    const contract = engineContract()
    for (const [name, version] of Object.entries(ENGINE_DEPS)) expect(contract).toContain(`${name}@${version}`)
    expect(contract).toContain('react-three-fiber')
  })

  it('makes the img2threejs group a view rather than an entity', () => {
    expect(engineContract()).toContain('The Group is a VIEW, never an entity')
  })
})

describe('engineGateRules', () => {
  it('blocks a pass outright rather than only costing score', () => {
    expect(engineGateRules()).toContain('"pass" MUST be false')
  })
})

describe('scaffoldEngine', () => {
  it('creates the manifest, the layout and the gate', () => {
    const dir = workspace()
    const result = scaffoldEngine(dir)
    expect(result.created).toContain('package.json')
    expect(result.created).toContain('tools/engine-gate.mjs')
    expect(fs.existsSync(path.join(dir, 'src/sim/systems'))).toBe(true)
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
    expect(pkg.dependencies).toMatchObject(ENGINE_DEPS)
  })

  it('never clobbers a game that has grown its own manifest', () => {
    const dir = workspace()
    scaffoldEngine(dir)
    const pkgPath = path.join(dir, 'package.json')
    const grown = { ...JSON.parse(fs.readFileSync(pkgPath, 'utf8')), name: 'renamed-by-the-game' }
    fs.writeFileSync(pkgPath, JSON.stringify(grown, null, 2))

    const second = scaffoldEngine(dir)

    expect(second.created).not.toContain('package.json')
    expect(JSON.parse(fs.readFileSync(pkgPath, 'utf8')).name).toBe('renamed-by-the-game')
  })

  it('restores a gate a worker weakened, since a gate you can edit is not a gate', () => {
    const dir = workspace()
    scaffoldEngine(dir)
    const gatePath = path.join(dir, 'tools/engine-gate.mjs')
    fs.writeFileSync(gatePath, 'process.exit(0)\n')

    const second = scaffoldEngine(dir)

    expect(second.refreshed).toContain('tools/engine-gate.mjs')
    expect(fs.readFileSync(gatePath, 'utf8')).toContain('bitecs-0.4-api')
  })

  it('refuses a symlinked scaffold directory instead of writing outside the workspace', () => {
    const dir = workspace()
    const outside = workspace()
    fs.symlinkSync(outside, path.join(dir, 'tools'))

    expect(() => scaffoldEngine(dir)).toThrow(/real directory/i)
    expect(fs.readdirSync(outside)).toEqual([])
  })

  it('refuses to refresh a hard-linked gate', () => {
    const dir = workspace()
    scaffoldEngine(dir)
    const gatePath = path.join(dir, 'tools/engine-gate.mjs')
    const outside = path.join(workspace(), 'outside.mjs')
    fs.writeFileSync(outside, 'outside bytes\n')
    fs.unlinkSync(gatePath)
    fs.linkSync(outside, gatePath)

    expect(() => scaffoldEngine(dir)).toThrow(/unique regular file/i)
    expect(fs.readFileSync(outside, 'utf8')).toBe('outside bytes\n')
  })
})

/** A minimal workspace the gate is happy with, so a test can vary one thing. */
function passingWorkspace(): string {
  const dir = workspace()
  scaffoldEngine(dir)
  fs.writeFileSync(path.join(dir, 'src/sim/world.ts'), `export const step = () => {}\n`)
  fs.writeFileSync(path.join(dir, 'src/render/view.ts'), `export const sync = () => {}\n`)
  return dir
}

/** Put a cast in the pack, the way the Reference Study writes one. */
function withCast(dir: string, names: string[]): void {
  fs.mkdirSync(path.join(dir, 'reference/build-1'), { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'reference/build-1/manifest.json'),
    JSON.stringify({ sources: [{ url: 'https://example.com' }], cast: names.map((name) => ({ name })) }),
  )
}

function sculpted(dir: string, name: string): void {
  fs.mkdirSync(path.join(dir, 'src/assets'), { recursive: true })
  fs.writeFileSync(path.join(dir, `src/assets/${name}.ts`), `export const build = () => {}\n`)
  fs.mkdirSync(path.join(dir, '.img2threejs', name), { recursive: true })
  fs.writeFileSync(path.join(dir, '.img2threejs', name, 'state.json'), '{}')
}

describe('the gate and the cast', () => {
  it('passes when every named object has a factory behind it', () => {
    const dir = passingWorkspace()
    withCast(dir, ['samoyed', 'wolf'])
    sculpted(dir, 'samoyed')
    sculpted(dir, 'wolf')

    const { code, report } = runGate(dir)

    expect(failed(report)).toEqual([])
    expect(code).toBe(0)
  })

  it('catches an object the Reference Study named and nothing ever built', () => {
    const dir = passingWorkspace()
    withCast(dir, ['samoyed', 'wolf'])
    sculpted(dir, 'samoyed')

    const { code, report } = runGate(dir)

    expect(failed(report)).toContain('cast-built')
    expect(report.checks.find((c) => c.id === 'cast-built')?.violations[0]?.text).toContain('wolf is in the cast but has no factory')
    expect(code).toBe(1)
  })

  it('allows a hand-modelled fallback but says so', () => {
    // An entry the Asset Build could not crop is legitimately modelled by the
    // implementer. Failing the build for that would only teach a worker to
    // fake a state file, so it is reported rather than enforced.
    const dir = passingWorkspace()
    withCast(dir, ['samoyed'])
    fs.mkdirSync(path.join(dir, 'src/assets'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'src/assets/samoyed.ts'), `export const build = () => {}\n`)

    const { code, report } = runGate(dir)

    expect(failed(report)).toEqual([])
    expect(code).toBe(0)
    expect(report.checks.find((c) => c.id === 'cast-built')?.notes?.[0]?.text).toContain('modelled by hand')
  })

  it('says nothing about assets for a game with no cast at all', () => {
    const dir = passingWorkspace()
    withCast(dir, [])

    expect(failed(runGate(dir).report)).toEqual([])
  })

  it('passes a workspace with no Reference Pack, rather than failing on its absence', () => {
    expect(failed(runGate(passingWorkspace()).report)).toEqual([])
  })
})

describe('the gate itself', () => {
  it('passes a workspace that is on the stack and inside the boundaries', () => {
    const dir = workspace()
    scaffoldEngine(dir)
    fs.writeFileSync(
      path.join(dir, 'src/sim/systems/movement.ts'),
      `import { query } from 'bitecs'\nconst scratch = { x: 0 }\nexport const movementSystem = (world) => {\n  for (const eid of query(world, [world.components.Transform])) scratch.x = eid\n}\n`,
    )
    fs.writeFileSync(path.join(dir, 'src/render/view.ts'), `export const sync = (mesh, x) => { mesh.position.x = x }\n`)

    const { code, report } = runGate(dir)

    expect(failed(report)).toEqual([])
    expect(code).toBe(0)
  })

  it('catches bitECS 0.3 code, which is what a model writes from memory', () => {
    const dir = workspace()
    scaffoldEngine(dir)
    fs.writeFileSync(
      path.join(dir, 'src/sim/components.ts'),
      `import { defineComponent, Types } from 'bitecs'\nexport const Position = defineComponent({ x: Types.f32 })\n`,
    )

    const { code, report } = runGate(dir)

    expect(failed(report)).toContain('bitecs-0.4-api')
    expect(code).toBe(1)
  })

  it('catches the object-oriented game the build writes when left alone', () => {
    const dir = workspace()
    scaffoldEngine(dir)
    fs.writeFileSync(path.join(dir, 'src/sim/player.ts'), `export class Player {\n  health = 100\n}\n`)
    fs.writeFileSync(path.join(dir, 'src/render/hud.ts'), `export const draw = (o) => o.userData.score\n`)

    const { report } = runGate(dir)

    expect(failed(report)).toContain('no-entity-classes')
    expect(failed(report)).toContain('no-state-on-views')
  })

  it('catches gameplay moving a view directly instead of the Transform component', () => {
    const dir = workspace()
    scaffoldEngine(dir)
    fs.writeFileSync(path.join(dir, 'src/sim/systems/push.ts'), `export const push = (mesh) => { mesh.position.set(1, 2, 3) }\n`)

    expect(failed(runGate(dir).report)).toContain('transform-writes')
  })

  it('catches the simulation importing three, which is the boundary breaking', () => {
    const dir = workspace()
    scaffoldEngine(dir)
    fs.writeFileSync(path.join(dir, 'src/sim/world.ts'), `import * as THREE from 'three'\nexport const up = THREE.Object3D.DEFAULT_UP\n`)

    expect(failed(runGate(dir).report)).toContain('sim-is-headless')
  })

  it('catches per-frame allocation, the thing bitECS is here to avoid', () => {
    const dir = workspace()
    scaffoldEngine(dir)
    fs.writeFileSync(
      path.join(dir, 'src/sim/systems/aim.ts'),
      `export const aim = () => {\n  const dir = new Vector3(0, 1, 0)\n  return dir\n}\n`,
    )

    expect(failed(runGate(dir).report)).toContain('no-per-frame-alloc')
  })

  it('catches a game with no simulation layer, which would pass the scoped checks by default', () => {
    const dir = workspace()
    scaffoldEngine(dir)
    fs.writeFileSync(path.join(dir, 'src/game.ts'), `export const start = () => {}\n`)

    const { report } = runGate(dir)
    const layout = report.checks.find((c) => c.id === 'engine-layout')!

    expect(layout.ok).toBe(false)
    expect(layout.violations.map((v) => v.file)).toEqual(['src/sim/', 'src/render/'])
  })

  it('catches an unpinned dependency and a smuggled-in React', () => {
    const dir = workspace()
    scaffoldEngine(dir)
    const pkgPath = path.join(dir, 'package.json')
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
    pkg.dependencies.three = '^0.185.1'
    pkg.dependencies['@react-three/fiber'] = '9.0.0'
    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2))

    const { report } = runGate(dir)
    const pinned = report.checks.find((c) => c.id === 'pinned-stack')!

    expect(pinned.violations.map((v) => v.text).join(' ')).toContain('must be pinned to exactly 0.185.1')
    expect(pinned.violations.map((v) => v.text).join(' ')).toContain('@react-three/fiber is banned')
  })
})
