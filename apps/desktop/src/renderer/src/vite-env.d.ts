/// <reference types="vite/client" />

import type { HarnessApi } from '../../shared/harness'
import type { BuildApi } from '../../shared/build'
import type { OnboardingApi } from '../../shared/onboarding'
import type { ReportApi } from '../../shared/reports'

import type { BuildContextApi } from '../../shared/build-context'

import type { AttachmentApi } from '../../shared/attachments'

declare global {
  interface Window {
    buildContext?: BuildContextApi
    attachments: AttachmentApi
    harnesses: HarnessApi
    builds: BuildApi
    reports: ReportApi
    onboarding: OnboardingApi
  }
}

export {}
