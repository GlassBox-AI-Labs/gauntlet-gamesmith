/// <reference types="vite/client" />

import type { HarnessApi } from '../../shared/harness'
import type { LoopApi } from '../../shared/loop'
import type { OnboardingApi } from '../../shared/onboarding'
import type { ReportApi } from '../../shared/reports'

declare global {
  interface Window {
    harnesses: HarnessApi
    loops: LoopApi
    reports: ReportApi
    onboarding: OnboardingApi
  }
}

export {}
