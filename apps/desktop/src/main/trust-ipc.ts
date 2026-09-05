import type { MessageBoxOptions } from 'electron'
import type { Ledger } from './ledger'
import { assertLoopId } from './ipc-input'
import type { LoopLogLine, LoopRecord } from '../shared/loop'
import { failure, success, type OperationResult } from '../shared/result'
import { redactedErrorMessage } from '../shared/redact-log'

/** Native dialog is the only source of consent. No renderer boolean or path is accepted. */
export async function trustExistingRun(
  ledger: Ledger,
  value: unknown,
  showMessageBox: (options: MessageBoxOptions) => Promise<{ response: number }>,
  notify: (loop: LoopRecord, line: LoopLogLine) => void,
  hasActivePlay: () => boolean,
): Promise<OperationResult<LoopRecord | null>> {
  try {
    const id = assertLoopId(value)
    let confirmed = false
    const loop = await ledger.trustExistingLoop(id, async (selected) => {
      const choice = await showMessageBox({
        type: 'warning', title: 'Trust existing run and folder?',
        message: 'Trust this existing run and folder?',
        detail: `Run: ${selected.title}\nFolder: ${selected.workspaceDir}\n\nTrusting allows Gauntlet Gamesmith, its agents, and project scripts to execute with your local user permissions. Resume executes the instructions in this run history. Only continue if you recognize and trust this run and folder.`,
        buttons: ['Cancel', 'Trust run & folder'], defaultId: 0, cancelId: 0, noLink: true,
      })
      confirmed = choice.response === 1
      return confirmed
    }, () => {
      if (hasActivePlay()) throw new Error('Stop every Play process before trusting an existing folder.')
    })
    if (loop && confirmed) {
      const line = ledger.eventsForLoop(id, 1).at(-1)
      if (line) notify(loop, line)
    }
    return success(loop)
  } catch (error) {
    return failure(redactedErrorMessage(error, 'This existing run could not be trusted safely.'))
  }
}
