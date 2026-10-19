import type { WebContents } from 'electron'
import {
  BUFFER_CREATE_CHANNEL,
  BUFFERS_CHANGED_CHANNEL,
  BUFFERS_CHANNEL,
  PAGE_BOUNDS_CHANNEL,
  type BufferList,
  type PageBounds,
} from '../shared/buffers'
import type { BufferRegistry } from './buffers'
import { parseBufferSpec } from './buffers'
import { handleIn, parseNothing } from './ipc'
import { parsePageBounds } from './page-buffer'

/**
 * The buffer list crosses to the renderer here (#60). The main process owns
 * the list; the window asks for it once and then follows the pushed snapshots.
 * Every channel goes through `handleIn()`, which validates the sender and the
 * shape first (SECURITY.org, T1; #53).
 *
 * One registry per window (#70): the window's calls reach its own registry,
 * found by the sender, and its snapshots go to that window only.
 */
export function installBufferBridge(
  buffers: BufferRegistry,
  contents: WebContents,
): BufferRegistry {
  handleIn(contents, BUFFERS_CHANNEL, parseNothing, () => buffers.snapshot())

  buffers.subscribe((list: BufferList) => {
    if (!contents.isDestroyed()) contents.send(BUFFERS_CHANGED_CHANNEL, list)
  })

  // Test-only: the end-to-end spec opens a second transcript buffer (#60).
  // The shipped surface does not carry it; buffers are opened by commands.
  if (process.env['NODE_ENV'] === 'test') {
    handleIn(contents, BUFFER_CREATE_CHANNEL, parseBufferSpec, (spec) => buffers.create(spec))
  }

  return buffers
}

/**
 * The page buffers' one call (#119): the renderer's content area, or null,
 * checked by `parsePageBounds` before the current page's view moves.
 */
export function installPageBridge(
  pages: { setBounds(bounds: PageBounds | null): void },
  contents: WebContents,
): void {
  handleIn(contents, PAGE_BOUNDS_CHANNEL, parsePageBounds, (bounds) => pages.setBounds(bounds))
}
