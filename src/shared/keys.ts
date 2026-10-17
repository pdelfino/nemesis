/**
 * The key and command vocabulary shared by the main process and the renderer
 * (#59). The renderer only reports key presses; the main process owns the
 * registry, the keymaps and the dispatch, so there is one source of truth for
 * what a chord means.
 */

/** Buffer types the cockpit knows about. Per-type keymaps override the global map. */
export type BufferType = 'prompt' | 'transcript' | 'permission'

/**
 * Buffer types where an unmodified key is a command, not text (`y`/`n` on a
 * permission prompt). Everywhere else the renderer keeps plain typing local and
 * only reports chords, so typed text never crosses the bridge.
 */
export const MODAL_BUFFER_TYPES: readonly BufferType[] = ['permission']

/** One key press, as the renderer saw it. `code` is the layout-independent fallback. */
export interface KeyPress {
  readonly key: string
  readonly code: string
  readonly ctrlKey: boolean
  readonly altKey: boolean
  readonly shiftKey: boolean
  readonly metaKey: boolean
  readonly bufferType: BufferType | null
}

/**
 * What the main process did with a key press. `chord` is the sequence so far in
 * Emacs notation, which the echo area will show once the mode line lands.
 */
export interface KeyOutcome {
  readonly status: 'command' | 'pending' | 'unbound' | 'ignored' | 'error'
  readonly chord: string
  readonly command?: string
}

/** One dispatched command. Never holds buffer text, only the chord and the name. */
export interface DispatchRecord {
  readonly at: number
  readonly chord: string
  readonly command: string
  readonly bufferType: BufferType | null
}

export const KEY_CHANNEL = 'nemesis:key' as const
/** Test-only channel: the main process registers it when NODE_ENV=test. */
export const DISPATCH_LOG_CHANNEL = 'nemesis:dispatch-log' as const
