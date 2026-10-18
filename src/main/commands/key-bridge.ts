import { BINDINGS_CHANNEL, DISPATCH_LOG_CHANNEL, KEY_CHANNEL } from '../../shared/keys'
import { handle, parseNothing } from '../ipc'
import type { KeyDispatcher } from './dispatcher'
import { parseKeyPress } from './dispatcher'
import { createCockpitDispatcher } from './keyscheme'

/**
 * The renderer reports key presses, the main process decides what they mean
 * (#59). Every channel goes through `handle()`, which validates the sender
 * and the shape first (SECURITY.org, T1; #53).
 *
 * One dispatcher for the one window M1 has; a dispatcher per window arrives
 * with the second window.
 */
export function installKeyBridge(
  dispatcher: KeyDispatcher = createCockpitDispatcher(),
): KeyDispatcher {
  handle(KEY_CHANNEL, parseKeyPress, (press) => dispatcher.handle(press))

  // The renderer learns the shape of the keymaps, never the commands, so it
  // can leave every unbound key to the editor under it (#61).
  handle(BINDINGS_CHANNEL, parseNothing, () => dispatcher.bindings)

  // Test-only: the end-to-end spec reads what the keys dispatched (#59).
  if (process.env['NODE_ENV'] === 'test') {
    handle(DISPATCH_LOG_CHANNEL, parseNothing, () => dispatcher.log)
  }

  return dispatcher
}
