import type { BufferType, KeyBindings, KeymapShape, KeyStroke } from '../../shared/keys'
import { formatStroke, NAMED_KEYS, strokeFromKeyPress } from '../../shared/keys'
import type { ModeRegistry } from './modes'

/**
 * Emacs key notation, parsed once at load (#59).
 *
 * A chord is a sequence of strokes separated by spaces: `C-x C-s`, `M-x`,
 * `C-c C-c`. A stroke is zero or more modifier prefixes followed by a key:
 * `C-` control, `M-` meta (Alt/Option), `S-` shift, `s-` super (Command).
 *
 * The stroke itself (its shape, its printing and its reading off a key press)
 * is defined in src/shared/keys.ts since #61, because the renderer spells keys
 * the same way to know which ones to hand over. This module keeps the chord
 * parser, the keymaps and the resolver, which stay in the main process.
 */

export type { KeyStroke }
export { formatStroke, strokeFromKeyPress }

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

export function formatChord(strokes: readonly KeyStroke[]): string {
  return strokes.map(formatStroke).join(' ')
}

/** Parses and reprints a chord, so two spellings of the same chord compare equal. */
export function normalizeChord(chord: string): string {
  return formatChord(parseChord(chord))
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

  /**
   * The chords and their proper prefixes, without the command names: what the
   * renderer needs to know which keys are the cockpit's (#61).
   */
  shape(): KeymapShape {
    const chords = this.entries().map((entry) => entry.chord)
    const prefixes = new Set<string>()
    for (const chord of chords) {
      const strokes = chord.split(' ')
      for (let length = 1; length < strokes.length; length += 1) {
        prefixes.add(strokes.slice(0, length).join(' '))
      }
    }
    return { chords, prefixes: [...prefixes].sort((a, b) => a.localeCompare(b)) }
  }
}

export function defineKeymap(name: string, spec: KeymapSpec): Keymap {
  return new Keymap(name, spec)
}

export type BufferKeymaps = Readonly<Partial<Record<BufferType, Keymap>>>

/**
 * The keymap layer of a mode a buffer is in (ADR 0004; `document` and
 * `passthrough` on a page buffer since #120). A sealed mode is the last layer
 * looked in: nothing under it, the buffer type's map and the global map
 * included, sees a key while it is on, so an unbound key is the page's.
 */
export interface ModeLayer {
  readonly keymap: Keymap
  readonly sealed?: boolean
}

export type ModeKeymaps = Readonly<Record<string, ModeLayer>>

export interface KeyResolverOptions {
  /** The `base` mode's layer, under every buffer (#166). */
  readonly global: Keymap
  readonly byBufferType?: BufferKeymaps
  /** The page buffer's mode layers by name (#120); a buffer's modes are consulted first, in their order. */
  readonly modes?: ModeKeymaps
  /**
   * The registered modes (#166, ADR 0004): a buffer's mode that is not a
   * page mode is looked up here, and a press that names no modes is in its
   * kind's defaults.
   */
  readonly registry?: ModeRegistry
  /**
   * The user's layer from the config file (#71, ADR 0006), read on every
   * sequence so a reload takes effect on the next key. It sits above the
   * global map and below the buffer-type maps.
   */
  readonly user?: () => Keymap | null
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
  private readonly modes: ModeKeymaps
  private readonly registry: ModeRegistry | null
  private readonly user: () => Keymap | null
  private readonly abortStroke: string | undefined
  private path: string[] = []
  private layers: Keymap[] = []

  constructor(options: KeyResolverOptions) {
    this.global = options.global
    this.byBufferType = options.byBufferType ?? {}
    this.modes = options.modes ?? {}
    this.registry = options.registry ?? null
    this.user = options.user ?? (() => null)
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

  /** The shape of every layer, published to the renderer at load (#61). */
  bindings(): KeyBindings {
    const byBufferType: Partial<Record<BufferType, KeymapShape>> = {}
    for (const [type, keymap] of Object.entries(this.byBufferType) as [BufferType, Keymap][]) {
      byBufferType[type] = keymap.shape()
    }
    const user = this.user()
    return {
      global: mergeShapes(this.global.shape(), user?.shape()),
      byBufferType,
      byMode: this.registry?.shapes() ?? {},
    }
  }

  /**
   * `modes` are the buffer's, first wins; undefined means the kind's
   * defaults, for a caller that knows the type and not the buffer.
   */
  resolve(
    stroke: KeyStroke,
    bufferType: BufferType | null = null,
    modes?: readonly string[],
  ): Resolution {
    const token = formatStroke(stroke)
    // C-g abandons the sequence, then is looked up on its own.
    if (this.path.length > 0 && token === this.abortStroke) this.reset()
    if (this.path.length === 0) this.layers = this.layersFor(bufferType, modes)
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

  private layersFor(bufferType: BufferType | null, given?: readonly string[]): Keymap[] {
    const modes =
      given ?? (bufferType === null ? [] : (this.registry?.defaultsFor(bufferType) ?? []))
    const layers: Keymap[] = []
    for (const name of modes) {
      const mode = this.modes[name]
      if (mode === undefined) {
        const layer = this.registry?.get(name)?.layer
        if (layer !== undefined && layer !== null) layers.push(layer)
        continue
      }
      layers.push(mode.keymap)
      if (mode.sealed === true) return layers
    }
    const buffer = bufferType === null ? undefined : this.byBufferType[bufferType]
    const user = this.user()
    return [
      ...layers,
      ...(buffer === undefined ? [] : [buffer]),
      ...(user === null ? [] : [user]),
      this.global,
    ]
  }
}

/** The renderer sees the user layer as part of the global one: it only asks which keys are the cockpit's. */
function mergeShapes(global: KeymapShape, user: KeymapShape | undefined): KeymapShape {
  if (user === undefined) return global
  const sorted = (items: readonly string[]): string[] =>
    [...new Set(items)].sort((a, b) => a.localeCompare(b))
  return {
    chords: sorted([...global.chords, ...user.chords]),
    prefixes: sorted([...global.prefixes, ...user.prefixes]),
  }
}

/**
 * True when `chord` in a lower layer can never run because `upper` takes the
 * sequence first: a command on the chord or on a prefix of it, or a prefix
 * on the chord itself. describe and the menu leave such a binding out.
 */
export function isShadowed(upper: Keymap, chord: string): boolean {
  const path = parseChord(chord).map(formatStroke)
  for (let length = 1; length <= path.length; length += 1) {
    const hit = upper.lookup(path.slice(0, length))
    if (hit.kind === 'command') return true
    if (hit.kind === 'prefix' && length === path.length) return true
  }
  return false
}
