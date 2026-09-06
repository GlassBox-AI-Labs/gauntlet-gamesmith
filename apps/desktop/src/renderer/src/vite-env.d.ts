/// <reference types="vite/client" />

import type { SteeringApi } from '../../shared/steering'
import type { HarnessApi } from '../../shared/harness'
import type { LoopApi } from '../../shared/loop'
import type { OnboardingApi } from '../../shared/onboarding'
import type { ReportApi } from '../../shared/reports'

import type { RunContextApi } from '../../shared/run-context'

import type { AttachmentApi } from '../../shared/attachments'

declare global {
  interface Window {
    runContext?: RunContextApi
    attachments: AttachmentApi
    harnesses: HarnessApi
    loops: LoopApi
    steering: SteeringApi
    reports: ReportApi
    onboarding: OnboardingApi
  }
}

export {}
