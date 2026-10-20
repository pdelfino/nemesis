import type { BufferInfo, BufferList, BufferSpec } from '../shared/buffers'
import type { BufferType } from '../shared/keys'

/**
 * The buffer registry (#60). Nyxt and Emacs make everything a buffer, so the
 * transcript, the prompt and later a diff or a page are one kind of thing to
 * the keymap and to the palette (#65).
 *
 * The registry is plain data and holds no Electron types, so it is unit
 * testable and the window, the IPC bridge and the commands all read the same
 * list. The list is kept in creation order, which is the order `switch-buffer`
 * cycles through.
 */

const BUFFER_TYPES: readonly BufferType[] = [
  'prompt',
  'transcript',
  'permission',
  'help',
  'diff',
  'plan',
  'spec',
  'review',
  'environment',
  'agents',
  'repl',
  'page',
  'reader',
]

const MAX_TITLE = 200

export class BufferError extends Error {
  override readonly name = 'BufferError'
}

export type BufferListener = (list: BufferList) => void

export class BufferRegistry {
  private readonly buffers: BufferInfo[] = []
  private readonly listeners = new Set<BufferListener>()
  private currentId: string | null = null
  private counter = 0

  /** Opens a buffer and makes it current when nothing else is. */
  create(spec: BufferSpec): BufferInfo {
    if (!BUFFER_TYPES.includes(spec.kind)) {
      throw new BufferError(`Unknown buffer kind "${String(spec.kind)}"`)
    }
    const title = spec.title.trim()
    if (title.length === 0) throw new BufferError('A buffer needs a title')
    if (title.length > MAX_TITLE) throw new BufferError('Buffer title is too long')

    this.counter += 1
    const buffer: BufferInfo = Object.freeze({
      id: `b${this.counter}`,
      kind: spec.kind,
      title,
      elementId: spec.elementId ?? null,
    })
    this.buffers.push(buffer)
    if (this.currentId === null) this.currentId = buffer.id
    this.announce()
    return buffer
  }

  /** Every buffer, in creation order. Feeds the mode line and the palette. */
  list(): readonly BufferInfo[] {
    return [...this.buffers]
  }

  get current(): BufferInfo | null {
    return this.buffers.find((buffer) => buffer.id === this.currentId) ?? null
  }

  get(id: string): BufferInfo | undefined {
    return this.buffers.find((buffer) => buffer.id === id)
  }

  /** Makes a named buffer current. The palette (#65) switches this way. */
  switchTo(id: string): BufferInfo {
    const buffer = this.get(id)
    if (buffer === undefined) throw new BufferError(`No buffer with id "${id}"`)
    if (this.currentId !== buffer.id) {
      this.currentId = buffer.id
      this.announce()
    }
    return buffer
  }

  /**
   * Gives a buffer a new title or URL, as a page buffer's events do (#119).
   * A title past the limit is cut, not refused: it is the page's to choose.
   */
  update(
    id: string,
    patch: {
      readonly title?: string
      readonly url?: string
      readonly modes?: readonly string[]
      readonly zoom?: number
      readonly blocker?: boolean
      readonly blocked?: number
    },
  ): BufferInfo {
    const index = this.buffers.findIndex((buffer) => buffer.id === id)
    const buffer = this.buffers[index]
    if (buffer === undefined) throw new BufferError(`No buffer with id "${id}"`)
    const title = patch.title?.trim().slice(0, MAX_TITLE) || buffer.title
    const url = patch.url ?? buffer.url
    const modes = patch.modes === undefined ? buffer.modes : Object.freeze([...patch.modes])
    const zoom = patch.zoom ?? buffer.zoom
    const blocker = patch.blocker ?? buffer.blocker
    const blocked = patch.blocked ?? buffer.blocked
    const sameModes = modes?.join(' ') === buffer.modes?.join(' ')
    if (
      title === buffer.title &&
      url === buffer.url &&
      sameModes &&
      zoom === buffer.zoom &&
      blocker === buffer.blocker &&
      blocked === buffer.blocked
    ) {
      return buffer
    }
    const next: BufferInfo = Object.freeze({
      ...buffer,
      title,
      ...(url === undefined ? {} : { url }),
      ...(modes === undefined ? {} : { modes }),
      ...(zoom === undefined ? {} : { zoom }),
      ...(blocker === undefined ? {} : { blocker }),
      ...(blocked === undefined ? {} : { blocked }),
    })
    this.buffers[index] = next
    this.announce()
    return next
  }

  /**
   * Cycles to the buffer after the current one, wrapping around. This is what
   * `C-x b` does until the fuzzy chooser over titles arrives with #65.
   */
  switchToNext(): BufferInfo | null {
    if (this.buffers.length === 0) return null
    const index = this.buffers.findIndex((buffer) => buffer.id === this.currentId)
    const next = this.buffers[(index + 1) % this.buffers.length]
    if (next === undefined) return null
    return this.switchTo(next.id)
  }

  /**
   * Kills a buffer, the current one by default, and moves current to the
   * buffer that followed it, as Emacs does. Killing the last buffer leaves no
   * current buffer.
   */
  kill(id: string | null = this.currentId): BufferInfo | null {
    if (id === null) return null
    const index = this.buffers.findIndex((buffer) => buffer.id === id)
    if (index === -1) throw new BufferError(`No buffer with id "${id}"`)

    const [killed] = this.buffers.splice(index, 1)
    if (killed === undefined) return null
    if (this.currentId === killed.id) {
      const next = this.buffers[index % Math.max(this.buffers.length, 1)]
      this.currentId = next?.id ?? null
    }
    this.announce()
    return killed
  }

  snapshot(): BufferList {
    return { buffers: this.list(), currentId: this.currentId }
  }

  /** The IPC bridge subscribes, so the renderer follows the list. */
  subscribe(listener: BufferListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private announce(): void {
    const snapshot = this.snapshot()
    for (const listener of this.listeners) listener(snapshot)
  }
}

/** Validates a buffer spec that came over IPC. Shape only, no trust. */
export function parseBufferSpec(payload: unknown): BufferSpec {
  if (typeof payload !== 'object' || payload === null) {
    throw new TypeError('Buffer spec is not an object')
  }
  const value = payload as Record<string, unknown>
  const kind = value['kind']
  const title = value['title']
  const elementId = value['elementId'] ?? null
  if (typeof kind !== 'string' || !BUFFER_TYPES.includes(kind as BufferType)) {
    throw new TypeError(`Unknown buffer kind "${String(kind)}"`)
  }
  // A page buffer is a view the page buffers build under the baseline (#119);
  // a spec over IPC would name a page with no view and no policy behind it.
  if (kind === 'page') throw new TypeError('A page buffer is not opened over IPC')
  if (typeof title !== 'string' || title.trim().length === 0 || title.length > MAX_TITLE) {
    throw new TypeError('Buffer spec has no usable title')
  }
  if (elementId !== null && (typeof elementId !== 'string' || elementId.length > 64)) {
    throw new TypeError('Buffer spec has no usable element id')
  }
  return { kind: kind as BufferType, title, elementId: elementId as string | null }
}

/**
 * The buffer list the one M1 window starts with: a transcript above and the
 * prompt below, the two sections src/renderer/index.html lays out. The prompt
 * is current, because that is where typing goes.
 */
export function createCockpitBuffers(): BufferRegistry {
  const buffers = new BufferRegistry()
  buffers.create({ kind: 'transcript', title: 'Transcript', elementId: 'transcript' })
  const prompt = buffers.create({ kind: 'prompt', title: 'Prompt', elementId: 'prompt' })
  buffers.switchTo(prompt.id)
  return buffers
}
