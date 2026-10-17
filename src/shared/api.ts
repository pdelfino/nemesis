import type { DispatchRecord, KeyOutcome, KeyPress } from './keys'

/**
 * The surface internal pages see as `window.nemesis`. Implemented by the
 * preload script, consumed by the renderer. Grows only through typed IPC
 * (SECURITY.org, T1; completed by #53).
 */
export interface NemesisApi {
  readonly name: 'nemesis'
  readonly version: string
  /** Reports a key press to the main process, which owns the keymaps (#59). */
  sendKey(press: KeyPress): Promise<KeyOutcome>
  /** Test-only: the commands the keys dispatched. Exposed when NODE_ENV=test (#59). */
  readonly dispatchLog?: () => Promise<readonly DispatchRecord[]>
}

declare global {
  interface Window {
    nemesis: NemesisApi
  }
}

export const APP_NAME = 'Nemesis' as const
