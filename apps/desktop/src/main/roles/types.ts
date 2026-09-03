export interface ExitInfo {
  /** Null means the exit code is unknown for a re-attached process. */
  code: number | null
  timedOut: boolean
  spawnError: string | null
}

export interface StreamParser {
  onLine(line: string): void
  onStderr(text: string): void
  /** Background fan-out may progress while the primary stream is quiet. */
  tick?(): void
  /** Epoch milliseconds of the last observed progress. */
  progressAt?(): number
  workflowOffsets?(): Record<string, number>
  workflowIdentities?(): Record<string, { dev: number; ino: number }>
  finalize(exit: ExitInfo): Promise<void> | void
}

export interface LogGate {
  suppress: boolean
}
