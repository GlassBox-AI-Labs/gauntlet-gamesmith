import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { IPC } from '../shared/ipc'
import type { BuildContextApi } from '../shared/build-context'
const buildContext: BuildContextApi = {
  droppedFolder: (file) => ipcRenderer.invoke(IPC.context.droppedFolder, webUtils.getPathForFile(file)),
  pickFolder: () => ipcRenderer.invoke(IPC.context.pickFolder),
  openFolder: (id) => ipcRenderer.invoke(IPC.context.openFolder, id),
}
contextBridge.exposeInMainWorld('runContext', buildContext)
