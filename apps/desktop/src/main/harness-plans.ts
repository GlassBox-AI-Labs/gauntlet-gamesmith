import type { HarnessKind } from '../shared/harness'
import type { LoopModels } from '../shared/loop'
import { DISPATCHER_MODEL_ID, harnessFor } from '../shared/models'

export const DISPATCHER_MODEL = DISPATCHER_MODEL_ID
import { cliHomeEnv } from './harness-env'

/**
 * How to start each CLI, as data.
 *
 * Every harness can take any role, so the runner asks for a plan rather than
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
  grokHome: string
  /** An empty HOME for grok runs — see `neutralHome` for why it is needed. */
  neutralHome: string
  /** Session/thread to continue, when the app is picking up an interrupted run. */
  resumeId?: string | null
  /** Continue the most recent session instead of naming one. */
  resumeLatest?: boolean
  /** Optional Codex compatibility output; machine decisions never trust it. */
  outFile?: string | null
  /**
   * Inline subagent definitions for a grok orchestrator, pinning the worker
   * model. Built in delegation.ts, passed in so the plans stay pure.
   */
  agentsJson?: string | null
}

/** Codex flags shared by every role: no sandbox, so Playwright can launch a browser. */
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
    // Codex has no `off` value; `danger-full-access` is unrestricted execution.
    '-s',
    'danger-full-access',
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

/**
 * Grok flags shared by every role.
 *
 * `streaming-messages-json` is Claude Code's own stream-json wire format — same
 * event types, same usage field names, same result event with `total_cost_usd`
 * — so the claude translator reads it unchanged.
 *
 * The sandbox is `off` (unrestricted). `workspace` Seatbelt on macOS kills
 * Playwright's bundled Chromium at launch (SIGSEGV in IOKit / Mach register).
 * The flag is explicit so a GROK_HOME config cannot quietly re-enable it.
 */
export function grokArgs(model: string, effort: string, prompt: string): string[] {
  return [
    '-p',
    prompt,
    '--output-format',
    'streaming-messages-json',
    '--always-approve',
    '--sandbox',
    'off',
    '-m',
    model,
    '--reasoning-effort',
    effort,
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
/** The private home for one harness, so only the needed ones are exported. */
function homeFor(ctx: PlanContext, kind: HarnessKind): string {
  return kind === 'claude' ? ctx.claudeHome : kind === 'codex' ? ctx.codexHome : ctx.grokHome
}

function requiredHomes(ctx: PlanContext, primaryModel: string, delegatedModels: readonly (string | null)[]): Record<string, string> {
  const primary = harnessFor(primaryModel)
  const delegated = new Set(delegatedModels.filter((model): model is string => model != null).map(harnessFor))
  return {
    ...cliHomeEnv(primary, homeFor(ctx, primary)),
    ...([...delegated].reduce<Record<string, string>>((env, kind) => (
      kind === primary ? env : { ...env, ...cliHomeEnv(kind, homeFor(ctx, kind)) }
    ), {})),
  }
}

/**
 * Grok's own environment. HOME is redirected as well as GROK_HOME, because
 * GROK_HOME alone does not stop grok reading the operator's `~/.claude`
 * configuration as its own — see `neutralHome`.
 */
function grokEnv(ctx: PlanContext): Record<string, string> {
  return { GROK_HOME: ctx.grokHome, HOME: ctx.neutralHome }
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
  const harness = models.orchestratorHarness
  if (harness === 'grok') {
    return {
      bin: 'grok',
      args: [
        ...(ctx.resumeId ? ['--resume', ctx.resumeId] : ctx.resumeLatest ? ['--continue'] : []),
        ...grokArgs(models.orchestratorModel, models.orchestratorEffort, ctx.prompt),
        // Pins the worker model on grok's own delegation path; verified to
        // reach the subagent's effective_model_id.
        ...(ctx.agentsJson ? ['--agents', ctx.agentsJson] : []),
      ],
      env: { ...requiredHomes(ctx, models.orchestratorModel, [models.subagentModel, models.assetModel]), ...grokEnv(ctx) },
    }
  }
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
        ? { CLAUDE_CODE_SUBAGENT_MODEL: models.subagentHarness === 'claude' ? models.subagentModel : DISPATCHER_MODEL }
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
  const harness = models.orchestratorHarness
  if (harness === 'grok') {
    return {
      bin: 'grok',
      args: grokArgs(models.orchestratorModel, models.orchestratorEffort, ctx.prompt),
      env: { ...requiredHomes(ctx, models.orchestratorModel, [models.assetModel]), ...grokEnv(ctx) },
    }
  }
  if (harness === 'codex') {
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
        ? { CLAUDE_CODE_SUBAGENT_MODEL: models.assetHarness === 'claude' ? models.assetModel : DISPATCHER_MODEL }
        : {}),
    },
  }
}

/** A one-agent research run using the orchestrator model, with no delegation. */
export function referencePlan(ctx: PlanContext): SpawnPlan {
  const { models } = ctx
  if (models.orchestratorHarness === 'grok') {
    return {
      bin: 'grok',
      args: grokArgs(models.orchestratorModel, models.orchestratorEffort, ctx.prompt),
      env: { ...requiredHomes(ctx, models.orchestratorModel, [models.researchModel]), ...grokEnv(ctx) },
    }
  }
  if (models.orchestratorHarness === 'codex') {
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
  if (models.criticHarness === 'grok') {
    // No `-o` equivalent: grok's verdict comes back in the result event's
    // `result` field, which the claude translator already surfaces.
    return {
      bin: 'grok',
      args: grokArgs(models.criticModel, models.criticEffort, ctx.prompt),
      env: grokEnv(ctx),
    }
  }
  if (models.criticHarness === 'codex') {
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
