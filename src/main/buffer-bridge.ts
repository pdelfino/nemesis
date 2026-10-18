import { BrowserWindow } from 'electron'
import {
  BUFFER_CREATE_CHANNEL,
  BUFFERS_CHANGED_CHANNEL,
  BUFFERS_CHANNEL,
  type BufferList,
} from '../shared/buffers'
import type { BufferRegistry } from './buffers'
import { parseBufferSpec } from './buffers'
import { handle, parseNothing } from './ipc'

/**
 * The buffer list crosses to the renderer here (#60). The main process owns
 * the list; the window asks for it once and then follows the pushed snapshots.
 * Every channel goes through `handle()`, which validates the sender and the
 * shape first (SECURITY.org, T1; #53).
 *
 * One registry for the one window M1 has; a registry per window arrives with
 * the second window (#70).
 */
export function installBufferBridge(buffers: BufferRegistry): BufferRegistry {
  handle(BUFFERS_CHANNEL, parseNothing, () => buffers.snapshot())

  buffers.subscribe((list: BufferList) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send(BUFFERS_CHANGED_CHANNEL, list)
    }
  })

  // Test-only: the end-to-end spec opens a second transcript buffer (#60).
  // The shipped surface does not carry it; buffers are opened by commands.
  if (process.env['NODE_ENV'] === 'test') {
    handle(BUFFER_CREATE_CHANNEL, parseBufferSpec, (spec) => buffers.create(spec))
  }

  return buffers
}
