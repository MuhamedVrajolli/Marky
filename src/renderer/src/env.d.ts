/// <reference types="vite/client" />
import type { MarkApi } from '../../shared/types'

declare global {
  interface Window {
    mark: MarkApi
  }
}

export {}
