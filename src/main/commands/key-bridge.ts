import type { WebContents } from 'electron'
import type { BufferType } from '../../shared/keys'
import { BINDINGS_CHANNEL, DISPATCH_LOG_CHANNEL, KEY_CHANNEL } from '../../shared/keys'
import { handleIn, parseNothing } from '../ipc'
import type { KeyDispatcher } from './dispatcher'
import { parseKeyPress } from './dispatcher'

/**
 * The renderer reports key presses, the main process decides what they mean
 * (#59). Every channel goes through `handleIn()`, which validates the sender
 * and the shape first (SECURITY.org, T1; #53).
 *
 * One dispatcher per window (#70): a key reaches the dispatcher of the
 * window it was pressed in.
 */
export function installKeyBridge(
  dispatcher: KeyDispatcher,
  contents: WebContents,
  modesOf?: (bufferType: BufferType | null) => readonly string[],
): KeyDispatcher {
  // The modes are read here from the window's own buffer list (#166), never
  // taken from the renderer: a press names a buffer type and nothing else.
  handleIn(contents, KEY_CHANNEL, parseKeyPress, (press) =>
    dispatcher.handle(press, modesOf?.(press.bufferType)),
  )

  // The renderer learns the shape of the keymaps, never the commands, so it
  // can leave every unbound key to the editor under it (#61).
  handleIn(contents, BINDINGS_CHANNEL, parseNothing, () => dispatcher.bindings)

  // Test-only: the end-to-end spec reads what the keys dispatched (#59).
  if (process.env['NODE_ENV'] === 'test') {
    handleIn(contents, DISPATCH_LOG_CHANNEL, parseNothing, () => dispatcher.log)
  }

  return dispatcher
}
