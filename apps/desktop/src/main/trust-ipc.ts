import type { MessageBoxOptions } from 'electron'
import type { Ledger } from './ledger'
import { assertBuildId } from './ipc-input'
import type { BuildLogLine, BuildRecord } from '../shared/build'
import { failure, success, type OperationResult } from '../shared/result'
import { redactedErrorMessage } from '../shared/redact-log'

/** Native dialog is the only source of consent. No renderer boolean or path is accepted. */
export async function trustExistingBuild(
  ledger: Ledger,
  value: unknown,
  showMessageBox: (options: MessageBoxOptions) => Promise<{ response: number }>,
  notify: (build: BuildRecord, line: BuildLogLine) => void,
  hasActivePlay: () => boolean,
): Promise<OperationResult<BuildRecord | null>> {
  try {
    const id = assertBuildId(value)
    let confirmed = false
    const build = await ledger.trustExistingBuild(id, async (selected) => {
      const choice = await showMessageBox({
        type: 'warning', title: 'Trust existing build and folder?',
        message: 'Trust this existing build and folder?',
        detail: `Build: ${selected.title}\nFolder: ${selected.workspaceDir}\n\nTrusting allows Gauntlet Gamesmith, its agents, and project scripts to execute with your local user permissions. Resume executes the instructions in this build history. Only continue if you recognize and trust this build and folder.`,
        buttons: ['Cancel', 'Trust build & folder'], defaultId: 0, cancelId: 0, noLink: true,
      })
      confirmed = choice.response === 1
      return confirmed
    }, () => {
      if (hasActivePlay()) throw new Error('Stop every Play process before trusting an existing folder.')
    })
    if (build && confirmed) {
      const line = ledger.eventsForBuild(id, 1).at(-1)
      if (line) notify(build, line)
    }
    return success(build)
  } catch (error) {
    return failure(redactedErrorMessage(error, 'This existing build could not be trusted safely.'))
  }
}
