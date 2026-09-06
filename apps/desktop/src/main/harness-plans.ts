import type { HarnessKind } from '../shared/harness'
import type { LoopModels } from '../shared/loop'
import { DISPATCHER_MODEL_ID, harnessFor } from '../shared/models'

export const DISPATCHER_MODEL = DISPATCHER_MODEL_ID
import { cliHomeEnv } from './harness-env'

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
  /** Session/thread to continue across implementation rounds or interrupted attempts. */
  resumeId?: string | null
  /** Optional Codex compatibility output; machine decisions never trust it. */
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
    // `codex exec resume` rejects `-s` outright ("unexpected argument '-s'
    // found") and exits 2 before the model is ever reached. It still accepts
    // `-c`, so the same sandbox is set through the config key the flag writes.
    ...(resumeId ? ['-c', 'sandbox_mode=workspace-write'] : ['-s', 'workspace-write']),
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
 * A cross-harness run has the orchestrator start the other CLI itself. Same-
 * harness and no-delegation runs receive only their own home, avoiding
 * needless access to the other CLI's private profile.
 */
function requiredHomes(ctx: PlanContext, primaryModel: string, delegatedModels: readonly (string | null)[]): Record<string, string> {
  const primary = harnessFor(primaryModel)
  const delegated = new Set(delegatedModels.filter((model): model is string => model != null).map(harnessFor))
  return {
    ...cliHomeEnv(primary, primary === 'claude' ? ctx.claudeHome : ctx.codexHome),
    ...([...delegated].reduce<Record<string, string>>((env, kind) => (
      kind === primary ? env : { ...env, ...cliHomeEnv(kind, kind === 'claude' ? ctx.claudeHome : ctx.codexHome) }
    ), {})),
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
      env: requiredHomes(ctx, models.orchestratorModel, [models.subagentModel, models.assetModel]),
    }
  }
  return {
    bin: 'claude',
    args: [
      ...(ctx.resumeId ? ['--resume', ctx.resumeId] : []),
      ...claudeArgs(models.orchestratorModel, models.orchestratorEffort, ctx.prompt),
      // Subagent output reaches the run log only when it is forwarded; the
      // critique has no subagents, so this is the implement side's flag alone.
      '--forward-subagent-text',
    ],
    env: {
      ...requiredHomes(ctx, models.orchestratorModel, [models.subagentModel, models.assetModel]),
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

/**
 * The Asset Build. Shaped like the implement plan because it is the same
 * thing structurally — an orchestrator that fans out — but its workers are
 * sculptors, so `assetModel` binds them instead of `subagentModel`.
 */
export function assetsPlan(ctx: PlanContext): SpawnPlan {
  const { models } = ctx
  if (harnessFor(models.orchestratorModel) === 'codex') {
    return {
      bin: 'codex',
      args: [...codexArgs(models.orchestratorModel, models.orchestratorEffort, null, ctx.resumeId), ctx.prompt],
      env: requiredHomes(ctx, models.orchestratorModel, [models.assetModel]),
    }
  }
  return {
    bin: 'claude',
    args: [
      ...claudeArgs(models.orchestratorModel, models.orchestratorEffort, ctx.prompt),
      '--forward-subagent-text',
    ],
    env: {
      ...requiredHomes(ctx, models.orchestratorModel, [models.assetModel]),
      ...CLAUDE_RUN_ENV,
      ...(models.assetModel
        ? { CLAUDE_CODE_SUBAGENT_MODEL: harnessFor(models.assetModel) === 'claude' ? models.assetModel : DISPATCHER_MODEL }
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
      env: requiredHomes(ctx, models.orchestratorModel, [models.researchModel]),
    }
  }
  return {
    bin: 'claude',
    args: claudeArgs(models.orchestratorModel, models.orchestratorEffort, ctx.prompt),
    env: { ...requiredHomes(ctx, models.orchestratorModel, [models.researchModel]), CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: '0' },
  }
}

export function critiquePlan(ctx: PlanContext): SpawnPlan {
  const { models } = ctx
  if (harnessFor(models.criticModel) === 'codex') {
    return {
      bin: 'codex',
      args: [...codexArgs(models.criticModel, models.criticEffort, ctx.outFile), ctx.prompt],
      env: cliHomeEnv('codex', ctx.codexHome),
    }
  }
  return {
    bin: 'claude',
    args: claudeArgs(models.criticModel, models.criticEffort, ctx.prompt),
    env: { ...cliHomeEnv('claude', ctx.claudeHome), CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: '0' },
  }
}

/**
 * The claude model that fronts a codex worker. It writes no code — it hands the
 * slice to codex and reports back — so it is the cheapest one on the list.
 */

/** A steering consult never resumes a phase session or receives write permissions. */
export function consultPlan(model:string,schemaPath:string,imagePaths:string[] = []):string[] {
  return ['exec','--ignore-user-config','--ephemeral','--sandbox','read-only','--skip-git-repo-check','--json','--output-schema',schemaPath,'--model',model,'-c','model_reasoning_effort="low"',...imagePaths.flatMap(file=>['--image',file]),'-']
}
