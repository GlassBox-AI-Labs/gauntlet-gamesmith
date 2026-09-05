import { contextBridge, ipcRenderer } from 'electron'
import type { HarnessApi, HarnessKind, LoginEvent, TerminalDataEvent } from '../shared/harness'
import { IPC } from '../shared/ipc'
import type { LoopApi, LoopLogLine, LoopSnapshot, PlayStateEvent } from '../shared/loop'
import type { OnboardingApi } from '../shared/onboarding'
import type { ReportApi } from '../shared/reports'

const harnesses: HarnessApi = {
  detect: (kind) => ipcRenderer.invoke(IPC.harness.detect, kind),
  probe: (kind) => ipcRenderer.invoke(IPC.harness.probe, kind),
  installOffer: (kind) => ipcRenderer.invoke(IPC.harness.installOffer, kind),
  startInstall: (kind) => ipcRenderer.invoke(IPC.harness.startInstall, kind),
  startLogin: (kind) => ipcRenderer.invoke(IPC.harness.startLogin, kind),
  cancelLogin: (kind) => ipcRenderer.invoke(IPC.harness.cancelLogin, kind),
  logout: (kind) => ipcRenderer.invoke(IPC.harness.logout, kind),
  accounts: (kind) => ipcRenderer.invoke(IPC.harness.accounts, kind),
  addAccount: (kind) => ipcRenderer.invoke(IPC.harness.addAccount, kind),
  switchAccount: (kind, accountId) => ipcRenderer.invoke(IPC.harness.switchAccount, kind, accountId),
  removeAccount: (kind, accountId) => ipcRenderer.invoke(IPC.harness.removeAccount, kind, accountId),
  writeTerminal: (kind: HarnessKind, data: string) => ipcRenderer.send(IPC.harness.terminalInput, { kind, data }),
  resizeTerminal: (kind: HarnessKind, cols: number, rows: number) =>
    ipcRenderer.send(IPC.harness.terminalResize, { kind, cols, rows }),
  onAccountsChanged: (listener) => {
    const wrapped = (_event: Electron.IpcRendererEvent, kind: HarnessKind): void => listener(kind)
    ipcRenderer.on(IPC.harness.accountsChanged, wrapped)
    return () => ipcRenderer.removeListener(IPC.harness.accountsChanged, wrapped)
  },
  onLoginEvent: (listener) => {
    const wrapped = (_event: Electron.IpcRendererEvent, payload: LoginEvent): void => listener(payload)
    ipcRenderer.on(IPC.harness.loginEvent, wrapped)
    return () => ipcRenderer.removeListener(IPC.harness.loginEvent, wrapped)
  },
  onTerminalData: (listener) => {
    const wrapped = (_event: Electron.IpcRendererEvent, payload: TerminalDataEvent): void => listener(payload)
    ipcRenderer.on(IPC.harness.terminalData, wrapped)
    return () => ipcRenderer.removeListener(IPC.harness.terminalData, wrapped)
  },
}

const loops: LoopApi = {
  list: (offset) => ipcRenderer.invoke(IPC.loop.list, offset),
  get: (loopId, offset) => ipcRenderer.invoke(IPC.loop.get, loopId, offset),
  rename: (loopId, title) => ipcRenderer.invoke(IPC.loop.rename, loopId, title),
  critique: (loopId) => ipcRenderer.invoke(IPC.loop.critique, loopId),
  reference: (loopId, runId) => ipcRenderer.invoke(IPC.loop.reference, loopId, runId),
  mediaBase: () => ipcRenderer.invoke(IPC.media.base),
  playStart: (loopId, round) => ipcRenderer.invoke(IPC.play.start, loopId, round),
  playStop: (loopId) => ipcRenderer.invoke(IPC.play.stop, loopId),
  playState: (loopId) => ipcRenderer.invoke(IPC.play.state, loopId),
  onPlayState: (listener) => {
    const wrapped = (_event: Electron.IpcRendererEvent, payload: PlayStateEvent): void => listener(payload)
    ipcRenderer.on(IPC.play.state, wrapped)
    return () => ipcRenderer.removeListener(IPC.play.state, wrapped)
  },
  start: (input) => ipcRenderer.invoke(IPC.loop.start, input),
  resume: (loopId) => ipcRenderer.invoke(IPC.loop.resume, loopId),
  stop: (loopId) => ipcRenderer.invoke(IPC.loop.stop, loopId),
  active: () => ipcRenderer.invoke(IPC.loop.active),
  log: (loopId, limit) => ipcRenderer.invoke(IPC.loop.log, loopId, limit),
  prompt: (loopId, role, round) => ipcRenderer.invoke(IPC.loop.prompt, loopId, role, round),
  readStream: (input) => ipcRenderer.invoke(IPC.loop.readStream, input),
  report: (loopId) => ipcRenderer.invoke(IPC.loop.report, loopId),
  exportRun: (loopId) => ipcRenderer.invoke(IPC.loop.exportRun, loopId),
  importRun: () => ipcRenderer.invoke(IPC.loop.importRun),
  deleteRuns: (loopIds, deleteFiles) => ipcRenderer.invoke(IPC.loop.deleteRuns, loopIds, deleteFiles),
  pickWorkspace: () => ipcRenderer.invoke(IPC.loop.pickWorkspace),
  defaultWorkspace: () => ipcRenderer.invoke(IPC.loop.defaultWorkspace),
  onUpdate: (listener) => {
    const wrapped = (_event: Electron.IpcRendererEvent, payload: LoopSnapshot): void => listener(payload)
    ipcRenderer.on(IPC.loop.update, wrapped)
    return () => ipcRenderer.removeListener(IPC.loop.update, wrapped)
  },
  onLog: (listener) => {
    const wrapped = (_event: Electron.IpcRendererEvent, payload: LoopLogLine): void => listener(payload)
    ipcRenderer.on(IPC.loop.log, wrapped)
    return () => ipcRenderer.removeListener(IPC.loop.log, wrapped)
  },
}

const onboarding: OnboardingApi = {
  get: () => ipcRenderer.invoke(IPC.onboarding.get),
  complete: (harness) => ipcRenderer.invoke(IPC.onboarding.complete, harness),
  reset: () => ipcRenderer.invoke(IPC.onboarding.reset),
}

const reports: ReportApi = {
  list: () => ipcRenderer.invoke(IPC.report.list),
  get: (reportId) => ipcRenderer.invoke(IPC.report.get, reportId),
  create: (name, loopIds) => ipcRenderer.invoke(IPC.report.create, name, loopIds),
  rename: (reportId, name) => ipcRenderer.invoke(IPC.report.rename, reportId, name),
  addRuns: (reportId, loopIds) => ipcRenderer.invoke(IPC.report.addRuns, reportId, loopIds),
  removeRuns: (reportId, loopIds) => ipcRenderer.invoke(IPC.report.removeRuns, reportId, loopIds),
  refresh: (reportId) => ipcRenderer.invoke(IPC.report.refresh, reportId),
  remove: (reportId) => ipcRenderer.invoke(IPC.report.remove, reportId),
  markdown: (reportId) => ipcRenderer.invoke(IPC.report.markdown, reportId),
  exportJson: (reportId) => ipcRenderer.invoke(IPC.report.exportJson, reportId),
  exportMarkdown: (reportId) => ipcRenderer.invoke(IPC.report.exportMarkdown, reportId),
  importReport: () => ipcRenderer.invoke(IPC.report.importReport),
}

contextBridge.exposeInMainWorld('harnesses', harnesses)
contextBridge.exposeInMainWorld('loops', loops)
contextBridge.exposeInMainWorld('reports', reports)
contextBridge.exposeInMainWorld('onboarding', onboarding)
