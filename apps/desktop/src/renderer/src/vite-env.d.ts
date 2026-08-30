/// <reference types="vite/client" />

import type { HarnessApi } from '../../shared/harness'

declare global {
  interface Window {
    harnesses: HarnessApi
  }
}

export {}
