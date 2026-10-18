import type { BufferInfo } from '../shared/buffers'
import type { HelpContent } from '../shared/palette'
import type { BufferRegistry } from './buffers'

/**
 * The help buffer (#65): where describe-command and describe-key answer. One
 * `help` buffer in the registry, created on the first answer and reused by
 * the next, as the *Help* buffer is in Emacs; it is killed like any other
 * buffer and comes back on the next question. The text is pushed to the
 * window, which shows it in a read-only document; the main process never
 * keeps it beyond the push and never logs it.
 */

/** The renderer element the help buffer shows in (src/renderer/index.html). */
export const HELP_ELEMENT_ID = 'help'

export const HELP_TITLE = 'Help'

export type HelpListener = (content: HelpContent) => void

export class HelpBuffers {
  private readonly buffers: BufferRegistry
  private readonly listeners = new Set<HelpListener>()
  private bufferId: string | null = null

  constructor(buffers: BufferRegistry) {
    this.buffers = buffers
    buffers.subscribe((list) => {
      if (this.bufferId !== null && !list.buffers.some((buffer) => buffer.id === this.bufferId)) {
        this.bufferId = null
      }
    })
  }

  /** The bridge subscribes and pushes the text to the window. */
  on(listener: HelpListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** The help buffer, when one is open. */
  get buffer(): BufferInfo | null {
    return this.bufferId === null ? null : (this.buffers.get(this.bufferId) ?? null)
  }

  /** Shows `text` in the help buffer and gives it the point. */
  show(text: string): BufferInfo {
    const buffer =
      this.buffer ??
      this.buffers.create({ kind: 'help', title: HELP_TITLE, elementId: HELP_ELEMENT_ID })
    this.bufferId = buffer.id
    // The window gets the text before the point moves to it.
    for (const listener of [...this.listeners]) listener({ bufferId: buffer.id, text })
    this.buffers.switchTo(buffer.id)
    return buffer
  }
}
