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
 * the per-type keymaps already speak (`prompt`, `transcript`, `diff` since
 * #68, `page` since #119).
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
  /**
   * A page buffer's committed top-frame URL (SECURITY.org T3), never the URL
   * a navigation merely started on. Absent on every other kind, and on a page
   * that has committed nothing yet.
   */
  readonly url?: string
  /**
   * The modes the buffer is in, first wins (ADR 0004). A kind with default
   * modes starts in them (`permission`, `diff`, `plan`, `spec`, #166), and
   * the mode commands change the list. A page buffer's are its own (#120):
   * `document` always, `passthrough` in front of it while every key but its
   * exit chord goes to the page. The `base` mode, the global map, is under
   * every buffer and never listed. Absent on a buffer in no mode.
   */
  readonly modes?: readonly string[]
  /** A page buffer's zoom as a percentage, Chromium's per origin (#120). Absent on every other kind. */
  readonly zoom?: number
  /**
   * A page buffer's blocker mode (#126): on by default, off after
   * `toggle-blocker`. Absent on every other kind, and on a page built without
   * a blocker.
   */
  readonly blocker?: boolean
  /** How many requests the blocker cancelled for the page since it last committed a URL (#126). */
  readonly blocked?: number
}

/** The whole buffer list in creation order, plus which buffer is current. */
export interface BufferList {
  readonly buffers: readonly BufferInfo[]
  readonly currentId: string | null
}

/**
 * The modes of the buffer a key of this type is for (#166): the current
 * buffer's when it is of that type, else the first buffer of the type, as
 * the window shows it. Both sides of the key bridge read it the same way.
 */
export function modesFor(list: BufferList, bufferType: BufferType | null): readonly string[] {
  if (bufferType === null) return []
  const current = list.buffers.find((buffer) => buffer.id === list.currentId)
  const buffer =
    current?.kind === bufferType
      ? current
      : list.buffers.find((candidate) => candidate.kind === bufferType)
  return buffer?.modes ?? []
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

/**
 * What `createPage` takes (#119). A page buffer lives in `persist:default`
 * unless the spec asks for `ephemeral`, the in-memory partition of #54.
 */
export interface PageSpec {
  /** Loaded once the policies are installed; absent opens an empty page buffer. */
  readonly url?: string
  readonly partition?: 'persistent' | 'ephemeral'
}

/**
 * The rectangle of the renderer's content area, in the window's CSS pixels,
 * which the page view of the current page buffer covers. Null when no page
 * may show: no page buffer is current, or the palette is open over it.
 */
export interface PageBounds {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/**
 * One event of a page buffer, read off its WebContents and checked at the
 * boundary (#53) before anything acts on it. The page's renderer process is
 * where these come from, so every string in here is page data: bounded, and
 * never logged.
 */
export type PageEvent =
  /** The committed top-frame URL changed, by a load or within the document. */
  | { readonly type: 'url-changed'; readonly pageId: string; readonly url: string }
  | { readonly type: 'title-changed'; readonly pageId: string; readonly title: string }
  | { readonly type: 'loading-started'; readonly pageId: string }
  /** A top-frame navigation committed on `url`. */
  | { readonly type: 'committed'; readonly pageId: string; readonly url: string }
  | { readonly type: 'finished'; readonly pageId: string }
  /** The page stopped loading, after a load that finished or one that failed. */
  | { readonly type: 'stopped'; readonly pageId: string }
  /** A top-frame load failed: Chromium's code and its reason (`ERR_NAME_NOT_RESOLVED`). */
  | {
      readonly type: 'failed'
      readonly pageId: string
      readonly url: string
      readonly code: number
      readonly reason: string
    }
  /** A top-frame navigation was redirected to `url`; it has not committed. */
  | { readonly type: 'redirect'; readonly pageId: string; readonly url: string }

/** The renderer reports its content area, or null, on show, resize and buffer switch. */
export const PAGE_BOUNDS_CHANNEL = 'nemesis:page-bounds' as const
