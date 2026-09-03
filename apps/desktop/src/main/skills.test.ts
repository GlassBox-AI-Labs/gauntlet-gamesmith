import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { bundledSkillDir, installSkill, SKILL_NAME } from './skills'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gauntlet-skills-'))
  dirs.push(dir)
  return dir
}

/** The two files `isUsable` looks for, plus something to prove a full copy. */
function fakeSkill(root: string, marker = 'v1'): string {
  const dir = path.join(root, 'vendor', SKILL_NAME)
  fs.mkdirSync(path.join(dir, 'forge', 'stage1_intake'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${SKILL_NAME}\n---\n${marker}`)
  fs.writeFileSync(path.join(dir, 'forge', 'state.py'), '# state')
  fs.writeFileSync(path.join(dir, 'forge', 'stage1_intake', 'probe_image.py'), '# probe')
  return dir
}

describe('finding the bundled skill', () => {
  it('uses the packaged resources copy when there is one', () => {
    const resources = tmp()
    const packaged = fakeSkill(resources)
    expect(bundledSkillDir(resources, tmp())).toBe(packaged)
  })

  it('walks up to the repo vendor directory when running unpackaged', () => {
    const repo = tmp()
    const vendored = fakeSkill(repo)
    const deep = path.join(repo, 'apps', 'desktop', 'out', 'main')
    fs.mkdirSync(deep, { recursive: true })
    expect(bundledSkillDir(null, deep)).toBe(vendored)
  })

  it('falls back to the walk-up when the packaged path is empty', () => {
    const repo = tmp()
    const vendored = fakeSkill(repo)
    expect(bundledSkillDir(path.join(tmp(), 'nope'), repo)).toBe(vendored)
  })

  it('is null when the skill was left out of the build', () => {
    expect(bundledSkillDir(null, tmp())).toBeNull()
  })

  it('finds the skill this repo actually vendors', () => {
    // Guards the build itself: if vendor/img2threejs is ever dropped or gutted,
    // the Asset Build halts at runtime and this is where that gets caught first.
    const dir = bundledSkillDir(null, __dirname)
    expect(dir).not.toBeNull()
    expect(fs.existsSync(path.join(dir as string, 'forge', 'state.py'))).toBe(true)
    expect(fs.existsSync(path.join(dir as string, 'forge', 'stage1_intake', 'probe_image.py'))).toBe(true)
  })
})

describe('installing the skill into the harness home', () => {
  it('copies it where CLAUDE_CONFIG_DIR will find it', () => {
    const home = tmp()
    const result = installSkill(home, fakeSkill(tmp()))
    expect(result.status).toBe('installed')
    expect(result.dir).toBe(path.join(home, 'skills', SKILL_NAME))
    expect(fs.readFileSync(path.join(home, 'skills', SKILL_NAME, 'forge', 'state.py'), 'utf8')).toBe('# state')
  })

  it('leaves an up-to-date install alone, so the phase does not recopy every round', () => {
    const home = tmp()
    const source = fakeSkill(tmp())
    installSkill(home, source)
    const marker = path.join(home, 'skills', SKILL_NAME, 'forge', 'state.py')
    const before = fs.statSync(marker).mtimeMs
    expect(installSkill(home, source).status).toBe('current')
    expect(fs.statSync(marker).mtimeMs).toBe(before)
  })

  it('replaces a hand-made symlink, because the app owns that path now', () => {
    const home = tmp()
    const elsewhere = fakeSkill(tmp(), 'someone-elses-checkout')
    const target = path.join(home, 'skills', SKILL_NAME)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.symlinkSync(elsewhere, target)

    const result = installSkill(home, fakeSkill(tmp(), 'bundled'))
    expect(result.status).toBe('replaced')
    expect(fs.lstatSync(target).isSymbolicLink()).toBe(false)
    expect(fs.readFileSync(path.join(target, 'SKILL.md'), 'utf8')).toContain('bundled')
    // The old checkout is left where it was rather than deleted through the link.
    expect(fs.existsSync(path.join(elsewhere, 'SKILL.md'))).toBe(true)
  })

  it('replaces a copy that came from a different source', () => {
    const home = tmp()
    installSkill(home, fakeSkill(tmp(), 'old'))
    const result = installSkill(home, fakeSkill(tmp(), 'new'))
    expect(result.status).toBe('replaced')
    expect(fs.readFileSync(path.join(home, 'skills', SKILL_NAME, 'SKILL.md'), 'utf8')).toContain('new')
  })

  it('reports a missing or gutted source rather than installing half a skill', () => {
    const home = tmp()
    expect(installSkill(home, null).dir).toBeNull()
    expect(installSkill(home, path.join(tmp(), 'gone')).status).toBe('missing-source')

    // SKILL.md alone is not a skill: forge/ is what the sculptor actually runs.
    const hollow = path.join(tmp(), 'hollow')
    fs.mkdirSync(hollow, { recursive: true })
    fs.writeFileSync(path.join(hollow, 'SKILL.md'), 'name: img2threejs')
    expect(installSkill(home, hollow).status).toBe('missing-source')
    expect(fs.existsSync(path.join(home, 'skills', SKILL_NAME))).toBe(false)
  })
})
