import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron'
import {
  BUFFER_CREATE_CHANNEL,
  BUFFERS_CHANGED_CHANNEL,
  BUFFERS_CHANNEL,
  type BufferList,
} from '../shared/buffers'
import type { BufferRegistry } from './buffers'
import { parseBufferSpec } from './buffers'
import { isInternalSender } from './commands/dispatcher'

/**
 * The buffer list crosses to the renderer here (#60). The main process owns
 * the list; the window asks for it once and then follows the pushed snapshots.
 * Every handler validates the sender frame first (SECURITY.org, T1).
 *
 * One registry for the one window M1 has; a registry per window arrives with
 * the second window (#70).
 */
export function installBufferBridge(buffers: BufferRegistry): BufferRegistry {
  ipcMain.handle(BUFFERS_CHANNEL, (event: IpcMainInvokeEvent) => {
    assertInternal(event, BUFFERS_CHANNEL)
    return buffers.snapshot()
  })

  buffers.subscribe((list: BufferList) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send(BUFFERS_CHANGED_CHANNEL, list)
    }
  })

  // Test-only: the end-to-end spec opens a second transcript buffer (#60).
  // The shipped surface does not carry it; buffers are opened by commands.
  if (process.env['NODE_ENV'] === 'test') {
    ipcMain.handle(BUFFER_CREATE_CHANNEL, (event: IpcMainInvokeEvent, payload: unknown) => {
      assertInternal(event, BUFFER_CREATE_CHANNEL)
      return buffers.create(parseBufferSpec(payload))
    })
  }

  return buffers
}

function assertInternal(event: IpcMainInvokeEvent, channel: string): void {
  if (!isInternalSender(event.senderFrame, process.env['ELECTRON_RENDERER_URL'])) {
    throw new Error(`Rejected ${channel} from a frame that is not an internal page`)
  }
}
