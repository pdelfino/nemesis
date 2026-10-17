/**
 * The buffer vocabulary shared by the main process and the renderer (#60).
 *
 * The main process owns the buffer list, as it owns the keymaps: a buffer is
 * created, switched and killed there, and the renderer is told what the list
 * looks like now. A snapshot carries no buffer contents, only identity.
 */

import type { BufferType } from './keys'

/**
 * One buffer, as the renderer and the specs see it. `kind` is the buffer type
 * the per-type keymaps already speak (`prompt`, `transcript`); `diff` and
 * `page` join that vocabulary when those buffers land.
 */
export interface BufferInfo {
  /** Stable for the life of the buffer. Assigned by the registry. */
  readonly id: string
  readonly kind: BufferType
  /** One line, shown in the mode line and, with #65, in the chooser. */
  readonly title: string
  /**
   * The renderer element that shows the buffer, or null when the window does
   * not show it yet. A page buffer brings its own WebContentsView (M4, #48).
   */
  readonly elementId: string | null
}

/** The whole buffer list in creation order, plus which buffer is current. */
export interface BufferList {
  readonly buffers: readonly BufferInfo[]
  readonly currentId: string | null
}

/** What a caller must say to open a buffer. */
export interface BufferSpec {
  readonly kind: BufferType
  readonly title: string
  readonly elementId?: string | null
}

/** The renderer asks for the list once at load. */
export const BUFFERS_CHANNEL = 'nemesis:buffers' as const
/** The main process pushes a new list on every create, switch and kill. */
export const BUFFERS_CHANGED_CHANNEL = 'nemesis:buffers-changed' as const
/** Test-only channel: the main process registers it when NODE_ENV=test. */
export const BUFFER_CREATE_CHANNEL = 'nemesis:buffer-create' as const
