import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { BuildRecord, PhaseAttempt } from '../shared/build'
import { DEFAULT_CRITIC, resolveModels } from '../shared/models'
import { buildReport, scanCritiqueArtifacts } from './report'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

const build: BuildRecord = {
  id: 'l1',
  title: 'Pac-man',
  prompt: 'Build Pac-Man at AAA quality',
  workspaceDir: '/tmp/w',
  maxRounds: 10,
  budgetUsd: 100,
  models: resolveModels({ orchestratorModel: 'claude-fable-5', subagentModel: 'claude-opus-5', subagentEffort: 'medium' }, DEFAULT_CRITIC),
  status: 'running',
  round: 2,
  totalCostUsd: 12.5,
  stopReason: null,
  playTrusted: true,
  createdAt: '2026-08-30T20:00:00.000Z',
  updatedAt: '2026-08-30T21:00:00.000Z',
}

function attempt(partial: Partial<PhaseAttempt>): PhaseAttempt {
  return {
    id: 'r',
    buildId: 'l1',
    round: 1,
    role: 'implement',
    harness: 'claude',
    status: 'succeeded',
    prompt: 'p',
    model: 'claude-fable-5',
    effort: null,
    cliVersion: null,
    priceTableVersion: null,
    costSource: null,
    promptSha256: null,
    accountLabel: null,
    machineLabel: null,
    authMode: null,
    summary: null,
    verdict: null,
    metrics: null,
    costUsd: null,
    inputTokens: null,
    outputTokens: null,
    numTurns: null,
    durationMs: null,
    sessionId: null,
    revision: null,
    error: null,
    createdAt: '2026-08-30T20:00:01.000Z',
    startedAt: null,
    finishedAt: '2026-08-30T20:30:00.000Z',
    ...partial,
  }
}

describe('buildReport', () => {
  it('sums cost and tokens across finished builds and shows the score trend', () => {
    const report = buildReport(build, [
      attempt({ id: 'a', costUsd: 10, inputTokens: 1_500_000, outputTokens: 90_000, durationMs: 8 * 60_000 }),
      attempt({
        id: 'b',
        role: 'critique',
        harness: 'codex',
        model: 'gpt-5.6-sol',
        inputTokens: 500_000,
        outputTokens: 10_000,
        verdict: { score: 0.42, pass: false, summary: 'Not AAA yet', findings: [{ severity: 'major', text: 'flat lighting' }] },
      }),
      attempt({ id: 'c', round: 2, status: 'queued', costUsd: 999 }),
    ])
    expect(report).toContain('**Equivalent API cost:** $10.00 of $100.00 budget')
    expect(report).toContain('in 2.00M / out 100.0k')
    expect(report).toContain('| Runtime | Score |')
    // Per-attempt runtime, not time-since-build-start: this attempt took 8m of the 30m elapsed.
    expect(report).toContain('| 8m00s |')
    expect(report).toContain('0.42')
    expect(report).toContain('flat lighting')
  })

  it('handles a build with no verdicts yet', () => {
    const report = buildReport(build, [attempt({ id: 'a', status: 'running' })])
    expect(report).toContain('Gauntlet Gamesmith report')
    expect(report).not.toContain('Score trend')
  })

  it('redacts credential-shaped strings at the complete report projection boundary', () => {
    const report = buildReport(
      { ...build, title: 'DATABASE_URL=postgres://user:password@db.example/app' },
      [attempt({
        role: 'critique',
        summary: 'AWS_SESSION_TOKEN=session-secret',
        verdict: {
          score: 0.5,
          pass: false,
          summary: 'AWS_SESSION_TOKEN=session-secret',
          findings: [{ severity: 'major', text: 'Cookie: session=browser-secret' }],
        },
      })],
    )

    expect(report).not.toContain('password@')
    expect(report).not.toContain('session-secret')
    expect(report).not.toContain('browser-secret')
    expect(report).toContain('[REDACTED]')
  })

  it('shows the Reference Study as a pre-round result', () => {
    const report = buildReport(build, [attempt({ role: 'reference', round: 0 })], [], {
      root: 'reference/l1',
      ready: true,
      issues: [],
      images: Array.from({ length: 8 }, (_, index) => `reference/l1/images/${index}.jpg`),
      motion: Array.from({ length: 8 }, (_, index) => `reference/l1/motion/${index}.jpg`),
      videos: ['reference/l1/video/gameplay.webm'],
      journey: Array.from({ length: 4 }, (_, index) => `reference/l1/journey/0${index + 1}-shot.png`),
      objects: [],
      castMd: 'none',
      castCount: 0,
      readme: '# Visual target',
      manifest: '{}',
      journeyMd: '# Walkthrough',
      storyMd: '# Premise',
      researchMd: '# What players say',
    })
    expect(report).toContain('| — | reference |')
    expect(report).toContain('## Reference Pack')
    expect(report).toContain('8 stills · 8 motion frames · 4 journey shots · 1 videos')
    expect(report).toContain('# Visual target')
  })
})

describe('scanCritiqueArtifacts', () => {
  it('bounds evidence and rejects symlinks and traversal-bearing pairs', () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'gauntlet-report-'))
    tempDirs.push(workspace)
    const round = path.join(workspace, 'critique', 'round-1')
    const shots = path.join(round, 'shots')
    fs.mkdirSync(shots, { recursive: true })
    for (let index = 0; index < 120; index += 1) fs.writeFileSync(path.join(shots, `${index}.png`), 'image')
    const outside = path.join(workspace, 'outside.png')
    fs.writeFileSync(outside, 'secret')
    fs.symlinkSync(outside, path.join(shots, 'linked.png'))
    fs.symlinkSync(path.dirname(outside), path.join(round, 'refs'))
    const token = `ghp_${'a'.repeat(36)}`
    fs.writeFileSync(path.join(round, 'pairs.md'), `Authorization: Bearer ${token}`)
    fs.writeFileSync(path.join(round, 'pairs.json'), JSON.stringify([
      { shot: '../outside.png', ref: 'refs/a.png', winner: 'shot', why: 'escape' },
      { shot: 'shots/1.png', ref: 'refs/a.png', winner: 'tie', why: `OPENAI_API_KEY=${token}` },
      { shot: '/etc/passwd', ref: 'refs/a.png', winner: 'ref', why: 'absolute' },
    ]))

    const [artifact] = scanCritiqueArtifacts(workspace)
    expect(artifact.shots).toHaveLength(32)
    expect(artifact.truncated).toBe(true)
    expect(artifact.shots).not.toContain('critique/round-1/shots/linked.png')
    expect(artifact.refs).toEqual([])
    expect(artifact.pairs).toEqual([
      { shot: 'critique/round-1/shots/1.png', ref: 'critique/round-1/refs/a.png', winner: 'tie', why: 'OPENAI_API_KEY=[REDACTED]' },
    ])
    expect(artifact.pairsMd).toBe('Authorization: Bearer [REDACTED]')
  })

  it('refuses oversized machine-readable pair files before parsing', () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'gauntlet-report-'))
    tempDirs.push(workspace)
    const round = path.join(workspace, 'critique', 'round-1')
    fs.mkdirSync(round, { recursive: true })
    fs.writeFileSync(path.join(round, 'pairs.json'), ' '.repeat(256 * 1024 + 1))
    expect(scanCritiqueArtifacts(workspace)[0]?.pairs).toBeNull()
  })

  it('omits credential-shaped evidence and pair paths from renderer projections', () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'gauntlet-report-'))
    tempDirs.push(workspace)
    const round = path.join(workspace, 'critique', 'round-1')
    const shots = path.join(round, 'shots')
    const refs = path.join(round, 'refs')
    fs.mkdirSync(shots, { recursive: true })
    fs.mkdirSync(refs, { recursive: true })
    const credentialName = `ghp_${'a'.repeat(36)}.png`
    fs.writeFileSync(path.join(shots, credentialName), 'secret-looking path')
    fs.writeFileSync(path.join(shots, 'safe.png'), 'safe')
    fs.writeFileSync(path.join(refs, 'safe.png'), 'safe')
    fs.writeFileSync(path.join(round, 'pairs.json'), JSON.stringify([
      { shot: `shots/${credentialName}`, ref: 'refs/safe.png', winner: 'tie', why: 'unsafe path' },
    ]))

    const [artifact] = scanCritiqueArtifacts(workspace)
    expect(artifact.shots).toEqual(['critique/round-1/shots/safe.png'])
    expect(artifact.pairs).toBeNull()
    expect(artifact.truncated).toBe(true)
  })

  it('excludes oversized images and marks the critique projection truncated', () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'gauntlet-report-'))
    tempDirs.push(workspace)
    const shots = path.join(workspace, 'critique', 'round-1', 'shots')
    fs.mkdirSync(shots, { recursive: true })
    const oversized = path.join(shots, 'oversized.png')
    fs.writeFileSync(oversized, '')
    fs.truncateSync(oversized, 32 * 1024 * 1024 + 1)

    const [artifact] = scanCritiqueArtifacts(workspace)
    expect(artifact.shots).toEqual([])
    expect(artifact.truncated).toBe(true)
  })

  it('excludes videos that the media server cannot serve', () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'gauntlet-report-'))
    tempDirs.push(workspace)
    const videoDir = path.join(workspace, 'critique', 'round-1', 'video')
    fs.mkdirSync(videoDir, { recursive: true })
    const oversized = path.join(videoDir, 'oversized.mp4')
    fs.writeFileSync(oversized, '')
    fs.truncateSync(oversized, 512 * 1024 * 1024 + 1)

    const [artifact] = scanCritiqueArtifacts(workspace)
    expect(artifact.videos).toEqual([])
    expect(artifact.truncated).toBe(true)
  })

  it('does not follow an intermediate evidence-directory symlink', () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'gauntlet-report-'))
    tempDirs.push(workspace)
    const round = path.join(workspace, 'critique', 'round-1')
    const outside = path.join(workspace, 'outside', 'motion')
    fs.mkdirSync(round, { recursive: true })
    fs.mkdirSync(outside, { recursive: true })
    fs.writeFileSync(path.join(outside, 'secret.png'), 'secret')
    fs.symlinkSync(path.dirname(outside), path.join(round, 'shots'))

    expect(scanCritiqueArtifacts(workspace)[0].shots).toEqual([])
  })

  it('applies the round cap in numeric round order', () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'gauntlet-report-'))
    tempDirs.push(workspace)
    for (let round = 1; round <= 101; round += 1) {
      fs.mkdirSync(path.join(workspace, 'critique', `round-${round}`), { recursive: true })
    }
    const artifacts = scanCritiqueArtifacts(workspace)
    expect(artifacts).toHaveLength(100)
    expect(artifacts.at(-1)?.round).toBe(100)
    expect(artifacts.every((artifact) => artifact.truncated)).toBe(true)
  })

  it('ignores non-canonical or unsafe round directory numbers', () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'gauntlet-report-rounds-'))
    tempDirs.push(workspace)
    for (const name of ['round-1', 'round-01', 'round-0', `round-${'9'.repeat(200)}`]) {
      fs.mkdirSync(path.join(workspace, 'critique', name), { recursive: true })
    }

    expect(scanCritiqueArtifacts(workspace).map((artifact) => artifact.round)).toEqual([1])
  })
})
