import type { OperationResult } from '../shared/result'
import { redactedErrorMessage } from '../shared/redact-log'

/** Resolve every supervisor before Electron is allowed to exit. */
export async function settleQuitSupervisors(
  settleAgents: () => Promise<boolean>,
  settlePlay: () => Promise<void>,
): Promise<OperationResult<void>> {
  try {
    // Start both supervisors immediately, but convert Play rejection to data
    // so it is always observed even when agent settlement fails first.
    const playSettlement = Promise.resolve()
      .then(settlePlay)
      .then((): { error: unknown | null } => ({ error: null }), (error: unknown) => ({ error }))
    const agentsSettled = await settleAgents()
    if (!agentsSettled) {
      return {
        ok: false,
        error: 'The identity-verified agent process group has not settled. The app will remain open so supervision and bounded escalation continue; stop the process manually before quitting again.',
      }
    }
    const play = await playSettlement
    if (play.error) throw play.error
    return { ok: true, value: undefined }
  } catch (error) {
    return {
      ok: false,
      error: `Quit settlement failed safely: ${redactedErrorMessage(error, 'Unknown supervisor failure.')} The app remains open; retry after confirming all supervised processes have stopped.`,
    }
  }
}
