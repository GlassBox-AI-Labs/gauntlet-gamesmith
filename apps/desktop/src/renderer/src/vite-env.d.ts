/// <reference types="vite/client" />

import type { HarnessApi } from '../../shared/harness'
import type { LoopApi } from '../../shared/loop'
import type { ReportApi } from '../../shared/reports'

import type { RunContextApi } from '../../shared/run-context'

import type { AttachmentApi } from '../../shared/attachments'

declare global {
  interface Window {
    runContext?: RunContextApi
    attachments: AttachmentApi
    harnesses: HarnessApi
    loops: LoopApi
    reports: ReportApi
  }
}

export {}
