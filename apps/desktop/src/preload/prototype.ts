import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { IPC } from '../shared/ipc'
import type { RunContextApi } from '../shared/run-context'
const runContext: RunContextApi = {
  droppedFolder: (file) => ipcRenderer.invoke(IPC.context.droppedFolder, webUtils.getPathForFile(file)),
  pickFolder: () => ipcRenderer.invoke(IPC.context.pickFolder),
  openFolder: (id) => ipcRenderer.invoke(IPC.context.openFolder, id),
}
contextBridge.exposeInMainWorld('runContext', runContext)
