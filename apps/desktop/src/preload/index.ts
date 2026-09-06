import type { PublishingApi } from '../shared/publishing'
import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { HarnessApi, HarnessKind, LoginEvent, TerminalDataEvent } from '../shared/harness'
import { IPC } from '../shared/ipc'
import type { BuildApi, BuildLogLine, BuildSnapshot, PlayStateEvent } from '../shared/build'
import type { AttachmentApi } from '../shared/attachments'
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

const builds: BuildApi = {
  list: (offset) => ipcRenderer.invoke(IPC.build.list, offset),
  get: (buildId, offset) => ipcRenderer.invoke(IPC.build.get, buildId, offset),
  rename: (buildId, title) => ipcRenderer.invoke(IPC.build.rename, buildId, title),
  critique: (buildId) => ipcRenderer.invoke(IPC.build.critique, buildId),
  reference: (buildId, attemptId) => ipcRenderer.invoke(IPC.build.reference, buildId, attemptId),
  mediaBase: () => ipcRenderer.invoke(IPC.media.base),
  playStart: (buildId, round) => ipcRenderer.invoke(IPC.play.start, buildId, round),
  playStop: (buildId) => ipcRenderer.invoke(IPC.play.stop, buildId),
  playState: (buildId) => ipcRenderer.invoke(IPC.play.state, buildId),
  onPlayState: (listener) => {
    const wrapped = (_event: Electron.IpcRendererEvent, payload: PlayStateEvent): void => listener(payload)
    ipcRenderer.on(IPC.play.state, wrapped)
    return () => ipcRenderer.removeListener(IPC.play.state, wrapped)
  },
  start: (input) => ipcRenderer.invoke(IPC.build.start, input),
  trust: (buildId) => ipcRenderer.invoke(IPC.build.trust, buildId),
  resume: (buildId) => ipcRenderer.invoke(IPC.build.resume, buildId),
  stop: (buildId) => ipcRenderer.invoke(IPC.build.stop, buildId),
  active: () => ipcRenderer.invoke(IPC.build.active),
  log: (buildId, limit) => ipcRenderer.invoke(IPC.build.log, buildId, limit),
  prompt: (buildId, role, round) => ipcRenderer.invoke(IPC.build.prompt, buildId, role, round),
  readStream: (input) => ipcRenderer.invoke(IPC.build.readStream, input),
  report: (buildId) => ipcRenderer.invoke(IPC.build.report, buildId),
  exportBuild: (buildId) => ipcRenderer.invoke(IPC.build.exportBuild, buildId),
  importBuild: () => ipcRenderer.invoke(IPC.build.importBuild),
  deleteBuilds: (buildIds, deleteFiles) => ipcRenderer.invoke(IPC.build.deleteBuilds, buildIds, deleteFiles),
  pickWorkspace: () => ipcRenderer.invoke(IPC.build.pickWorkspace),
  defaultWorkspace: () => ipcRenderer.invoke(IPC.build.defaultWorkspace),
  onUpdate: (listener) => {
    const wrapped = (_event: Electron.IpcRendererEvent, payload: BuildSnapshot): void => listener(payload)
    ipcRenderer.on(IPC.build.update, wrapped)
    return () => ipcRenderer.removeListener(IPC.build.update, wrapped)
  },
  onLog: (listener) => {
    const wrapped = (_event: Electron.IpcRendererEvent, payload: BuildLogLine): void => listener(payload)
    ipcRenderer.on(IPC.build.log, wrapped)
    return () => ipcRenderer.removeListener(IPC.build.log, wrapped)
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
  create: (name, buildIds) => ipcRenderer.invoke(IPC.report.create, name, buildIds),
  rename: (reportId, name) => ipcRenderer.invoke(IPC.report.rename, reportId, name),
  addBuilds: (reportId, buildIds) => ipcRenderer.invoke(IPC.report.addBuilds, reportId, buildIds),
  removeBuilds: (reportId, buildIds) => ipcRenderer.invoke(IPC.report.removeBuilds, reportId, buildIds),
  refresh: (reportId) => ipcRenderer.invoke(IPC.report.refresh, reportId),
  remove: (reportId) => ipcRenderer.invoke(IPC.report.remove, reportId),
  markdown: (reportId) => ipcRenderer.invoke(IPC.report.markdown, reportId),
  exportJson: (reportId) => ipcRenderer.invoke(IPC.report.exportJson, reportId),
  exportMarkdown: (reportId) => ipcRenderer.invoke(IPC.report.exportMarkdown, reportId),
  importReport: () => ipcRenderer.invoke(IPC.report.importReport),
}

contextBridge.exposeInMainWorld('harnesses', harnesses)
contextBridge.exposeInMainWorld('builds', builds)
contextBridge.exposeInMainWorld('reports', reports)

const attachments: AttachmentApi = {
  addFiles: (files) => ipcRenderer.invoke(IPC.attachment.add, files.map((file) => webUtils.getPathForFile(file))),
  pick: () => ipcRenderer.invoke(IPC.attachment.pick),
  preview: (id) => ipcRenderer.invoke(IPC.attachment.preview, id),
  remove: (id) => ipcRenderer.invoke(IPC.attachment.remove, id),
  openFolder: (id) => ipcRenderer.invoke(IPC.attachment.openFolder, id),
}
contextBridge.exposeInMainWorld('attachments', attachments)
contextBridge.exposeInMainWorld('onboarding', onboarding)

const publishing: PublishingApi = {
  history: loopId => ipcRenderer.invoke(IPC.publishing.history, loopId),
  previewRelease: input => ipcRenderer.invoke(IPC.publishing.previewRelease, input),
  unpublish: input => ipcRenderer.invoke(IPC.publishing.unpublish, input),
  cancelSignIn: () => ipcRenderer.invoke(IPC.publishing.cancelSignIn),
  status: () => ipcRenderer.invoke(IPC.publishing.status),
  signIn: (input) => ipcRenderer.invoke(IPC.publishing.signIn, input),
  signUp: (input) => ipcRenderer.invoke(IPC.publishing.signUp, input),
  verifyEmail: (input) => ipcRenderer.invoke(IPC.publishing.verifyEmail, input),
  resendVerification: (input) => ipcRenderer.invoke(IPC.publishing.resendVerification, input),
  signOut: () => ipcRenderer.invoke(IPC.publishing.signOut),
  prepare: input => ipcRenderer.invoke(IPC.publishing.prepare, input),
  publish: input => ipcRenderer.invoke(IPC.publishing.publish, input),
}
contextBridge.exposeInMainWorld('publishing', publishing)
