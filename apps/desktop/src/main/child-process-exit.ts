/** App-owned record appended after a delegated CLI process has actually exited. */
export const CHILD_PROCESS_EXIT_EVENT = 'gauntlet.child_process_exited'

export interface ChildProcessExit {
  exitCode: number
}

/** Parse only the narrow marker emitted by the fixed delegation wrapper. */
export function parseChildProcessExit(line: string): ChildProcessExit | null {
  if (!line.includes(CHILD_PROCESS_EXIT_EVENT)) return null
  try {
    const value: unknown = JSON.parse(line)
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const record = value as Record<string, unknown>
    if (
      record.type !== CHILD_PROCESS_EXIT_EVENT
      || !Number.isSafeInteger(record.exit_code)
      || (record.exit_code as number) < 0
      || (record.exit_code as number) > 255
    ) return null
    return { exitCode: record.exit_code as number }
  } catch {
    return null
  }
}
