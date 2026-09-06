/// <reference types="vite/client" />

import type { PublishingApi } from '../../shared/publishing'
import type { HarnessApi } from '../../shared/harness'
import type { LoopApi } from '../../shared/loop'
import type { OnboardingApi } from '../../shared/onboarding'
import type { ReportApi } from '../../shared/reports'

import type { RunContextApi } from '../../shared/run-context'

import type { AttachmentApi } from '../../shared/attachments'

declare global {
  interface Window {
    publishing: PublishingApi
    runContext?: RunContextApi
    attachments: AttachmentApi
    harnesses: HarnessApi
    loops: LoopApi
    reports: ReportApi
    onboarding: OnboardingApi
  }
}

export {}
