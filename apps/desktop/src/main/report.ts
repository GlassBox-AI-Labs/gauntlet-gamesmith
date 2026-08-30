import type { LoopRecord, RunRecord } from '../shared/loop'

const SPARK = '▁▂▃▄▅▆▇█'

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

export function buildReport(loop: LoopRecord, runs: RunRecord[]): string {
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
    `- **Models:** ${loop.models.orchestratorModel} (${loop.models.orchestratorEffort}) orchestrating ${loop.models.subagentModel} (${loop.models.subagentEffort}) subagents · critic ${loop.models.criticModel} (${loop.models.criticEffort}), fresh eyes`,
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
  lines.push('| Round | Role | Model | Status | Cost | Tokens in | Tokens out | Time | Score |')
  lines.push('|---|---|---|---|---|---|---|---|---|')
  for (const run of runs) {
    const score = run.verdict ? `${run.verdict.score.toFixed(2)}${run.verdict.pass ? ' ✓ PASS' : ''}` : ''
    lines.push(
      `| ${run.round} | ${run.role} | ${run.model ?? '—'} | ${run.status} | ${run.costUsd != null ? `$${run.costUsd.toFixed(2)}` : '—'} | ${fmtTokens(run.inputTokens)} | ${fmtTokens(run.outputTokens)} | ${fmtDuration(run.durationMs)} | ${score} |`,
    )
  }
  lines.push('')

  const latest = verdicts.at(-1)
  if (latest) {
    lines.push(`## Latest verdict (round ${latest.round}, score ${latest.verdict.score.toFixed(2)})`)
    lines.push('')
    lines.push(latest.verdict.summary || '(no summary)')
    lines.push('')
    for (const finding of latest.verdict.findings) lines.push(`- **[${finding.severity}]** ${finding.text}`)
    lines.push('')
  }

  const lastWithAgents = [...runs].reverse().find((r) => r.metrics && r.metrics.agents.length > 0)
  if (lastWithAgents?.metrics) {
    lines.push(`## Agent breakdown (round ${lastWithAgents.round} ${lastWithAgents.role})`)
    lines.push('')
    for (const agent of lastWithAgents.metrics.agents) {
      const indent = agent.id === 'orchestrator' || agent.id === 'critic' ? '- ' : '  - ↳ '
      lines.push(
        `${indent}**${agent.label}** (${agent.model ?? '?'}): ${agent.messages} msgs · in ${fmtTokens(agent.tokens.input)} · out ${fmtTokens(agent.tokens.output)} · cache r/w ${fmtTokens(agent.tokens.cacheRead)}/${fmtTokens(agent.tokens.cacheWrite)}`,
      )
    }
    for (const [model, mu] of Object.entries(lastWithAgents.metrics.perModel)) {
      lines.push(`- ${model}: ${mu.costUsd != null ? `$${mu.costUsd.toFixed(2)}` : '$—'} · in ${fmtTokens(mu.tokens.input)} · out ${fmtTokens(mu.tokens.output)}`)
    }
    lines.push('')
  }

  lines.push(`_Costs are equivalent API cost estimates; runs use subscription logins. Ledger: ledger.db in app user data._`)
  return lines.join('\n')
}
