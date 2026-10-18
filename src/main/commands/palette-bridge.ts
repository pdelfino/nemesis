import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron'
import {
  HELP_SHOWN_CHANNEL,
  PALETTE_ANSWER_CHANNEL,
  PALETTE_OPEN_CHANNEL,
} from '../../shared/palette'
import type { HelpBuffers } from '../help'
import { isInternalSender } from './dispatcher'
import { parsePaletteAnswer, type Prompter } from './prompter'

/**
 * The palette meets the window here (#65). A read the prompter starts is
 * pushed to the window, which answers through a sender- and shape-validated
 * invoke handler (SECURITY.org, T1); the text of the help buffer goes out the
 * same way. One window in M1, as in the other bridges.
 */
export interface PaletteBridgeOptions {
  readonly prompter: Prompter
  readonly help: HelpBuffers
}

export function installPaletteBridge(options: PaletteBridgeOptions): void {
  const { prompter, help } = options
  prompter.on((request) => broadcast(PALETTE_OPEN_CHANNEL, request))
  help.on((content) => broadcast(HELP_SHOWN_CHANNEL, content))

  ipcMain.handle(PALETTE_ANSWER_CHANNEL, (event: IpcMainInvokeEvent, payload: unknown) => {
    assertInternal(event, PALETTE_ANSWER_CHANNEL)
    return prompter.answer(parsePaletteAnswer(payload))
  })
}

function broadcast(channel: string, payload: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(channel, payload)
  }
}

function assertInternal(event: IpcMainInvokeEvent, channel: string): void {
  if (!isInternalSender(event.senderFrame, process.env['ELECTRON_RENDERER_URL'])) {
    throw new Error(`Rejected ${channel} from a frame that is not an internal page`)
  }
}
