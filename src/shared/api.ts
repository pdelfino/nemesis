/**
 * The surface internal pages see as `window.nemesis`. Implemented by the
 * preload script, consumed by the renderer. Grows only through typed IPC
 * (SECURITY.org, T1; completed by #53).
 */
export interface NemesisApi {
  readonly name: 'nemesis'
  readonly version: string
}

declare global {
  interface Window {
    nemesis: NemesisApi
  }
}

export const APP_NAME = 'Nemesis' as const
