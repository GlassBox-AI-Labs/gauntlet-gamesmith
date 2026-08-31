import { contextBridge, ipcRenderer } from 'electron'
import type { HarnessApi, HarnessKind, LoginEvent, TerminalDataEvent } from '../shared/harness'
import type { LoopApi, LoopLogLine, LoopSnapshot, PlayState } from '../shared/loop'

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

const loops: LoopApi = {
  list: () => ipcRenderer.invoke('loop:list'),
  get: (loopId) => ipcRenderer.invoke('loop:get', loopId),
  rename: (loopId, title) => ipcRenderer.invoke('loop:rename', loopId, title),
  critique: (loopId) => ipcRenderer.invoke('loop:critique', loopId),
  mediaBase: () => ipcRenderer.invoke('media:base'),
  playStart: (loopId) => ipcRenderer.invoke('play:start', loopId),
  playStop: (loopId) => ipcRenderer.invoke('play:stop', loopId),
  playState: (loopId) => ipcRenderer.invoke('play:state', loopId),
  onPlayState: (listener) => {
    const wrapped = (_event: Electron.IpcRendererEvent, payload: PlayState & { loopId: string }): void => listener(payload)
    ipcRenderer.on('play:state', wrapped)
    return () => ipcRenderer.removeListener('play:state', wrapped)
  },
  start: (input) => ipcRenderer.invoke('loop:start', input),
  resume: (loopId) => ipcRenderer.invoke('loop:resume', loopId),
  stop: (loopId) => ipcRenderer.invoke('loop:stop', loopId),
  active: () => ipcRenderer.invoke('loop:active'),
  log: (loopId, limit) => ipcRenderer.invoke('loop:log', loopId, limit),
  report: (loopId) => ipcRenderer.invoke('loop:report', loopId),
  pickWorkspace: () => ipcRenderer.invoke('loop:pick-workspace'),
  defaultWorkspace: () => ipcRenderer.invoke('loop:default-workspace'),
  onUpdate: (listener) => {
    const wrapped = (_event: Electron.IpcRendererEvent, payload: LoopSnapshot): void => listener(payload)
    ipcRenderer.on('loop:update', wrapped)
    return () => ipcRenderer.removeListener('loop:update', wrapped)
  },
  onLog: (listener) => {
    const wrapped = (_event: Electron.IpcRendererEvent, payload: LoopLogLine): void => listener(payload)
    ipcRenderer.on('loop:log', wrapped)
    return () => ipcRenderer.removeListener('loop:log', wrapped)
  },
}

contextBridge.exposeInMainWorld('harnesses', harnesses)
contextBridge.exposeInMainWorld('loops', loops)
