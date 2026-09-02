import fs from 'node:fs'
import path from 'node:path'
import type { LoopRecord, ReferencePack, RunRecord } from '../shared/loop'
import { elapsedThroughRunMs } from '../shared/run-timing'
import { describeModels } from '../shared/models'
import { PRICE_TABLE_VERSION } from './pricing'

const SPARK = '▁▂▃▄▅▆▇█'

export interface CritiqueArtifacts {
  round: number
  shots: string[]
  refs: string[]
  videos: string[]
  pairs: { shot: string; ref: string; winner: 'shot' | 'ref' | 'tie'; why: string }[] | null
  pairsMd: string | null
}

/** Collect the critic's saved evidence (screenshots, reference stills, pair notes) from the workspace. */
export function scanCritiqueArtifacts(workspaceDir: string): CritiqueArtifacts[] {
  const base = path.join(workspaceDir, 'critique')
  let entries: string[] = []
  try {
    entries = fs.readdirSync(base)
  } catch {
    return []
  }
  const artifacts: CritiqueArtifacts[] = []
  for (const name of entries) {
    const match = /^round-(\d+)$/.exec(name)
    if (!match) continue
    const listFiles = (sub: string, pattern: RegExp): string[] => {
      try {
        return fs
          .readdirSync(path.join(base, name, sub))
          .filter((file) => pattern.test(file))
          .sort()
          .map((file) => path.posix.join('critique', name, sub, file))
      } catch {
        return []
      }
    }
    const images = /\.(png|jpe?g|webp|gif)$/i
    const movies = /\.(webm|mp4|mov)$/i
    const videos = [...listFiles('.', movies), ...listFiles('video', movies), ...listFiles('videos', movies), ...listFiles('shots', movies)]
    let pairsMd: string | null = null
    try {
      pairsMd = fs.readFileSync(path.join(base, name, 'pairs.md'), 'utf8').slice(0, 4000)
    } catch {
      /* no pair notes */
    }
    let pairs: CritiqueArtifacts['pairs'] = null
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(base, name, 'pairs.json'), 'utf8')) as unknown
      if (Array.isArray(raw)) {
        const parsed = raw
          .map((p) => {
            const pair = p as Record<string, unknown>
            const rel = (v: unknown): string | null =>
              typeof v === 'string' && !v.includes('..') ? path.posix.join('critique', name, v.replace(/^\.?\//, '')) : null
            const shot = rel(pair.shot)
            const ref = rel(pair.ref)
            if (!shot || !ref) return null
            const winner: 'shot' | 'ref' | 'tie' = pair.winner === 'shot' || pair.winner === 'tie' ? pair.winner : 'ref'
            return { shot, ref, winner, why: String(pair.why ?? '').slice(0, 600) }
          })
          .filter((p): p is NonNullable<typeof p> => p !== null)
          .slice(0, 24)
        if (parsed.length > 0) pairs = parsed
      }
    } catch {
      /* no machine-readable pairs */
    }
    artifacts.push({
      round: Number(match[1]),
      shots: [...listFiles('shots', images), ...listFiles('shots/motion', images)],
      refs: [...listFiles('refs', images), ...listFiles('refs/motion', images)],
      videos,
      pairs,
      pairsMd,
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

export function buildReport(loop: LoopRecord, runs: RunRecord[], artifacts: CritiqueArtifacts[] = [], referencePack?: ReferencePack): string {
  const done = runs.filter((r) => r.status !== 'queued')
  const totalCost = done.reduce((sum, r) => sum + (r.costUsd ?? 0), 0)
  const totalIn = done.reduce((sum, r) => sum + (r.inputTokens ?? 0), 0)
  const totalOut = done.reduce((sum, r) => sum + (r.outputTokens ?? 0), 0)
  const verdicts = runs.filter((r) => r.role === 'critique' && r.verdict).map((r) => ({ round: r.round, verdict: r.verdict! }))
  const lastFinished = done.reduce<string | null>((last, r) => (r.finishedAt && (!last || r.finishedAt > last) ? r.finishedAt : last), null)
  const wallClockMs = lastFinished ? new Date(lastFinished).getTime() - new Date(loop.createdAt).getTime() : null

  const lines: string[] = []
  lines.push(`# Gauntlet Loop report — ${loop.status.toUpperCase()}`)
  lines.push('')
  lines.push(`- **Goal:** ${loop.prompt.replace(/\s+/g, ' ').slice(0, 180)}${loop.prompt.length > 180 ? '…' : ''}`)
  lines.push(`- **Workspace:** ${loop.workspaceDir}`)
  lines.push(
    `- **Models:** ${describeModels(loop.models)}`,
  )
  lines.push(`- **Started:** ${loop.createdAt} · **Updated:** ${loop.updatedAt}${wallClockMs != null ? ` · **Wall clock:** ${fmtDuration(wallClockMs)}` : ''}`)
  lines.push(
    `- **Rounds:** ${loop.round} of ${loop.maxRounds} · **Equivalent cost:** $${totalCost.toFixed(2)}${loop.budgetUsd ? ` of $${loop.budgetUsd.toFixed(2)} budget` : ''} · **Tokens (all runs):** in ${fmtTokens(totalIn)} / out ${fmtTokens(totalOut)}`,
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
  lines.push('| Round | Role | Revision | Model | Status | Cost | Tokens in | Tokens out | Elapsed | Score |')
  lines.push('|---|---|---|---|---|---|---|---|---|---|')
  for (const run of runs) {
    const score = run.verdict ? `${run.verdict.score.toFixed(2)}${run.verdict.pass ? ' ✓ PASS' : ''}` : ''
    const elapsedMs = elapsedThroughRunMs(loop.createdAt, run)
    lines.push(
      `| ${run.role === 'reference' ? '—' : run.round} | ${run.role} | ${run.revision?.slice(0, 12) ?? '—'} | ${run.model ?? '—'} | ${run.status} | ${run.costUsd != null ? `$${run.costUsd.toFixed(2)}` : '—'} | ${fmtTokens(run.inputTokens)} | ${fmtTokens(run.outputTokens)} | ${elapsedMs == null ? '—' : `+${fmtDuration(elapsedMs)}`} | ${score} |`,
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
      const indent = agent.id === 'orchestrator' || agent.id === 'critic' ? '- ' : '  - ↳ '
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
    `_Costs are equivalent API cost estimates (claude: the CLI's per-model breakdown at run end, which counts workflow agents that its total_cost_usd omits, and a price-table estimate mid-run that undercounts a fan-out in flight; codex: tokens × price table ${PRICE_TABLE_VERSION}); runs use subscription logins. Ledger: ledger.db in app user data._`,
  )
  return lines.join('\n')
}
