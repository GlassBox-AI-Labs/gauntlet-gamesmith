import { createHash } from 'node:crypto'
import type { LoopModels } from '../shared/loop'
import { DISPATCHER_MODEL_ID, harnessFor, isUltracode } from '../shared/models'
import { ASSET_WAVE_SIZE, MACOS_BROWSER_SANDBOX_RULE } from '../shared/prompts'
import { assertChildSlug } from './child-stream-name'
import { claudeArgs, codexArgs } from './harness-plans'
import { RUN_METADATA_DIR } from './run-transfer'

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
 * `<run metadata dir>/agents/<slug>.<harness>.jsonl`, which the app parses for
 * tokens and cost exactly as it parses a run it started itself.
 */
const STREAM_DIR = `${RUN_METADATA_DIR}/agents`
export const GAUNTLET_IMPLEMENTER_AGENT_PREFIX = 'gauntlet-implementer-v2-'

export interface ImplementerAgentDefinition {
  agentName: string
  filename: string
  markdown: string
}

/** Shell-quote for the single command line an agent is told to run. */
export function quote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function commandSlug(slug: string): string {
  // The literal placeholder appears only in prompt templates. Every concrete
  // slug passed by code must satisfy the same grammar as stream-file readers.
  return slug === '<slug>' ? slug : assertChildSlug(slug)
}

/** The command a claude dispatcher runs to hand its slice to codex. */
export function codexChildCommand(model: string, effort: string, slug: string): string {
  const safeSlug = commandSlug(slug)
  return `set -C; "\${GAUNTLET_CODEX_BIN:?}" ${codexArgs(model, effort, null).map(quote).join(' ')} - < ${RUN_METADATA_DIR}/codex-${safeSlug}.md > ${STREAM_DIR}/${safeSlug}.codex.jsonl`
}

/** The command a codex orchestrator runs to hand a slice to claude. */
export function claudeChildCommand(model: string, effort: string, slug: string): string {
  const safeSlug = commandSlug(slug)
  const args = claudeArgs(model, effort, `$(cat ${RUN_METADATA_DIR}/claude-${safeSlug}.md)`)
    .map((arg) => (arg.startsWith('$(cat ') ? `"${arg}"` : quote(arg)))
    .join(' ')
  return `set -C; "\${GAUNTLET_CLAUDE_BIN:?}" ${args} > ${STREAM_DIR}/${safeSlug}.claude.jsonl`
}

/**
 * The claude agent definition written to the versioned Gauntlet-owned agent file.
 * Null when the orchestrator is not claude — codex takes its rules in the
 * prompt instead of from a file.
 */
export function implementerAgentDefinition(models: LoopModels, referenceDir: string): ImplementerAgentDefinition | null {
  if (harnessFor(models.orchestratorModel) !== 'claude' || !models.subagentModel) return null
  const workerIsClaude = harnessFor(models.subagentModel) === 'claude'
  const frontModel = workerIsClaude ? models.subagentModel : DISPATCHER_MODEL_ID
  const frontEffort = workerIsClaude ? models.subagentEffort : 'low'
  const body = workerIsClaude
    ? `You are an elite AAA game engineer. You receive one specific slice of the game (rendering, weapons, physics, audio, HUD, story, difficulty, level design, ...). Before writing code, read ${referenceDir}/README.md and ${referenceDir}/research.md plus the relevant parts of journey.md and story.md; VIEW the downloaded references relevant to your slice; and WATCH the reference gameplay clip when motion or game feel matters. Treat the Reference Study's sourced gameplay dossier, progression classification, story beats, and difficulty curve as requirements rather than substituting memory. The Reference Study must be complete before you are spawned; if the pack is missing, report the blocker instead of implementing from memory. Implement it to the highest visual and technical quality, verify it actually runs, and report exactly what you changed and how to verify it.
`
    : `You are a dispatcher, not an engineer. ${models.subagentModel} does the building through the codex CLI; you hand it the work and report back. Never write or edit code yourself, and never take the slice over if codex struggles.

1. Choose a short slug for your slice — lowercase, hyphens, no spaces.
2. Read ${referenceDir}/README.md and ${referenceDir}/research.md plus the relevant parts of journey.md and story.md; VIEW the downloaded references relevant to the slice; and WATCH the gameplay clip when motion or game feel matters. Treat the sourced gameplay dossier, progression classification, story beats, and difficulty curve as requirements. If the Reference Pack is missing, report the blocker and stop. Write your full brief to \`${RUN_METADATA_DIR}/codex-<slug>.md\`: the slice, the files it owns, the exact Reference Pack path and relevant files it must inspect, the quality bar, and how to verify it. Codex starts with no memory of this conversation, so the brief must stand alone.
3. Run this ONE command with the Bash tool, in the foreground, with \`timeout\` set to 14400000:

   ${codexChildCommand(models.subagentModel, models.subagentEffort, '<slug>')}

   Do NOT use \`run_in_background\`, and do NOT poll it. The timeout ceiling is raised for this run, so the call simply returns when the work is done. The app reads that stream file as it is written, so nothing is lost while you wait.
4. When it returns, read the tail of the stream file to see what codex did, then report exactly what changed and how to verify it. Say plainly if it changed nothing.
`
  const digest = createHash('sha256')
    .update(JSON.stringify({ version: 2, frontModel, frontEffort, body }))
    .digest('hex')
    .slice(0, 24)
  const agentName = `${GAUNTLET_IMPLEMENTER_AGENT_PREFIX}${digest}`
  const markdown = `---
name: ${agentName}
description: Builds and polishes one assigned slice of the game to AAA quality. Use for ALL substantial implementation work.
model: ${frontModel}
effort: ${frontEffort}
---
${body}`
  return { agentName, filename: `${agentName}.md`, markdown }
}

/** Compatibility accessor for code that only needs the generated markdown. */
export function implementerAgentMd(models: LoopModels, referenceDir: string): string | null {
  return implementerAgentDefinition(models, referenceDir)?.markdown ?? null
}

/*
 * Agent definitions are immutable and definition-addressed. A workspace can
 * retain old configurations without a later run replacing their bytes.
 */
function requireImplementerDefinition(models: LoopModels, referenceDir: string): ImplementerAgentDefinition {
  const definition = implementerAgentDefinition(models, referenceDir)
  if (!definition) throw new Error('Claude implementer definition requested for a non-delegated phase.')
  return definition
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
  const briefFile = `${RUN_METADATA_DIR}/${harness}-<slug>.md`
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
  return `The Reference Study at ${referenceDir} must be complete before the first hand-off. Every worker brief must name that exact path, tell the worker to read ${referenceDir}/README.md and ${referenceDir}/research.md plus the relevant journey.md and story.md sections, and VIEW the relevant downloaded references before writing code. Brief story, difficulty, level/progression, and gameplay workers from the study's sourced expert dossier; if the pack is missing, do not spawn workers.`
}

/** The rules appended to the implement prompt, per combination. */
export function delegationRules(models: LoopModels, referenceDir: string): string {
  const verify = `Verify the game actually builds and runs before you finish. ${MACOS_BROWSER_SANDBOX_RULE}`
  if (!models.subagentModel) {
    return `Working rules: you implement this yourself — do NOT delegate to subagents. ${verify}`
  }
  const rules = `${HANDS_OFF} ${referenceHandoff(referenceDir)} ${verify}`
  const orchestrator = harnessFor(models.orchestratorModel)
  const worker = harnessFor(models.subagentModel)
  const agent = orchestrator === 'claude' ? requireImplementerDefinition(models, referenceDir) : null

  if (orchestrator === 'codex' && worker === 'codex') {
    return `Orchestration rules: you are the orchestrator. Split the work into slices with disjoint write sets and delegate each one with \`spawn_agent\`, passing model="${models.subagentModel}", reasoning_effort="${models.subagentEffort}", and fork_turns="none" — the model override is refused on a full-history fork, so fork_turns="none" is required, which also means each brief must stand alone. Then wait for every agent to finish and integrate their work. Do not implement slices yourself. ${rules}`
  }

  if (orchestrator === 'codex' && worker === 'claude') {
    return `Orchestration rules: you are the orchestrator; ${models.subagentModel} does the building through the claude CLI. For each slice, choose a short slug and write a self-contained brief to \`${RUN_METADATA_DIR}/claude-<slug>.md\` naming the files that slice owns and how to verify it. Then launch every slice from the workspace root in one command, in parallel, and wait for them all:

  ${claudeChildCommand(models.subagentModel, models.subagentEffort, '<slug>')} &

followed by \`wait\`. Each command runs to completion on its own — do not interrupt them, and do not implement slices yourself. When they return, read the tails of the stream files, integrate the slices, and resolve any conflicts. ${rules}`
  }

  if (orchestrator === 'claude' && worker === 'codex') {
    return `Orchestration rules: you are the orchestrator. Delegate ALL substantial implementation work to parallel \`${agent!.agentName}\` subagents (defined in .claude/agents/${agent!.filename} — each one hands its slice to ${models.subagentModel} through the codex CLI), one per workstream with disjoint write sets, and integrate their results. Each dispatcher holds its call open until codex finishes, so expect them to take a long time and do not chase them. ${rules}`
  }

  // A workflow agent picks its model as: model the script names → the agent
  // file's frontmatter → CLAUDE_CODE_SUBAGENT_MODEL → the session model. The env
  // var (set on the spawn) pins the model either way, but effort only binds
  // through the agent file, so the script has to name the agent type to get it.
  const workflowRule = isUltracode(models)
    ? ` When you orchestrate through a workflow, pass \`{agentType: '${agent!.agentName}'}\` on every \`agent()\` call so each one runs ${models.subagentModel} at ${models.subagentEffort} effort rather than inheriting yours.`
    : ''
  return `Orchestration rules: you are the orchestrator. Delegate ALL substantial implementation work to parallel \`${agent!.agentName}\` subagents (defined in .claude/agents/${agent!.filename} — they run ${models.subagentModel} at ${models.subagentEffort} effort), one per workstream, and integrate their results.${workflowRule} ${rules}`
}


/**
 * What one sculptor is told, wherever it runs.
 *
 * The same words go into `.claude/agents/sculptor.md` and into a cross-harness
 * brief file, because a delegated worker starts with no memory of the run and
 * has to be able to work from this alone.
 */
export function sculptorBrief(referenceDir: string): string {
  return `You rebuild ONE object from the reference game as a procedural Three.js model, using the \`img2threejs\` skill. You build models and nothing else: never touch gameplay, rendering, HUD or level code, and never write outside \`src/assets/\` and \`.img2threejs/\`.

1. Read your entry in ${referenceDir}/cast.md. You are given its slug, what it is, where it appears, and how it behaves in play.
2. Find it. \`python3 tools/crop.py sheet <dir-or-video> --out .img2threejs/<name>/sheet.png\` contact-sheets candidates so you can pick a frame in one look. Try ${referenceDir}/objects/ FIRST — isolated shots are the only reliably good source — then images/, journey/, motion/, video/.
3. Crop it. \`python3 tools/crop.py grid <still> --out .img2threejs/<name>/grid.png\`, LOOK at the grid, then \`python3 tools/crop.py cut <still> --cells B3:D8 --out .img2threejs/<name>/crop/<name>.jpg\`. Name grid cells; do not guess pixel coordinates, they are reliably wrong. LOOK at the crop and adjust — the first box is usually a little too tight, and \`--pad\` fixes it. The tool refuses a crop whose object fills less than a quarter of the frame: that is not a bug, it means the object is too small in that still and you should try another. \`--allow-upscale\` is the deliberate fallback when nothing better exists; if you use it, record low detail confidence in the spec.
4. If no source gives a usable crop, STOP and report the entry unbuildable, naming what you tried. Do not force a bad crop through — every later pass inherits it and nothing downstream can tell. Do not model it from memory.
5. Run the skill properly: \`python3 forge/state.py init --state .img2threejs/<name>/state.json --reference <crop> ...\`, then gate every step through \`forge/next.py\`. Never reconstruct progress from what you remember doing.
6. Emit \`src/assets/<name>.ts\`: a factory returning a \`THREE.Group\` with \`userData.sculptRuntime\` (nodes, sockets, colliders) and \`userData.rig\`. Colliders must map to Rapier primitives — box, sphere, capsule, cylinder. The game spawns from this record, so sockets are where things attach and colliders are what it collides with; both come from the entry's stated role in play.
7. Report: which source you cut from, what you built, and any detail you had to guess.`
}

/**
 * The claude agent definition written to `.claude/agents/sculptor.md`.
 * Null when the orchestrator is not claude — codex takes its rules in the
 * prompt instead of from a file.
 */
export function sculptorAgentMd(models: LoopModels, referenceDir: string): string | null {
  if (harnessFor(models.orchestratorModel) !== 'claude' || !models.assetModel) return null
  const claudeWorker = harnessFor(models.assetModel) === 'claude'
  const model = claudeWorker ? models.assetModel : DISPATCHER_MODEL_ID
  const effort = claudeWorker ? models.assetEffort : 'low'
  const header = `---
name: sculptor
description: Rebuilds one named object from the Reference Pack as a procedural Three.js model. Use for ALL asset work.
model: ${model}
effort: ${effort}
---
`
  if (claudeWorker) return `${header}${sculptorBrief(referenceDir)}`
  return `${header}You are a dispatcher, not a modeller. ${models.assetModel} does the sculpting through the codex CLI; you hand it one object and report back. Never model anything yourself.

1. Your slug is the cast entry's name.
2. Write the full brief for your object to \`${RUN_METADATA_DIR}/codex-<slug>.md\` — it must stand alone, because codex starts with no memory of this run. Include the entry's line from ${referenceDir}/cast.md and these rules verbatim:

${sculptorBrief(referenceDir)}

3. Run this ONE command with the Bash tool, in the foreground, with \`timeout\` set to 14400000:

   ${codexChildCommand(models.assetModel, models.assetEffort, '<slug>')}

   Do NOT use \`run_in_background\`, and do NOT poll it. The app reads that stream file as it is written, so nothing is lost while you wait.
4. When it returns, read the tail of the stream file and report what was built, or that the entry was unbuildable and why.
`
}

/**
 * How the Asset Build hands each cast entry to its own sculptor. Same four
 * combinations as the implement side, and null assetModel never reaches here —
 * the runner skips the phase entirely rather than running it solo, because one
 * agent sculpting a whole cast in sequence is the thing this phase exists to
 * stop.
 *
 * Sculptors run a wave at a time rather than all at once. They share no files,
 * so width costs nothing in correctness — but a sculptor banks its work only
 * by finishing, so a usage limit landing mid-wave discards every one still in
 * flight. See ASSET_WAVE_SIZE.
 */
export function sculptorRules(models: LoopModels, referenceDir: string): string {
  if (!models.assetModel) return ''
  const orchestrator = harnessFor(models.orchestratorModel)
  const worker = harnessFor(models.assetModel)
  const shared =
    `One sculptor per cast entry, launched ${ASSET_WAVE_SIZE} at a time and never the whole cast at once — a sculptor banks its work only by finishing, so a usage limit landing mid-wave throws away every one still running. Wait for a wave to report, check what it wrote, then launch the next. Do not sculpt anything yourself; you read the cast, hand out the work, check what came back, and report.`

  if (orchestrator === 'codex' && worker === 'codex') {
    return `${shared} Delegate each entry in the wave with \`spawn_agent\`, passing model="${models.assetModel}", reasoning_effort="${models.assetEffort}", and fork_turns="none" — the model override is refused on a full-history fork, so each brief must stand alone. Give every agent this brief, with its own entry's line from cast.md at the top:\n\n${sculptorBrief(referenceDir)}`
  }

  if (orchestrator === 'codex' && worker === 'claude') {
    return `${shared} For each entry, write a self-contained brief to \`${RUN_METADATA_DIR}/claude-<slug>.md\` — its line from cast.md plus the rules below — then \`mkdir -p ${STREAM_DIR}\` and launch one wave from the workspace root in one command, in parallel:\n\n  ${claudeChildCommand(models.assetModel, models.assetEffort, '<slug>')} &\n\nfollowed by \`wait\`. The brief:\n\n${sculptorBrief(referenceDir)}`
  }

  if (orchestrator === 'claude' && worker === 'codex') {
    return `${shared} Delegate the wave's entries to parallel \`sculptor\` subagents (defined in .claude/agents/sculptor.md — each hands its object to ${models.assetModel} through the codex CLI), one per entry. Each dispatcher holds its call open until codex finishes, so expect them to take a long time and do not chase them.`
  }

  const workflowRule = isUltracode(models)
    ? ` When you orchestrate through a workflow, pass \`{agentType: 'sculptor'}\` on every \`agent()\` call so each one runs ${models.assetModel} at ${models.assetEffort} effort rather than inheriting yours, and keep its concurrency to ${ASSET_WAVE_SIZE} — a workflow that fans the whole cast out at once defeats the waves.`
    : ''
  return `${shared} Delegate the wave's entries to parallel \`sculptor\` subagents (defined in .claude/agents/sculptor.md — they run ${models.assetModel} at ${models.assetEffort} effort), one per entry.${workflowRule}`
}
