/**
 * The key and command vocabulary shared by the main process and the renderer
 * (#59). The renderer only reports key presses; the main process owns the
 * registry, the keymaps and the dispatch, so there is one source of truth for
 * what a chord means.
 *
 * The stroke notation lives here too (#61): the renderer must spell a key the
 * way the keymaps do, so it can tell a cockpit chord from an editor key before
 * the main process answers. It learns the shape of the keymaps, never the
 * commands.
 */

/** Buffer types the cockpit knows about. Per-type keymaps override the global map. */
export type BufferType = 'prompt' | 'transcript' | 'permission'

/**
 * Buffer types where an unmodified key is a command, not text (`y`/`n` on a
 * permission prompt). Everywhere else the renderer keeps plain typing local and
 * only reports chords, so typed text never crosses the bridge.
 */
export const MODAL_BUFFER_TYPES: readonly BufferType[] = ['permission']

/** One key press, as the renderer saw it. `code` is the layout-independent fallback. */
export interface KeyPress {
  readonly key: string
  readonly code: string
  readonly ctrlKey: boolean
  readonly altKey: boolean
  readonly shiftKey: boolean
  readonly metaKey: boolean
  readonly bufferType: BufferType | null
}

/**
 * What the main process did with a key press. `chord` is the sequence so far in
 * Emacs notation, which the echo area will show once the mode line lands.
 */
export interface KeyOutcome {
  readonly status: 'command' | 'pending' | 'unbound' | 'ignored' | 'error'
  readonly chord: string
  readonly command?: string
}

/** One dispatched command. Never holds buffer text, only the chord and the name. */
export interface DispatchRecord {
  readonly at: number
  readonly chord: string
  readonly command: string
  readonly bufferType: BufferType | null
}

export const KEY_CHANNEL = 'nemesis:key' as const
/** Test-only channel: the main process registers it when NODE_ENV=test. */
export const DISPATCH_LOG_CHANNEL = 'nemesis:dispatch-log' as const
/** The renderer asks once at load which chords are the cockpit's (#61). */
export const BINDINGS_CHANNEL = 'nemesis:bindings' as const

/**
 * One stroke in Emacs notation: zero or more modifiers and a key. `C-` is
 * control, `M-` meta (Alt/Option), `S-` shift, `s-` super (Command).
 *
 * Shift is a modifier only on named keys (`S-TAB`, `S-<up>`). On a printable
 * character the character itself carries it, as in Emacs: `A`, never `S-a`.
 */
export interface KeyStroke {
  /** `x`, `A`, or a named key: `RET`, `SPC`, `TAB`, `ESC`, `DEL`, `<up>`, `<f1>`. */
  readonly key: string
  readonly control: boolean
  readonly meta: boolean
  readonly shift: boolean
  readonly super: boolean
}

/** Emacs name to DOM `KeyboardEvent.key`. */
export const NAMED_KEYS: ReadonlyMap<string, string> = new Map<string, string>([
  ['RET', 'Enter'],
  ['SPC', ' '],
  ['TAB', 'Tab'],
  ['ESC', 'Escape'],
  ['DEL', 'Backspace'],
  ['<up>', 'ArrowUp'],
  ['<down>', 'ArrowDown'],
  ['<left>', 'ArrowLeft'],
  ['<right>', 'ArrowRight'],
  ['<home>', 'Home'],
  ['<end>', 'End'],
  ['<prior>', 'PageUp'],
  ['<next>', 'PageDown'],
  ['<delete>', 'Delete'],
  ['<insert>', 'Insert'],
  ...Array.from({ length: 12 }, (_unused, index): [string, string] => [
    `<f${index + 1}>`,
    `F${index + 1}`,
  ]),
])

/** DOM `KeyboardEvent.key` to Emacs name. */
const DOM_KEYS = new Map(Array.from(NAMED_KEYS, ([name, dom]) => [dom, name]))

/** Keys that are only a modifier; they never start or finish a stroke. */
const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'AltGraph'])

export function formatStroke(stroke: KeyStroke): string {
  return [
    stroke.control ? 'C-' : '',
    stroke.meta ? 'M-' : '',
    stroke.shift ? 'S-' : '',
    stroke.super ? 's-' : '',
    stroke.key,
  ].join('')
}

/**
 * The stroke a key press stands for, or null for a bare modifier key.
 *
 * On macOS, Option plus a letter produces a different character (Option-x is
 * `≈`), so when meta or super is down the layout-independent `code` decides.
 */
export function strokeFromKeyPress(press: KeyPress): KeyStroke | null {
  if (MODIFIER_KEYS.has(press.key)) return null

  const named = DOM_KEYS.get(press.key)
  if (named !== undefined) {
    return {
      key: named,
      control: press.ctrlKey,
      meta: press.altKey,
      shift: press.shiftKey,
      super: press.metaKey,
    }
  }

  const key = printableKey(press)
  if (key === null) return null
  // A printable character already carries its shift, as in Emacs.
  return { key, control: press.ctrlKey, meta: press.altKey, shift: false, super: press.metaKey }
}

function printableKey(press: KeyPress): string | null {
  const altered = press.altKey || press.metaKey
  if (!altered && Array.from(press.key).length === 1) return press.key

  const letter = /^Key([A-Z])$/.exec(press.code)
  if (letter?.[1] !== undefined) {
    return press.shiftKey ? letter[1] : letter[1].toLowerCase()
  }
  const digit = /^Digit(\d)$/.exec(press.code)
  if (digit?.[1] !== undefined && !press.shiftKey) return digit[1]

  return Array.from(press.key).length === 1 ? press.key : null
}

/**
 * The shape of one keymap (#61): its chords in canonical notation and every
 * proper prefix of a multi-stroke chord (`C-x` for `C-x b`). No command names:
 * the renderer decides which keys to hand over, never what they do.
 */
export interface KeymapShape {
  readonly chords: readonly string[]
  readonly prefixes: readonly string[]
}

/** The shape of every keymap layer, published to the renderer at load. */
export interface KeyBindings {
  readonly global: KeymapShape
  readonly byBufferType: Readonly<Partial<Record<BufferType, KeymapShape>>>
}

/**
 * Whether a stroke, typed first, is the cockpit's to handle in a buffer of
 * this type. Mirrors the resolver's layering: the buffer-type map and the
 * global map both count, and a prefix counts as much as a whole chord, since
 * the main process decides how the sequence ends.
 */
export function startsCockpitChord(
  token: string,
  bindings: KeyBindings,
  bufferType: BufferType | null,
): boolean {
  const buffer = bufferType === null ? undefined : bindings.byBufferType[bufferType]
  for (const layer of [buffer, bindings.global]) {
    if (layer === undefined) continue
    if (layer.chords.includes(token) || layer.prefixes.includes(token)) return true
  }
  return false
}
