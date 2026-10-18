import { BrowserWindow } from 'electron'
import {
  HELP_SHOWN_CHANNEL,
  PALETTE_ANSWER_CHANNEL,
  PALETTE_OPEN_CHANNEL,
} from '../../shared/palette'
import type { HelpBuffers } from '../help'
import { handle } from '../ipc'
import { parsePaletteAnswer, type Prompter } from './prompter'

/**
 * The palette meets the window here (#65). A read the prompter starts is
 * pushed to the window, which answers through `handle()`, so the sender and
 * the shape are validated first (SECURITY.org, T1; #53); the text of the
 * help buffer goes out the same way. One window in M1, as in the other
 * bridges.
 */
export interface PaletteBridgeOptions {
  readonly prompter: Prompter
  readonly help: HelpBuffers
}

export function installPaletteBridge(options: PaletteBridgeOptions): void {
  const { prompter, help } = options
  prompter.on((request) => broadcast(PALETTE_OPEN_CHANNEL, request))
  help.on((content) => broadcast(HELP_SHOWN_CHANNEL, content))

  handle(PALETTE_ANSWER_CHANNEL, parsePaletteAnswer, (answer) => prompter.answer(answer))
}

function broadcast(channel: string, payload: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(channel, payload)
  }
}
