import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { BINDINGS_CHANNEL, DISPATCH_LOG_CHANNEL, KEY_CHANNEL } from '../../shared/keys'
import type { KeyDispatcher } from './dispatcher'
import { isInternalSender, parseKeyPress } from './dispatcher'
import { createCockpitDispatcher } from './keyscheme'

/**
 * The renderer reports key presses, the main process decides what they mean
 * (#59). Every handler validates the sender frame first (SECURITY.org).
 *
 * One dispatcher for the one window M1 has; a dispatcher per window arrives
 * with the second window.
 */
export function installKeyBridge(
  dispatcher: KeyDispatcher = createCockpitDispatcher(),
): KeyDispatcher {
  ipcMain.handle(KEY_CHANNEL, async (event: IpcMainInvokeEvent, payload: unknown) => {
    assertInternal(event, KEY_CHANNEL)
    return dispatcher.handle(parseKeyPress(payload))
  })

  // The renderer learns the shape of the keymaps, never the commands, so it
  // can leave every unbound key to the editor under it (#61).
  ipcMain.handle(BINDINGS_CHANNEL, (event: IpcMainInvokeEvent) => {
    assertInternal(event, BINDINGS_CHANNEL)
    return dispatcher.bindings
  })

  // Test-only: the end-to-end spec reads what the keys dispatched (#59).
  if (process.env['NODE_ENV'] === 'test') {
    ipcMain.handle(DISPATCH_LOG_CHANNEL, (event: IpcMainInvokeEvent) => {
      assertInternal(event, DISPATCH_LOG_CHANNEL)
      return dispatcher.log
    })
  }

  return dispatcher
}

function assertInternal(event: IpcMainInvokeEvent, channel: string): void {
  if (!isInternalSender(event.senderFrame, process.env['ELECTRON_RENDERER_URL'])) {
    throw new Error(`Rejected ${channel} from a frame that is not an internal page`)
  }
}
