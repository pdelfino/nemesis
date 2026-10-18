import { PermissionBridge } from '../agent/permission-bridge'
import type { BufferRegistry } from '../buffers'
import { createCockpitBuffers } from '../buffers'
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
 * A command body stays empty until the surface it drives lands. #59 owns the
 * spine, the registry, the chord parser and the dispatch; the two buffer
 * commands act on the buffer registry they are given (#60), and the answer
 * commands on the permission bridge (#63).
 */

/** How many options a question may offer, per the AskUserQuestion schema. */
const QUESTION_OPTIONS = [1, 2, 3, 4] as const

export function cockpitCommands(
  buffers: BufferRegistry,
  permissions: PermissionBridge,
): readonly Command[] {
  return [
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
        // The text lives in the renderer. When the dispatch answers with this
        // name, the prompt buffer sends its text through the prompt bridge and
        // the queue in src/main/agent/session-bridge.ts takes it from there
        // (#61). Running it from the palette (#65) takes the same path.
      },
    }),
    defineCommand({
      name: 'switch-buffer',
      doc: 'Switch to another buffer by name.',
      run: () => {
        // Cycles to the next buffer; the fuzzy chooser over titles is #65.
        buffers.switchToNext()
      },
    }),
    defineCommand({
      name: 'kill-buffer',
      doc: 'Kill the current buffer.',
      run: () => {
        buffers.kill()
      },
    }),
    defineCommand({
      name: 'search-buffer',
      doc: 'Search in the current buffer.',
      run: () => {
        // Search is a CodeMirror surface: when the dispatch answers with this
        // name, the transcript buffer opens its search panel, or steps to the
        // next match when the panel is already open (#62).
      },
    }),
    defineCommand({
      name: 'answer-yes',
      doc: 'Allow the pending tool once.',
      run: () => {
        permissions.allowOnce()
      },
    }),
    defineCommand({
      name: 'answer-no',
      doc: 'Deny the pending tool, or decline the pending question.',
      run: () => {
        permissions.deny()
      },
    }),
    defineCommand({
      name: 'allow-for-session',
      doc: 'Allow the pending tool now and for the rest of the session.',
      run: () => {
        permissions.allowForSession()
      },
    }),
    ...QUESTION_OPTIONS.map((number) =>
      defineCommand({
        name: `choose-option-${number}`,
        doc: `Choose option ${number} of the pending question.`,
        run: () => {
          permissions.choose(number)
        },
      }),
    ),
  ]
}

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
    a: 'allow-for-session',
    ...Object.fromEntries(
      QUESTION_OPTIONS.map((number) => [`${number}`, `choose-option-${number}`]),
    ),
  }),
}

/** The chord that abandons a half-typed sequence. */
export const ABORT_CHORD = 'C-g'

export function createCockpitRegistry(
  buffers: BufferRegistry = createCockpitBuffers(),
  permissions: PermissionBridge = new PermissionBridge(buffers),
): CommandRegistry {
  const registry = new CommandRegistry()
  registry.registerAll(cockpitCommands(buffers, permissions))
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
