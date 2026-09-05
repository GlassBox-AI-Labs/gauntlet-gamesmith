import fs from 'node:fs'
import path from 'node:path'
import type { LoopRecord, ReferencePack, RunRecord } from '../shared/loop'
import { runtimeMs } from '../shared/run-timing'
import { describeModels } from '../shared/models'
import { redactLogText } from '../shared/redact-log'
import { PRICE_TABLE_VERSION } from './pricing'
import { MAX_IMAGE_BYTES, MAX_VIDEO_BYTES } from './media-limits'
import {
  boundedOwnedDirectoryEntries,
  captureOwnedDirectory,
  ownedFileStat,
  readOwnedFile,
  type OwnedDirectoryBoundary,
} from './owned-tree'
import type { WorkspaceRootIdentity } from './workspace-boundary'

const SPARK = '▁▂▃▄▅▆▇█'
const MAX_CRITIQUE_ROUNDS = 100
const MAX_EVIDENCE_FILES = 32
const MAX_VIDEOS = 4
const MAX_DIRECTORY_ENTRIES = 2_000
const MAX_PAIRS_BYTES = 256 * 1024
const MAX_PAIRS_MD_BYTES = 64 * 1024
const MAX_PROJECTED_IMAGE_BYTES = 128 * 1024 * 1024
const MAX_REPORT_RUNS = 500
const MAX_REPORT_CHARS = 2 * 1024 * 1024
const lexical = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

export interface CritiqueArtifacts {
  round: number
  shots: string[]
  refs: string[]
  videos: string[]
  pairs: { shot: string; ref: string; winner: 'shot' | 'ref' | 'tie'; why: string }[] | null
  pairsMd: string | null
  /** True when a safety cap omitted additional evidence from this projection. */
  truncated: boolean
}

function boundedText(directory: OwnedDirectoryBoundary, name: string, maxBytes: number, maxChars: number): string | null {
  try {
    return readOwnedFile(directory, name, maxBytes, name).toString('utf8').slice(0, maxChars)
  } catch {
    return null
  }
}

function parseRoundName(name: string): number | null {
  const match = /^round-([1-9]\d{0,4})$/.exec(name)
  if (!match) return null
  const round = Number(match[1])
  return Number.isSafeInteger(round) && round >= 1 && round <= 10_000 ? round : null
}

function safePairPath(roundName: string, value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512 || value.includes('\\')) return null
  const relative = value.replace(/^\.\//, '')
  if (path.posix.isAbsolute(relative)) return null
  const normalized = path.posix.normalize(relative)
  if (normalized === '..' || normalized.startsWith('../') || normalized.includes('/../')) return null
  const projected = path.posix.join('critique', roundName, normalized)
  return redactLogText(projected) === projected ? projected : null
}

/** Collect the critic's saved evidence (screenshots, reference stills, pair notes) from the workspace. */
export function scanCritiqueArtifacts(workspaceDir: string, expectedWorkspace?: WorkspaceRootIdentity): CritiqueArtifacts[] {
  let base: OwnedDirectoryBoundary
  let baseTruncated = false
  let entries: fs.Dirent[] = []
  try {
    base = captureOwnedDirectory(workspaceDir, path.join(fs.realpathSync(workspaceDir), 'critique'), expectedWorkspace)
    const bounded = boundedOwnedDirectoryEntries(base, MAX_DIRECTORY_ENTRIES)
    entries = bounded.entries
    baseTruncated = bounded.truncated
  } catch {
    return []
  }
  const roundEntries = entries
    .flatMap((entry) => {
      if (!entry.isDirectory() || entry.isSymbolicLink()) return []
      const round = parseRoundName(entry.name)
      return round === null ? [] : [{ entry, round }]
    })
    .sort((a, b) => a.round - b.round)
  const artifacts: CritiqueArtifacts[] = []
  for (const { entry, round } of roundEntries.slice(0, MAX_CRITIQUE_ROUNDS)) {
    const name = entry.name
    let roundRoot: OwnedDirectoryBoundary
    try {
      roundRoot = captureOwnedDirectory(base.ownerRoot, path.join(base.path, name), expectedWorkspace)
    } catch {
      continue
    }
    const ownedDirectory = (sub: string): OwnedDirectoryBoundary | null => {
      let current = roundRoot.path
      try {
        for (const segment of sub === '.' ? [] : sub.split('/')) {
          if (!segment || segment === '.' || segment === '..') return null
          current = path.join(current, segment)
        }
        const boundary = sub === '.' ? roundRoot : captureOwnedDirectory(base.ownerRoot, current, expectedWorkspace)
        const relative = path.relative(roundRoot.path, boundary.path)
        return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative)) ? boundary : null
      } catch {
        return null
      }
    }
    let truncated = baseTruncated || roundEntries.length > MAX_CRITIQUE_ROUNDS
    let projectedImageBytes = 0
    const listFiles = (sub: string, pattern: RegExp): string[] => {
      try {
        const directory = ownedDirectory(sub)
        if (!directory) return []
        const bounded = boundedOwnedDirectoryEntries(directory, MAX_DIRECTORY_ENTRIES)
        if (bounded.truncated) truncated = true
        const matching = bounded.entries
          .filter((file) => {
            if (!file.isFile() || file.isSymbolicLink() || !pattern.test(file.name)) return false
            if (redactLogText(file.name) !== file.name) {
              truncated = true
              return false
            }
            return true
          })
          .sort((a, b) => lexical(a.name, b.name))
        if (matching.length > MAX_EVIDENCE_FILES) truncated = true
        return matching.slice(0, MAX_EVIDENCE_FILES)
          .filter((file) => {
            try {
              const stat = ownedFileStat(directory, file.name)
              if (IMAGE.test(file.name)) {
                if (stat.size > MAX_IMAGE_BYTES || projectedImageBytes + stat.size > MAX_PROJECTED_IMAGE_BYTES) {
                  truncated = true
                  return false
                }
                projectedImageBytes += stat.size
              }
              if (/\.(webm|mp4|mov)$/i.test(file.name) && stat.size > MAX_VIDEO_BYTES) {
                truncated = true
                return false
              }
              return true
            } catch {
              return false
            }
          })
          .map((file) => path.posix.join('critique', name, sub, file.name))
      } catch {
        return []
      }
    }
    const IMAGE = /\.(png|jpe?g|webp|gif)$/i
    const movies = /\.(webm|mp4|mov|mkv)$/i
    const allVideos = [...listFiles('.', movies), ...listFiles('video', movies), ...listFiles('videos', movies), ...listFiles('shots', movies)]
    if (allVideos.length > MAX_VIDEOS) truncated = true
    const videos = allVideos.slice(0, MAX_VIDEOS)
    const pairsMdRaw = boundedText(roundRoot, 'pairs.md', MAX_PAIRS_MD_BYTES, 4_000)
    const pairsMd = pairsMdRaw == null ? null : redactLogText(pairsMdRaw)
    let pairs: CritiqueArtifacts['pairs'] = null
    try {
      const pairsText = boundedText(roundRoot, 'pairs.json', MAX_PAIRS_BYTES, MAX_PAIRS_BYTES)
      const raw = pairsText == null ? null : JSON.parse(pairsText) as unknown
      if (Array.isArray(raw)) {
        if (raw.length > 24) truncated = true
        const parsed = raw.slice(0, 24)
          .map((p) => {
            if (!p || typeof p !== 'object' || Array.isArray(p)) return null
            const pair = p as Record<string, unknown>
            const shot = safePairPath(name, pair.shot)
            const ref = safePairPath(name, pair.ref)
            if (!shot || !ref) return null
            if (pair.winner !== 'shot' && pair.winner !== 'ref' && pair.winner !== 'tie') return null
            if (typeof pair.why !== 'string' || pair.why.length > 4_000) return null
            return { shot, ref, winner: pair.winner as 'shot' | 'ref' | 'tie', why: redactLogText(pair.why.slice(0, 600)) }
          })
          .filter((p): p is NonNullable<typeof p> => p !== null)
        if (parsed.length > 0) pairs = parsed
      }
    } catch {
      /* no machine-readable pairs */
    }
    const allShots = [...listFiles('shots', IMAGE), ...listFiles('shots/motion', IMAGE)]
    const allRefs = [...listFiles('refs', IMAGE), ...listFiles('refs/motion', IMAGE)]
    if (allShots.length > MAX_EVIDENCE_FILES || allRefs.length > MAX_EVIDENCE_FILES) truncated = true
    artifacts.push({
      round,
      shots: allShots.slice(0, MAX_EVIDENCE_FILES),
      refs: allRefs.slice(0, MAX_EVIDENCE_FILES),
      videos,
      pairs,
      pairsMd,
      truncated,
    })
  }
  return artifacts.sort((a, b) => a.round - b.round)
}

function fmtTokens(n: number | null | undefined): string {
  if (n == null) return '—'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

function fmtDuration(ms: number | null | undefined): string {
  if (ms == null) return '—'
  const m = Math.floor(ms / 60_000)
  const s = Math.round((ms % 60_000) / 1000)
  return m >= 60 ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m` : `${m}m${String(s).padStart(2, '0')}s`
}

function spark(score: number): string {
  return SPARK[Math.min(SPARK.length - 1, Math.max(0, Math.round(score * (SPARK.length - 1))))]
}

export function buildReport(
  loop: LoopRecord,
  runs: RunRecord[],
  artifacts: CritiqueArtifacts[] = [],
  referencePack?: ReferencePack,
  canonical?: { totalRuns: number; aggregate: { costUsd: number; inputTokens: number; outputTokens: number } },
): string {
  const totalRuns = canonical?.totalRuns ?? runs.length
  runs = runs.slice(-MAX_REPORT_RUNS)
  const done = runs.filter((r) => r.status !== 'queued')
  const totalCost = canonical?.aggregate.costUsd ?? done.reduce((sum, r) => sum + (r.costUsd ?? 0), 0)
  const totalIn = canonical?.aggregate.inputTokens ?? done.reduce((sum, r) => sum + (r.inputTokens ?? 0), 0)
  const totalOut = canonical?.aggregate.outputTokens ?? done.reduce((sum, r) => sum + (r.outputTokens ?? 0), 0)
  const verdicts = runs.filter((r) => r.role === 'critique' && r.verdict).map((r) => ({ round: r.round, verdict: r.verdict! }))
  const lastFinished = done.reduce<string | null>((last, r) => (r.finishedAt && (!last || r.finishedAt > last) ? r.finishedAt : last), null)
  const wallClockMs = lastFinished ? new Date(lastFinished).getTime() - new Date(loop.createdAt).getTime() : null

  const lines: string[] = []
  lines.push(`# Gauntlet Gamesmith report — ${loop.status.toUpperCase()}`)
  lines.push('')
  lines.push(`- **Goal:** ${loop.prompt.replace(/\s+/g, ' ').slice(0, 180)}${loop.prompt.length > 180 ? '…' : ''}`)
  lines.push(`- **Workspace:** ${loop.workspaceDir}`)
  lines.push(
    `- **Models:** ${describeModels(loop.models)}`,
  )
  lines.push(`- **Started:** ${loop.createdAt} · **Updated:** ${loop.updatedAt}${wallClockMs != null ? ` · **Wall clock:** ${fmtDuration(wallClockMs)}` : ''}`)
  lines.push(
    `- **Rounds:** ${loop.round} of ${loop.maxRounds} · **Equivalent API cost:** $${totalCost.toFixed(2)}${loop.budgetUsd ? ` of $${loop.budgetUsd.toFixed(2)} budget` : ''} · **Tokens (all runs):** in ${fmtTokens(totalIn)} / out ${fmtTokens(totalOut)}`,
  )
  if (loop.stopReason) lines.push(`- **Outcome:** ${loop.stopReason}`)
  lines.push('')

  if (verdicts.length > 0) {
    lines.push('## Score trend')
    lines.push('')
    lines.push(`${verdicts.map((v) => v.verdict.score.toFixed(2)).join(' → ')}   ${verdicts.map((v) => spark(v.verdict.score)).join('')}`)
    lines.push('')
  }

  lines.push('## Rounds')
  lines.push('')
  if (totalRuns > runs.length) {
    lines.push(`_Showing the newest ${runs.length} of ${totalRuns} attempts; canonical totals above include every attempt._`)
    lines.push('')
  }
  lines.push('| Round | Role | Revision | Model | Status | Equivalent API cost | Tokens in | Tokens out | Runtime | Score |')
  lines.push('|---|---|---|---|---|---|---|---|---|---|')
  for (const run of runs) {
    const score = run.verdict ? `${run.verdict.score.toFixed(2)}${run.verdict.pass ? ' ✓ PASS' : ''}` : ''
    lines.push(
      `| ${run.role === 'reference' ? '—' : run.round} | ${run.role} | ${run.revision?.slice(0, 12) ?? '—'} | ${run.model ?? '—'} | ${run.status} | ${run.costUsd != null ? `$${run.costUsd.toFixed(2)}` : '—'} | ${fmtTokens(run.inputTokens)} | ${fmtTokens(run.outputTokens)} | ${fmtDuration(runtimeMs(run))} | ${score} |`,
    )
  }
  lines.push('')

  if (referencePack) {
    lines.push('## Reference Pack')
    lines.push('')
    lines.push(`- **Status:** ${referencePack.ready ? 'ready' : 'incomplete'} · **Path:** ${referencePack.root}/`)
    lines.push(`- **Evidence:** ${referencePack.images.length} stills · ${referencePack.motion.length} motion frames · ${referencePack.journey.length} journey shots · ${referencePack.videos.length} videos`)
    if (referencePack.issues.length > 0) lines.push(`- **Missing:** ${referencePack.issues.join('; ')}`)
    if (referencePack.readme) {
      lines.push('')
      lines.push(referencePack.readme.trim().slice(0, 4000))
    }
    lines.push('')
  }

  const latest = verdicts.at(-1)
  if (latest) {
    lines.push(`## Latest verdict (round ${latest.round}, score ${latest.verdict.score.toFixed(2)})`)
    lines.push('')
    lines.push(latest.verdict.summary || '(no summary)')
    lines.push('')
    for (const finding of latest.verdict.findings) lines.push(`- **[${finding.severity}]** ${finding.text}`)
    lines.push('')
  }

  const latestEvidence = artifacts.at(-1)
  if (latestEvidence && (latestEvidence.shots.length > 0 || latestEvidence.refs.length > 0)) {
    lines.push(`## Critic evidence (round ${latestEvidence.round})`)
    lines.push('')
    for (const prior of artifacts.slice(0, -1)) {
      lines.push(`Round ${prior.round}: ${prior.shots.length} shots · ${prior.refs.length} refs — critique/round-${prior.round}/`)
    }
    if (artifacts.length > 1) lines.push('')
    if (latestEvidence.truncated) {
      lines.push('_Evidence projection truncated at the configured safety limits; open the raw artifact directory for the complete set._')
      lines.push('')
    }
    if (latestEvidence.shots.length > 0) {
      lines.push(`**This build** (${latestEvidence.shots.length} shots):`)
      lines.push('')
      for (const shot of latestEvidence.shots.slice(0, 6)) lines.push(`![shot](${shot})`)
      lines.push('')
    }
    if (latestEvidence.refs.length > 0) {
      lines.push(`**AAA reference** (${latestEvidence.refs.length} stills):`)
      lines.push('')
      for (const ref of latestEvidence.refs.slice(0, 6)) lines.push(`![ref](${ref})`)
      lines.push('')
    }
    if (latestEvidence.pairsMd) {
      lines.push('### Side-by-side pair notes')
      lines.push('')
      lines.push(latestEvidence.pairsMd.trim())
      lines.push('')
    }
  }

  const lastWithAgents = [...runs].reverse().find((r) => r.metrics && r.metrics.agents.length > 0)
  if (lastWithAgents?.metrics) {
    lines.push(`## Agent breakdown (round ${lastWithAgents.round} ${lastWithAgents.role})`)
    lines.push('')
    for (const agent of lastWithAgents.metrics.agents) {
      if (agent.source === 'workflow') continue
      const indent =
        agent.id === 'orchestrator' || agent.id === 'critic' ? '- ' : agent.parentId && agent.parentId !== 'orchestrator' ? '    - ↳ ' : '  - ↳ '
      lines.push(
        `${indent}**${agent.label}** (${agent.model ?? '?'}): ${agent.messages} msgs · in ${fmtTokens(agent.tokens.input)} · out ${fmtTokens(agent.tokens.output)} · cache r/w ${fmtTokens(agent.tokens.cacheRead)}/${fmtTokens(agent.tokens.cacheWrite)}`,
      )
    }
    // Workflow agents report one scalar token count, so they get their own
    // section rather than columns they cannot fill.
    const workflow = lastWithAgents.metrics.agents.filter((a) => a.source === 'workflow')
    if (workflow.length > 0) {
      const wfTokens = workflow.reduce((sum, a) => sum + (a.totalTokens ?? 0), 0)
      lines.push(`- **workflow fan-out**: ${workflow.length} agents · ${fmtTokens(wfTokens)} tokens`)
      let phase: string | null = null
      for (const agent of workflow) {
        if (agent.phase !== phase) {
          phase = agent.phase ?? null
          if (phase) lines.push(`  - _${phase}_`)
        }
        lines.push(
          `    - ${agent.state === 'done' ? '✓' : '⋯'} **${agent.label}** (${agent.model ?? '?'}): ${fmtTokens(agent.totalTokens ?? 0)} tokens · ${agent.toolCalls ?? 0} tools`,
        )
      }
    }
    for (const [model, mu] of Object.entries(lastWithAgents.metrics.perModel)) {
      lines.push(`- ${model}: ${mu.costUsd != null ? `$${mu.costUsd.toFixed(2)}` : '$—'} · in ${fmtTokens(mu.tokens.input)} · out ${fmtTokens(mu.tokens.output)}`)
    }
    lines.push('')
  }

  lines.push(
    `_Costs are equivalent API cost estimates from price table ${PRICE_TABLE_VERSION} (tokens × published list rates). Claude's CLI modelUsage is the token source at run end; Grok's own costUsdTicks is not list price and is not used. Runs themselves use subscription logins. Ledger: ledger.db in app user data._`,
  )
  const projected = redactLogText(lines.join('\n'))
  if (projected.length <= MAX_REPORT_CHARS) return projected
  return `${projected.slice(0, MAX_REPORT_CHARS)}\n\n_Report projection truncated at the 2 MiB display limit; the exported ledger retains complete history._`
}
