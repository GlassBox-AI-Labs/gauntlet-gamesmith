import { contextBridge, ipcRenderer } from 'electron'
import type { HarnessApi, HarnessKind, LoginEvent, TerminalDataEvent } from '../shared/harness'

const harnesses: HarnessApi = {
  detect: (kind) => ipcRenderer.invoke('harness:detect', kind),
  probe: (kind) => ipcRenderer.invoke('harness:probe', kind),
  startLogin: (kind) => ipcRenderer.invoke('harness:start-login', kind),
  cancelLogin: (kind) => ipcRenderer.invoke('harness:cancel-login', kind),
  writeTerminal: (kind: HarnessKind, data: string) => ipcRenderer.send('harness:terminal-input', { kind, data }),
  resizeTerminal: (kind: HarnessKind, cols: number, rows: number) =>
    ipcRenderer.send('harness:terminal-resize', { kind, cols, rows }),
  onLoginEvent: (listener) => {
    const wrapped = (_event: Electron.IpcRendererEvent, payload: LoginEvent): void => listener(payload)
    ipcRenderer.on('harness:login-event', wrapped)
    return () => ipcRenderer.removeListener('harness:login-event', wrapped)
  },
  onTerminalData: (listener) => {
    const wrapped = (_event: Electron.IpcRendererEvent, payload: TerminalDataEvent): void => listener(payload)
    ipcRenderer.on('harness:terminal-data', wrapped)
    return () => ipcRenderer.removeListener('harness:terminal-data', wrapped)
  },
}

contextBridge.exposeInMainWorld('harnesses', harnesses)
