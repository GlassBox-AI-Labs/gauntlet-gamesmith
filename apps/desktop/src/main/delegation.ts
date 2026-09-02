import type { LoopModels } from '../shared/loop'
import { harnessFor, isUltracode } from '../shared/models'
import { claudeArgs, codexArgs, DISPATCHER_MODEL } from './harness-plans'

/**
 * How an orchestrator hands work to its workers.
 *
 * Four combinations, two of them native and two delegated:
 *
 *   claude → claude   agent file names the worker model; the Task tool runs it
 *   codex  → codex    `spawn_agent` takes a model per worker
 *   claude → codex    a cheap claude dispatcher runs `codex exec`
 *   codex  → claude   the orchestrator runs `claude -p` per slice
 *
 * A delegated worker is a process the app never started, so every delegation
 * command redirects the child's structured stream into
 * `.gauntlet-loop/agents/<slug>.<harness>.jsonl`, which the app parses for
 * tokens and cost exactly as it parses a run it started itself.
 */
const STREAM_DIR = '.gauntlet-loop/agents'

/** Shell-quote for the single command line an agent is told to run. */
function quote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/** The command a claude dispatcher runs to hand its slice to codex. */
export function codexChildCommand(model: string, effort: string, slug: string): string {
  return `codex ${codexArgs(model, effort, null).map(quote).join(' ')} - < .gauntlet-loop/codex-${slug}.md > ${STREAM_DIR}/${slug}.codex.jsonl`
}

/** The command a codex orchestrator runs to hand a slice to claude. */
export function claudeChildCommand(model: string, effort: string, slug: string): string {
  const args = claudeArgs(model, effort, '$(cat .gauntlet-loop/claude-' + slug + '.md)')
    .map((arg) => (arg.startsWith('$(cat ') ? `"${arg}"` : quote(arg)))
    .join(' ')
  return `claude ${args} > ${STREAM_DIR}/${slug}.claude.jsonl`
}

/**
 * The claude agent definition written to `.claude/agents/implementer.md`.
 * Null when the orchestrator is not claude — codex takes its rules in the
 * prompt instead of from a file.
 */
export function implementerAgentMd(models: LoopModels, referenceDir: string): string | null {
  if (harnessFor(models.orchestratorModel) !== 'claude' || !models.subagentModel) return null
  const header = (model: string, effort: string): string => `---
name: implementer
description: Builds and polishes one assigned slice of the game to AAA quality. Use for ALL substantial implementation work.
model: ${model}
effort: ${effort}
---
`
  if (harnessFor(models.subagentModel) === 'claude') {
    return `${header(models.subagentModel, models.subagentEffort)}You are an elite AAA game engineer. You receive one specific slice of the game (rendering, weapons, physics, audio, HUD, level design, ...). Before writing code, read ${referenceDir}/README.md and VIEW the downloaded references relevant to your slice. The Reference Study must be complete before you are spawned; if the pack is missing, report the blocker instead of implementing from memory. Implement it to the highest visual and technical quality, verify it actually runs, and report exactly what you changed and how to verify it.
`
  }
  // Claude Code runs only claude models as subagents, so a codex worker is
  // fronted by the cheapest claude model, doing nothing but launching it.
  return `${header(DISPATCHER_MODEL, 'low')}You are a dispatcher, not an engineer. ${models.subagentModel} does the building through the codex CLI; you hand it the work and report back. Never write or edit code yourself, and never take the slice over if codex struggles.

1. Choose a short slug for your slice — lowercase, hyphens, no spaces.
2. Read ${referenceDir}/README.md and VIEW the downloaded references relevant to the slice. If the Reference Pack is missing, report the blocker and stop. Write your full brief to \`.gauntlet-loop/codex-<slug>.md\`: the slice, the files it owns, the exact Reference Pack path and relevant files it must VIEW, the quality bar, and how to verify it. Codex starts with no memory of this conversation, so the brief must stand alone.
3. Run this ONE command with the Bash tool, in the foreground, with \`timeout\` set to 14400000:

   ${codexChildCommand(models.subagentModel, models.subagentEffort, '<slug>')}

   Do NOT use \`run_in_background\`, and do NOT poll it. The timeout ceiling is raised for this run, so the call simply returns when the work is done. The app reads that stream file as it is written, so nothing is lost while you wait.
4. When it returns, read the tail of the stream file to see what codex did, then report exactly what changed and how to verify it. Say plainly if it changed nothing.
`
}

/**
 * How the Reference Study fans its deep-research sweep out. Researchers are
 * launched as plain CLI children (the same stream-file mechanism as delegated
 * implementers, so their tokens and cost are tracked), which works identically
 * from either orchestrator harness. Null researchModel = no fan-out: the
 * reference agent does the sweep itself, cheaply.
 */
export function researchRules(models: LoopModels, referenceDir: string): string {
  if (!models.researchModel) {
    return 'Run this sweep yourself — do NOT spawn researcher subagents. Keep it to focused web searches per angle and move on; depth here is not worth extra cost on this run.'
  }
  const harness = harnessFor(models.researchModel)
  const briefFile = `.gauntlet-loop/${harness}-<slug>.md`
  const command =
    harness === 'codex'
      ? codexChildCommand(models.researchModel, models.researchEffort, '<slug>')
      : claudeChildCommand(models.researchModel, models.researchEffort, '<slug>')
  return `Fan this sweep out to parallel researchers on ${models.researchModel} at ${models.researchEffort} effort — one per angle, cheap and disposable. For each angle choose a short slug (e.g. research-reddit), write a self-contained brief to \`${briefFile}\` telling the researcher exactly what to find and to write its findings — every claim with its source URL — to ${referenceDir}/research/<slug>.md. Researchers research and write notes only; they must never touch project source or download pack media. Then \`mkdir -p ${STREAM_DIR}\` and launch every researcher from the workspace root in one command, in parallel:

  ${command} &

followed by \`wait\`. When they return, read their notes and distill them into ${referenceDir}/research.md yourself.`
}

/**
 * What the orchestrator may touch itself.
 *
 * On one real round the orchestrator spent $14.62 against its workers' $15.92
 * and made sixteen file-writing commands of its own, several rewriting game
 * source after the slices were handed out. That quietly changes who built the
 * game: the run reads as "codex workers" while much of the code came from the
 * orchestrator's own model. Scaffolding before the first hand-off and
 * verification afterwards are still its job.
 */
const HANDS_OFF =
  'Before the first hand-off you may scaffold: the project skeleton, a CONTRACTS.md, and stub files. After that you must NOT edit game source yourself — no writes, no `cat >`, no `sed -i`, no scripted rewrites of files a worker owns. Read, build, run, and test all you like; when something is wrong, send it back to a worker instead of fixing it yourself.'

function referenceHandoff(referenceDir: string): string {
  return `The Reference Study at ${referenceDir} must be complete before the first hand-off. Every worker brief must name that exact path, tell the worker to read ${referenceDir}/README.md, and VIEW the relevant downloaded references before writing code; if the pack is missing, do not spawn workers.`
}

/** The rules appended to the implement prompt, per combination. */
export function delegationRules(models: LoopModels, referenceDir: string): string {
  const verify =
    'Verify the game actually builds and runs before you finish. ' +
    'Browser checks run inside a macOS sandbox: drive them with Playwright\'s bundled browsers (`chromium.launch({ headless: true })`). Never pass `channel: \'chrome\'` / `\'msedge\'` and never launch an installed browser app — the sandbox blocks it from registering with macOS, so it aborts on launch and files a crash report.'
  if (!models.subagentModel) {
    return `Working rules: you implement this yourself — do NOT delegate to subagents. ${verify}`
  }
  const rules = `${HANDS_OFF} ${referenceHandoff(referenceDir)} ${verify}`
  const orchestrator = harnessFor(models.orchestratorModel)
  const worker = harnessFor(models.subagentModel)

  if (orchestrator === 'codex' && worker === 'codex') {
    return `Orchestration rules: you are the orchestrator. Split the work into slices with disjoint write sets and delegate each one with \`spawn_agent\`, passing model="${models.subagentModel}", reasoning_effort="${models.subagentEffort}", and fork_turns="none" — the model override is refused on a full-history fork, so fork_turns="none" is required, which also means each brief must stand alone. Then wait for every agent to finish and integrate their work. Do not implement slices yourself. ${rules}`
  }

  if (orchestrator === 'codex' && worker === 'claude') {
    return `Orchestration rules: you are the orchestrator; ${models.subagentModel} does the building through the claude CLI. For each slice, choose a short slug and write a self-contained brief to \`.gauntlet-loop/claude-<slug>.md\` naming the files that slice owns and how to verify it. Then launch every slice from the workspace root in one command, in parallel, and wait for them all:

  ${claudeChildCommand(models.subagentModel, models.subagentEffort, '<slug>')} &

followed by \`wait\`. Each command runs to completion on its own — do not interrupt them, and do not implement slices yourself. When they return, read the tails of the stream files, integrate the slices, and resolve any conflicts. ${rules}`
  }

  if (orchestrator === 'claude' && worker === 'codex') {
    return `Orchestration rules: you are the orchestrator. Delegate ALL substantial implementation work to parallel \`implementer\` subagents (defined in .claude/agents/implementer.md — each one hands its slice to ${models.subagentModel} through the codex CLI), one per workstream with disjoint write sets, and integrate their results. Each dispatcher holds its call open until codex finishes, so expect them to take a long time and do not chase them. ${rules}`
  }

  // A workflow agent picks its model as: model the script names → the agent
  // file's frontmatter → CLAUDE_CODE_SUBAGENT_MODEL → the session model. The env
  // var (set on the spawn) pins the model either way, but effort only binds
  // through the agent file, so the script has to name the agent type to get it.
  const workflowRule = isUltracode(models)
    ? ` When you orchestrate through a workflow, pass \`{agentType: 'implementer'}\` on every \`agent()\` call so each one runs ${models.subagentModel} at ${models.subagentEffort} effort rather than inheriting yours.`
    : ''
  return `Orchestration rules: you are the orchestrator. Delegate ALL substantial implementation work to parallel \`implementer\` subagents (defined in .claude/agents/implementer.md — they run ${models.subagentModel} at ${models.subagentEffort} effort), one per workstream, and integrate their results.${workflowRule} ${rules}`
}
