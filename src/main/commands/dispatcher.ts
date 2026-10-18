import type {
  BufferType,
  DispatchRecord,
  KeyBindings,
  KeyOutcome,
  KeyPress,
} from '../../shared/keys'
import type { Keymap, KeyResolver } from './keymap'
import { strokeFromKeyPress } from './keymap'
import type { CommandRegistry } from './registry'

/**
 * The key to command path (#59): the renderer reports a key press, the main
 * process resolves it against the keymaps and runs the command.
 */

const BUFFER_TYPES: readonly BufferType[] = [
  'prompt',
  'transcript',
  'permission',
  'help',
  'diff',
  'plan',
  'spec',
]

/** How many dispatches are kept in memory for describe and for the tests. */
const LOG_LIMIT = 200

/** Validates an IPC payload from the renderer. Shape only, no trust. */
export function parseKeyPress(payload: unknown): KeyPress {
  if (typeof payload !== 'object' || payload === null)
    throw new TypeError('Key press is not an object')
  const value = payload as Record<string, unknown>
  const key = value['key']
  const code = value['code']
  const bufferType = value['bufferType'] ?? null
  if (typeof key !== 'string' || key.length === 0 || key.length > 32) {
    throw new TypeError('Key press has no usable key')
  }
  if (typeof code !== 'string' || code.length > 32)
    throw new TypeError('Key press has no usable code')
  if (bufferType !== null && !BUFFER_TYPES.includes(bufferType as BufferType)) {
    throw new TypeError(`Unknown buffer type "${String(bufferType)}"`)
  }
  return {
    key,
    code,
    ctrlKey: value['ctrlKey'] === true,
    altKey: value['altKey'] === true,
    shiftKey: value['shiftKey'] === true,
    metaKey: value['metaKey'] === true,
    bufferType: bufferType as BufferType | null,
  }
}

/** Fails at startup, not on a keypress, when a binding names an unknown command. */
export function assertBindingsAreRegistered(
  registry: CommandRegistry,
  keymaps: readonly Keymap[],
): void {
  for (const keymap of keymaps) {
    for (const { chord, command } of keymap.entries()) {
      if (!registry.has(command)) {
        throw new Error(`Keymap "${keymap.name}" binds ${chord} to unknown command "${command}"`)
      }
    }
  }
}

/** A key sequence read for `describe-key` (#65): what it was and what it would have run. */
export interface KeyReading {
  readonly chord: string
  /** Null when the sequence is unbound in that buffer. */
  readonly command: string | null
  readonly bufferType: BufferType | null
}

/**
 * Reads the next complete key sequence instead of running it (#65). The
 * `describe-key` command asks here, and the dispatcher, which is built after
 * the registry, consults the same reader on every press.
 */
export class KeyReader {
  private waiting: ((reading: KeyReading) => void) | null = null

  get pending(): boolean {
    return this.waiting !== null
  }

  /** Resolves with the next sequence. A second read while one waits replaces it. */
  read(): Promise<KeyReading> {
    return new Promise((resolve) => {
      this.waiting = resolve
    })
  }

  settle(reading: KeyReading): void {
    const waiting = this.waiting
    this.waiting = null
    waiting?.(reading)
  }
}

export class KeyDispatcher {
  private readonly records: DispatchRecord[] = []

  constructor(
    readonly registry: CommandRegistry,
    private readonly resolver: KeyResolver,
    private readonly reader: KeyReader = new KeyReader(),
  ) {}

  /** The sequence typed so far, or null. */
  get pending(): string | null {
    return this.resolver.pending
  }

  /** Dispatched commands, oldest first. Chords and names only, never buffer text. */
  get log(): readonly DispatchRecord[] {
    return [...this.records]
  }

  /** The shape of the keymaps, so the renderer knows which keys are the cockpit's (#61). */
  get bindings(): KeyBindings {
    return this.resolver.bindings()
  }

  async handle(press: KeyPress): Promise<KeyOutcome> {
    const stroke = strokeFromKeyPress(press)
    if (stroke === null) return { status: 'ignored', chord: this.resolver.pending ?? '' }

    const resolution = this.resolver.resolve(stroke, press.bufferType)
    if (resolution.kind === 'pending') return { status: 'pending', chord: resolution.chord }

    // A sequence read for describe-key is described, not run (#65).
    if (this.reader.pending) {
      const command = resolution.kind === 'command' ? resolution.command : null
      this.reader.settle({ chord: resolution.chord, command, bufferType: press.bufferType })
      return {
        status: 'captured',
        chord: resolution.chord,
        ...(command === null ? {} : { command }),
      }
    }
    if (resolution.kind !== 'command') {
      return { status: resolution.kind, chord: resolution.chord }
    }

    const { command, chord } = resolution
    this.record({ at: Date.now(), chord, command, bufferType: press.bufferType })
    try {
      await this.registry.run(command, { source: 'key', chord, bufferType: press.bufferType })
    } catch (error) {
      // The name and the chord are safe to print; nothing from a buffer is.
      console.error(`Command ${command} (${chord}) failed:`, error)
      return { status: 'error', chord, command }
    }
    return { status: 'command', chord, command, ...(this.reader.pending ? { capture: true } : {}) }
  }

  private record(entry: DispatchRecord): void {
    this.records.push(entry)
    if (this.records.length > LOG_LIMIT) this.records.shift()
  }
}
