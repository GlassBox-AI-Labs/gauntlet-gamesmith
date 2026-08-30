/// <reference types="vite/client" />

import type { HarnessApi } from '../../shared/harness'
import type { LoopApi } from '../../shared/loop'

declare global {
  interface Window {
    harnesses: HarnessApi
    loops: LoopApi
  }
}

export {}
