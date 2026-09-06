import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { IPC } from '../shared/ipc'
import { createContextFolders } from './context-folders'
import { developmentRendererUrl } from './dev-renderer-url'
import type { ContextResult } from '../shared/build-context'

// Dedicated development entry: no ledger, CLI login, recovery, or agent execution.
app.setName('Gauntlet Gamesmith — Build Form Prototype')
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'gauntlet-build-form-')))
const folders = createContextFolders()
async function result<T>(action: () => T | Promise<T>): Promise<ContextResult<T>> {
  try { return { ok: true, value: await action() } }
  catch { return { ok: false, error: 'Could not access this folder. It may have moved or permission was denied. Attach it again.' } }
}
void app.whenReady().then(() => {
  const rendererUrl = developmentRendererUrl(process.env.ELECTRON_RENDERER_URL, app.isPackaged)
  if (!rendererUrl) { app.quit(); return }
  const window = new BrowserWindow({
    width: 1280, height: 850, title: 'Build Form Prototype — A', backgroundColor: '#100d0e',
    webPreferences: { preload: path.join(__dirname, '../preload/index.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  })
  ipcMain.handle(IPC.context.droppedFolder, (_event, value: unknown) => result(() => folders.add(value)))
  ipcMain.handle(IPC.context.pickFolder, () => result(async () => {
    const picked = await dialog.showOpenDialog(window, { title: 'Add folder to context', properties: ['openDirectory'] })
    return picked.canceled || !picked.filePaths[0] ? null : folders.add(picked.filePaths[0])
  }))
  ipcMain.handle(IPC.context.openFolder, (_event, value: unknown) => result(async () => {
    const error = await shell.openPath(folders.resolve(value))
    if (error) throw new Error(error)
    return null
  }))
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event) => event.preventDefault())
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  const url = new URL(rendererUrl)
  url.searchParams.set('prototype', 'build-form')
  url.searchParams.set('variant', 'A')
  void window.loadURL(url.toString())
})
app.on('window-all-closed', () => app.quit())
