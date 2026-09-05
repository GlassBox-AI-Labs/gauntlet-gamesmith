import { dialog, ipcMain, shell, type BrowserWindow } from 'electron'
import { IPC } from '../shared/ipc'
import { redactedErrorMessage } from '../shared/redact-log'
import type { AttachmentResult } from '../shared/attachments'
import type { createRunAttachments } from './run-attachments'

export function registerAttachmentIpc(store: ReturnType<typeof createRunAttachments>, window: () => BrowserWindow | null): void {
  async function result<T>(action: () => T | Promise<T>): Promise<AttachmentResult<T>> {
    try { return { ok: true, value: await action() } }
    catch (error) { return { ok: false, error: redactedErrorMessage(error, 'Could not access the attachment.') } }
  }
  ipcMain.handle(IPC.attachment.add, (_event, value: unknown) => result(() => store.add(value)))
  ipcMain.handle(IPC.attachment.pick, () => result(async () => {
    const owner = window()
    if (!owner) throw new Error('The app window is not ready.')
    const picked = await dialog.showOpenDialog(owner, { title: 'Attach files or folders', buttonLabel: 'Attach', properties: ['openFile', 'openDirectory', 'multiSelections'] })
    return picked.canceled ? [] : store.add(picked.filePaths)
  }))
  ipcMain.handle(IPC.attachment.preview, (_event, value: unknown) => result(() => store.preview(value)))
  ipcMain.handle(IPC.attachment.remove, (_event, value: unknown) => result(() => { store.remove(value); return null }))
  ipcMain.handle(IPC.attachment.openFolder, (_event, value: unknown) => result(async () => {
    const error = await shell.openPath(store.folder(value))
    if (error) throw new Error(error)
    return null
  }))
}
