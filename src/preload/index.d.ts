import type { StudioApi } from './index.ts'

declare global {
  interface Window {
    readonly studio?: StudioApi
  }
}

export {}
