import type { BufferType, DispatchRecord, KeyOutcome, KeyPress } from '../../shared/keys'
import type { Keymap, KeyResolver } from './keymap'
import { strokeFromKeyPress } from './keymap'
import type { CommandRegistry } from './registry'

/**
 * The key to command path (#59): the renderer reports a key press, the main
 * process resolves it against the keymaps and runs the command.
 */

const BUFFER_TYPES: readonly BufferType[] = ['prompt', 'transcript', 'permission']

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

export interface SenderFrame {
  readonly url: string
  readonly parent: unknown
}

/**
 * SECURITY.org: an IPC handler validates the sender before doing anything.
 * Only the top frame of an internal page may drive the keymap. Internal pages
 * are served from file:// until #50 moves them to nemesis://; the Vite dev
 * server counts only when electron-vite set ELECTRON_RENDERER_URL.
 */
export function isInternalSender(
  frame: SenderFrame | null | undefined,
  devServerUrl?: string,
): boolean {
  if (frame === null || frame === undefined) return false
  if (frame.parent !== null) return false
  if (devServerUrl !== undefined && devServerUrl.length > 0 && frame.url.startsWith(devServerUrl)) {
    return true
  }
  return frame.url.startsWith('file://') && frame.url.endsWith('/renderer/index.html')
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

export class KeyDispatcher {
  private readonly records: DispatchRecord[] = []

  constructor(
    private readonly registry: CommandRegistry,
    private readonly resolver: KeyResolver,
  ) {}

  /** The sequence typed so far, or null. */
  get pending(): string | null {
    return this.resolver.pending
  }

  /** Dispatched commands, oldest first. Chords and names only, never buffer text. */
  get log(): readonly DispatchRecord[] {
    return [...this.records]
  }

  async handle(press: KeyPress): Promise<KeyOutcome> {
    const stroke = strokeFromKeyPress(press)
    if (stroke === null) return { status: 'ignored', chord: this.resolver.pending ?? '' }

    const resolution = this.resolver.resolve(stroke, press.bufferType)
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
    return { status: 'command', chord, command }
  }

  private record(entry: DispatchRecord): void {
    this.records.push(entry)
    if (this.records.length > LOG_LIMIT) this.records.shift()
  }
}
