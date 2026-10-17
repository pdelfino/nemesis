import type { BufferKeymaps } from './keymap'
import { defineKeymap, KeyResolver } from './keymap'
import { assertBindingsAreRegistered, KeyDispatcher } from './dispatcher'
import type { Command } from './registry'
import { CommandRegistry, defineCommand } from './registry'

/**
 * The default Emacs keyscheme for the cockpit (#59).
 *
 * Keymaps are data in a TypeScript module (option A on the issue): the user
 * config dir gets the same shape when the extension door opens in M3, so the
 * format is decided once, here, before the first binding.
 *
 * The command bodies are deliberately empty for now. This issue owns the spine,
 * the registry, the chord parser and the dispatch; each buffer fills its own
 * command in when it lands.
 */

export const COCKPIT_COMMANDS: readonly Command[] = [
  defineCommand({
    name: 'execute-command',
    doc: 'Run a command by name.',
    run: () => {
      // The palette UI lands in #65; the dispatch is what M1 needs now.
    },
  }),
  defineCommand({
    name: 'keyboard-quit',
    doc: 'Cancel the half-typed key sequence, the prompt or the running request.',
    run: () => {
      // The resolver already dropped the pending sequence; interrupting the
      // agent request arrives with the session manager.
    },
  }),
  defineCommand({
    name: 'send-prompt',
    doc: 'Send the prompt buffer to the agent.',
    run: () => {
      // The prompt buffer lands in #61.
    },
  }),
  defineCommand({
    name: 'switch-buffer',
    doc: 'Switch to another buffer by name.',
    run: () => {
      // The buffer list lands with the cockpit buffers.
    },
  }),
  defineCommand({
    name: 'kill-buffer',
    doc: 'Kill the current buffer.',
    run: () => {
      // The buffer list lands with the cockpit buffers.
    },
  }),
  defineCommand({
    name: 'search-buffer',
    doc: 'Search in the current buffer.',
    run: () => {
      // Search is a CodeMirror surface; it lands with the transcript (#62).
    },
  }),
  defineCommand({
    name: 'answer-yes',
    doc: 'Answer yes to the permission prompt.',
    run: () => {
      // The permission bridge answers; it lands with the permission prompt.
    },
  }),
  defineCommand({
    name: 'answer-no',
    doc: 'Answer no to the permission prompt.',
    run: () => {
      // The permission bridge answers; it lands with the permission prompt.
    },
  }),
]

/** Bindings available in every buffer. */
export const GLOBAL_KEYMAP = defineKeymap('global', {
  'M-x': 'execute-command',
  'C-g': 'keyboard-quit',
  'C-c C-c': 'send-prompt',
  'C-x b': 'switch-buffer',
  'C-x k': 'kill-buffer',
  'C-s': 'search-buffer',
})

/** Per-buffer-type bindings. They are consulted before the global map. */
export const BUFFER_KEYMAPS: BufferKeymaps = {
  // A permission prompt is modal: an unmodified key is an answer, not text.
  permission: defineKeymap('permission', {
    y: 'answer-yes',
    n: 'answer-no',
  }),
}

/** The chord that abandons a half-typed sequence. */
export const ABORT_CHORD = 'C-g'

export function createCockpitRegistry(): CommandRegistry {
  const registry = new CommandRegistry()
  registry.registerAll(COCKPIT_COMMANDS)
  return registry
}

export function createCockpitResolver(): KeyResolver {
  return new KeyResolver({
    global: GLOBAL_KEYMAP,
    byBufferType: BUFFER_KEYMAPS,
    abort: ABORT_CHORD,
  })
}

/** The dispatcher the window drives. Throws here, at startup, on a stale binding. */
export function createCockpitDispatcher(registry = createCockpitRegistry()): KeyDispatcher {
  assertBindingsAreRegistered(registry, [GLOBAL_KEYMAP, ...Object.values(BUFFER_KEYMAPS)])
  return new KeyDispatcher(registry, createCockpitResolver())
}
