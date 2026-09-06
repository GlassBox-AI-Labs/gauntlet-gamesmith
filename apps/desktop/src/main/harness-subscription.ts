import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import type { HarnessKind } from '../shared/harness'
import { cliExecutable } from './cli-executable'
import { cliHomeEnv, cliPrivateRoot, subscriptionEnv } from './harness-env'
import { parseClaudeStatus, parseCodexStatus, subscriptionAuthError } from './harness-status'

export interface SubscriptionReadiness {
  ok: boolean
  error: string | null
}

export type StatusCommand = (
  binary: string,
  args: readonly string[],
  options: {
    cwd: string
    env: Record<string, string>
    encoding: 'utf8'
    timeout: number
    maxBuffer: number
  },
) => SpawnSyncReturns<string>

export type CliExecutable = (kind: HarnessKind, unsafeRoots?: readonly string[], sourceEnv?: NodeJS.ProcessEnv) => string

/**
 * Re-check the selected app-managed CLI profile immediately before execution.
 * Login can change between the UI's initial Start check and a later retry,
 * resume, or boot recovery; treating every attempt as subscription without this
 * gate risks charging an API-key/provider account.
 */
export function subscriptionReadiness(
  kind: HarnessKind,
  cwd: string,
  harnessHome: string,
  sourceEnv: NodeJS.ProcessEnv = process.env,
  command: StatusCommand = spawnSync,
  resolveBinary: CliExecutable = cliExecutable,
): SubscriptionReadiness {
  const binary = resolveBinary(kind, [cwd, cliPrivateRoot(harnessHome)], sourceEnv)
  const args = kind === 'claude' ? ['auth', 'status', '--json'] : ['login', 'status']
  const result = command(binary, args, {
    cwd,
    env: subscriptionEnv(cliHomeEnv(kind, harnessHome), sourceEnv, kind, [cwd, cliPrivateRoot(harnessHome)]),
    encoding: 'utf8',
    timeout: 8_000,
    maxBuffer: 64 * 1024,
  })
  const probe = kind === 'claude'
    ? parseClaudeStatus(result.stdout, result.stderr, null)
    : parseCodexStatus(result.status === 0 && result.error == null, result.stdout, result.stderr, null)
  const error = subscriptionAuthError(kind === 'claude' ? 'Claude Code' : 'Codex', probe)
  return { ok: error == null, error }
}
