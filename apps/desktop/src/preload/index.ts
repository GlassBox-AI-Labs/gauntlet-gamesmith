import { contextBridge, ipcRenderer } from 'electron'
import type { HarnessApi, HarnessKind, LoginEvent, TerminalDataEvent } from '../shared/harness'
import type { LoopApi, LoopLogLine, LoopSnapshot, PlayState } from '../shared/loop'
import type { ReportApi } from '../shared/reports'

const harnesses: HarnessApi = {
  detect: (kind) => ipcRenderer.invoke('harness:detect', kind),
  probe: (kind) => ipcRenderer.invoke('harness:probe', kind),
  startLogin: (kind) => ipcRenderer.invoke('harness:start-login', kind),
  cancelLogin: (kind) => ipcRenderer.invoke('harness:cancel-login', kind),
  logout: (kind) => ipcRenderer.invoke('harness:logout', kind),
  accounts: (kind) => ipcRenderer.invoke('harness:accounts', kind),
  addAccount: (kind) => ipcRenderer.invoke('harness:add-account', kind),
  switchAccount: (kind, accountId) => ipcRenderer.invoke('harness:switch-account', kind, accountId),
  removeAccount: (kind, accountId) => ipcRenderer.invoke('harness:remove-account', kind, accountId),
  writeTerminal: (kind: HarnessKind, data: string) => ipcRenderer.send('harness:terminal-input', { kind, data }),
  resizeTerminal: (kind: HarnessKind, cols: number, rows: number) =>
    ipcRenderer.send('harness:terminal-resize', { kind, cols, rows }),
  onAccountsChanged: (listener) => {
    const wrapped = (_event: Electron.IpcRendererEvent, kind: HarnessKind): void => listener(kind)
    ipcRenderer.on('harness:accounts-changed', wrapped)
    return () => ipcRenderer.removeListener('harness:accounts-changed', wrapped)
  },
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
  reference: (loopId, runId) => ipcRenderer.invoke('loop:reference', loopId, runId),
  mediaBase: () => ipcRenderer.invoke('media:base'),
  playStart: (loopId, round) => ipcRenderer.invoke('play:start', loopId, round),
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
  exportRun: (loopId) => ipcRenderer.invoke('loop:export', loopId),
  importRun: () => ipcRenderer.invoke('loop:import'),
  deleteRuns: (loopIds, deleteFiles) => ipcRenderer.invoke('loop:delete', loopIds, deleteFiles),
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

const reports: ReportApi = {
  list: () => ipcRenderer.invoke('report:list'),
  get: (reportId) => ipcRenderer.invoke('report:get', reportId),
  create: (name, loopIds) => ipcRenderer.invoke('report:create', name, loopIds),
  rename: (reportId, name) => ipcRenderer.invoke('report:rename', reportId, name),
  addRuns: (reportId, loopIds) => ipcRenderer.invoke('report:add-runs', reportId, loopIds),
  removeRuns: (reportId, loopIds) => ipcRenderer.invoke('report:remove-runs', reportId, loopIds),
  refresh: (reportId) => ipcRenderer.invoke('report:refresh', reportId),
  remove: (reportId) => ipcRenderer.invoke('report:delete', reportId),
  markdown: (reportId) => ipcRenderer.invoke('report:markdown', reportId),
  exportJson: (reportId) => ipcRenderer.invoke('report:export-json', reportId),
  exportMarkdown: (reportId) => ipcRenderer.invoke('report:export-markdown', reportId),
  importReport: () => ipcRenderer.invoke('report:import'),
}

contextBridge.exposeInMainWorld('harnesses', harnesses)
contextBridge.exposeInMainWorld('loops', loops)
contextBridge.exposeInMainWorld('reports', reports)
