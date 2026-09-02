import type { HarnessKind } from '../shared/harness'
import type { LoopModels } from '../shared/loop'
import { harnessFor } from '../shared/models'

/**
 * How to start each CLI, as data.
 *
 * Both harnesses can take any role, so the runner asks for a plan rather than
 * branching on the harness at every call site. These are pure functions: what
 * to run, with which flags, in which environment. Nothing here touches disk.
 */
export interface SpawnPlan {
  bin: string
  args: string[]
  env: Record<string, string>
}

export interface PlanContext {
  models: LoopModels
  prompt: string
  claudeHome: string
  codexHome: string
  /** Session/thread to continue, when the app is picking up an interrupted run. */
  resumeId?: string | null
  /** True when a claude run may continue from its own transcript with no id. */
  resumeLatest?: boolean
  /** Where codex writes its final message; only the critique reads it back. */
  outFile?: string | null
}

/** Codex flags shared by every role: a sandbox that can build, with the network on. */
export function codexArgs(model: string, effort: string, outFile: string | null | undefined, resumeId?: string | null): string[] {
  return [
    'exec',
    // `codex exec resume <id>` — the subcommand comes before the flags, and the
    // prompt still trails them.
    ...(resumeId ? ['resume', resumeId] : []),
    '--json',
    '--skip-git-repo-check',
    // code_mode fail-closes all command execution when its host binary is
    // missing (verified live) — the classic shell path works everywhere.
    '--disable',
    'code_mode',
    '-s',
    'workspace-write',
    '-c',
    'sandbox_workspace_write.network_access=true',
    '-c',
    'tools.web_search=true',
    '-c',
    'model_reasoning_summary=detailed',
    '-m',
    model,
    '-c',
    `model_reasoning_effort=${effort}`,
    ...(outFile ? ['-o', outFile] : []),
  ]
}

export function claudeArgs(model: string, effort: string, prompt: string): string[] {
  return [
    '-p',
    prompt,
    '--output-format',
    'stream-json',
    '--verbose',
    '--dangerously-skip-permissions',
    '--model',
    model,
    '--effort',
    effort,
  ]
}

/**
 * Environment for a run that may shell out to the other CLI mid-flight.
 *
 * A cross-harness run has the orchestrator start the other CLI itself, so both
 * homes are always exported: the child inherits them and reuses the app's
 * logins instead of the user's own.
 */
function bothHomes(ctx: PlanContext): Record<string, string> {
  return {
    CLAUDE_CONFIG_DIR: ctx.claudeHome,
    CODEX_HOME: ctx.codexHome,
  }
}

const CLAUDE_RUN_ENV: Record<string, string> = {
  // Workflow agents are background tasks, and `claude -p` terminates those
  // after 600s by default — which kills a fan-out mid-write and leaves stub
  // files behind. Wait instead; the runner's idle timer is the real bound.
  CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: '0',
  // A delegated `codex exec` runs for far longer than the 10-minute default
  // ceiling on a foreground command. Raising it is what lets a dispatcher hold
  // the call open instead of backgrounding the child and losing track of it.
  BASH_MAX_TIMEOUT_MS: '14400000',
  BASH_DEFAULT_TIMEOUT_MS: '14400000',
}

export function implementPlan(ctx: PlanContext): SpawnPlan {
  const { models } = ctx
  const harness: HarnessKind = harnessFor(models.orchestratorModel)
  if (harness === 'codex') {
    return {
      bin: 'codex',
      args: [...codexArgs(models.orchestratorModel, models.orchestratorEffort, null, ctx.resumeId), ctx.prompt],
      env: bothHomes(ctx),
    }
  }
  return {
    bin: 'claude',
    args: [
      ...(ctx.resumeId ? ['--resume', ctx.resumeId] : ctx.resumeLatest ? ['--continue'] : []),
      ...claudeArgs(models.orchestratorModel, models.orchestratorEffort, ctx.prompt),
      // Subagent output reaches the run log only when it is forwarded; the
      // critique has no subagents, so this is the implement side's flag alone.
      '--forward-subagent-text',
    ],
    env: {
      ...bothHomes(ctx),
      ...CLAUDE_RUN_ENV,
      // Binds the subagent model on both delegation paths: it is what a
      // workflow agent falls back to when the script names no model. A codex
      // pick binds the dispatcher instead — the CLI would ignore a gpt id.
      ...(models.subagentModel
        ? { CLAUDE_CODE_SUBAGENT_MODEL: harnessFor(models.subagentModel) === 'claude' ? models.subagentModel : DISPATCHER_MODEL }
        : {}),
    },
  }
}

/** A one-agent research run using the orchestrator model, with no delegation. */
export function referencePlan(ctx: PlanContext): SpawnPlan {
  const { models } = ctx
  if (harnessFor(models.orchestratorModel) === 'codex') {
    return {
      bin: 'codex',
      args: [...codexArgs(models.orchestratorModel, models.orchestratorEffort, ctx.outFile), ctx.prompt],
      env: bothHomes(ctx),
    }
  }
  return {
    bin: 'claude',
    args: claudeArgs(models.orchestratorModel, models.orchestratorEffort, ctx.prompt),
    env: { ...bothHomes(ctx), CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: '0' },
  }
}

export function critiquePlan(ctx: PlanContext): SpawnPlan {
  const { models } = ctx
  if (models.criticHarness === 'codex') {
    return {
      bin: 'codex',
      args: [...codexArgs(models.criticModel, models.criticEffort, ctx.outFile), ctx.prompt],
      env: { CODEX_HOME: ctx.codexHome },
    }
  }
  return {
    bin: 'claude',
    args: claudeArgs(models.criticModel, models.criticEffort, ctx.prompt),
    env: { CLAUDE_CONFIG_DIR: ctx.claudeHome, CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: '0' },
  }
}

/**
 * The claude model that fronts a codex worker. It writes no code — it hands the
 * slice to codex and reports back — so it is the cheapest one on the list.
 */
export const DISPATCHER_MODEL = 'claude-sonnet-5'
