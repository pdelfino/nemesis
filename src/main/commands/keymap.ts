import type { BufferType, KeyPress } from '../../shared/keys'

/**
 * Emacs key notation, parsed once at load (#59).
 *
 * A chord is a sequence of strokes separated by spaces: `C-x C-s`, `M-x`,
 * `C-c C-c`. A stroke is zero or more modifier prefixes followed by a key:
 * `C-` control, `M-` meta (Alt/Option), `S-` shift, `s-` super (Command).
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
const NAMED_KEYS = new Map<string, string>([
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

const MODIFIER_PREFIXES = [
  { prefix: 'C-', field: 'control' },
  { prefix: 'M-', field: 'meta' },
  { prefix: 'S-', field: 'shift' },
  { prefix: 's-', field: 'super' },
] as const

export class KeymapError extends Error {
  override readonly name = 'KeymapError'
}

/** Canonical name of a named key, or undefined when the token is not one. */
function namedKey(token: string): string | undefined {
  for (const candidate of [token, token.toUpperCase(), token.toLowerCase()]) {
    if (NAMED_KEYS.has(candidate)) return candidate
  }
  return undefined
}

/** Parses one stroke, for example `C-x` or `M-S-<up>`. */
export function parseStroke(token: string): KeyStroke {
  let rest = token
  const modifiers = { control: false, meta: false, shift: false, super: false }
  let matched = true
  while (matched && rest.length > 2) {
    matched = false
    for (const { prefix, field } of MODIFIER_PREFIXES) {
      if (!rest.startsWith(prefix)) continue
      if (modifiers[field]) throw new KeymapError(`Repeated modifier ${prefix} in "${token}"`)
      modifiers[field] = true
      rest = rest.slice(prefix.length)
      matched = true
      break
    }
  }

  const named = namedKey(rest)
  if (named !== undefined) return { key: named, ...modifiers }
  if (Array.from(rest).length !== 1) throw new KeymapError(`Unknown key "${rest}" in "${token}"`)
  if (modifiers.shift) {
    throw new KeymapError(
      `S- needs a named key, not "${rest}" in "${token}" (write the shifted character)`,
    )
  }
  return { key: rest, ...modifiers }
}

/** Parses a whole chord: strokes separated by whitespace. */
export function parseChord(chord: string): KeyStroke[] {
  const tokens = chord.split(/\s+/).filter((token) => token.length > 0)
  if (tokens.length === 0) throw new KeymapError('Empty chord')
  return tokens.map(parseStroke)
}

export function formatStroke(stroke: KeyStroke): string {
  return [
    stroke.control ? 'C-' : '',
    stroke.meta ? 'M-' : '',
    stroke.shift ? 'S-' : '',
    stroke.super ? 's-' : '',
    stroke.key,
  ].join('')
}

export function formatChord(strokes: readonly KeyStroke[]): string {
  return strokes.map(formatStroke).join(' ')
}

/** Parses and reprints a chord, so two spellings of the same chord compare equal. */
export function normalizeChord(chord: string): string {
  return formatChord(parseChord(chord))
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

export interface KeymapEntry {
  readonly chord: string
  readonly command: string
}

/** Chord in Emacs notation to command name. */
export type KeymapSpec = Readonly<Record<string, string>>

export type Lookup =
  | { readonly kind: 'command'; readonly command: string }
  | { readonly kind: 'prefix' }
  | { readonly kind: 'none' }

interface TrieNode {
  command?: string
  readonly children: Map<string, TrieNode>
}

/**
 * A set of bindings, stored as a trie over strokes so that `C-x` is a prefix
 * and `C-x b` is a binding. Conflicts are rejected when the map is built, not
 * discovered when a key is pressed.
 */
export class Keymap {
  readonly name: string
  private readonly root: TrieNode = { children: new Map() }
  private readonly bindings = new Map<string, string>()

  constructor(name: string, spec: KeymapSpec) {
    this.name = name
    for (const [chord, command] of Object.entries(spec)) this.bind(chord, command)
  }

  private bind(chord: string, command: string): void {
    const path = parseChord(chord).map(formatStroke)
    const canonical = path.join(' ')
    const existing = this.bindings.get(canonical)
    if (existing !== undefined) {
      throw new KeymapError(
        `Keymap "${this.name}": ${canonical} is already bound to ${existing}, cannot bind ${command}`,
      )
    }

    let node = this.root
    for (const [index, stroke] of path.entries()) {
      if (node.command !== undefined) {
        throw new KeymapError(
          `Keymap "${this.name}": ${path.slice(0, index).join(' ')} is bound to ${node.command}, so ${canonical} can never run`,
        )
      }
      let child = node.children.get(stroke)
      if (child === undefined) {
        child = { children: new Map() }
        node.children.set(stroke, child)
      }
      node = child
    }
    if (node.children.size > 0) {
      throw new KeymapError(
        `Keymap "${this.name}": ${canonical} is a prefix of a longer binding, cannot bind ${command}`,
      )
    }
    node.command = command
    this.bindings.set(canonical, command)
  }

  /** Looks a stroke path up: a command, a prefix of one, or nothing. */
  lookup(path: readonly string[]): Lookup {
    let node = this.root
    for (const stroke of path) {
      const child = node.children.get(stroke)
      if (child === undefined) return { kind: 'none' }
      node = child
    }
    if (node.command !== undefined) return { kind: 'command', command: node.command }
    return node.children.size > 0 ? { kind: 'prefix' } : { kind: 'none' }
  }

  commandFor(chord: string): string | undefined {
    return this.bindings.get(normalizeChord(chord))
  }

  /** Every binding, sorted by chord. Feeds describe-bindings and the palette. */
  entries(): KeymapEntry[] {
    return Array.from(this.bindings, ([chord, command]) => ({ chord, command })).sort((a, b) =>
      a.chord.localeCompare(b.chord),
    )
  }
}

export function defineKeymap(name: string, spec: KeymapSpec): Keymap {
  return new Keymap(name, spec)
}

export type BufferKeymaps = Readonly<Partial<Record<BufferType, Keymap>>>

export interface KeyResolverOptions {
  readonly global: Keymap
  readonly byBufferType?: BufferKeymaps
  /** Stroke that abandons a half-typed sequence, as `C-g` does in Emacs. */
  readonly abort?: string
}

export type Resolution =
  | { readonly kind: 'command'; readonly command: string; readonly chord: string }
  | { readonly kind: 'pending'; readonly chord: string }
  | { readonly kind: 'unbound'; readonly chord: string }

/**
 * Turns strokes into commands, holding the half-typed sequence between them.
 *
 * Layers are consulted in order, the buffer-type map before the global map, and
 * the first layer that knows the sequence decides. A prefix in a higher layer
 * wins over a command in a lower one (as in Emacs, `C-x` stays a prefix), and
 * the lower layer can still complete the sequence on a later stroke, so a
 * buffer map that binds `C-c C-c` does not hide a global `C-c C-k`.
 */
export class KeyResolver {
  private readonly global: Keymap
  private readonly byBufferType: BufferKeymaps
  private readonly abortStroke: string | undefined
  private path: string[] = []
  private layers: Keymap[] = []

  constructor(options: KeyResolverOptions) {
    this.global = options.global
    this.byBufferType = options.byBufferType ?? {}
    this.abortStroke = options.abort === undefined ? undefined : normalizeChord(options.abort)
  }

  /** The sequence typed so far, or null when no sequence is in flight. */
  get pending(): string | null {
    return this.path.length > 0 ? this.path.join(' ') : null
  }

  reset(): void {
    this.path = []
    this.layers = []
  }

  resolve(stroke: KeyStroke, bufferType: BufferType | null = null): Resolution {
    const token = formatStroke(stroke)
    // C-g abandons the sequence, then is looked up on its own.
    if (this.path.length > 0 && token === this.abortStroke) this.reset()
    if (this.path.length === 0) this.layers = this.layersFor(bufferType)
    this.path.push(token)

    for (const layer of this.layers) {
      const hit = layer.lookup(this.path)
      if (hit.kind === 'command') {
        const chord = this.path.join(' ')
        this.reset()
        return { kind: 'command', command: hit.command, chord }
      }
      if (hit.kind === 'prefix') return { kind: 'pending', chord: this.path.join(' ') }
    }

    const chord = this.path.join(' ')
    this.reset()
    return { kind: 'unbound', chord }
  }

  private layersFor(bufferType: BufferType | null): Keymap[] {
    const buffer = bufferType === null ? undefined : this.byBufferType[bufferType]
    return buffer === undefined ? [this.global] : [buffer, this.global]
  }
}
