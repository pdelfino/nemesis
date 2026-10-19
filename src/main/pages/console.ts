import type { BufferList } from '../../shared/buffers'

/**
 * The console of each page buffer (#138, ADR 0008's `browser_get_console_logs`):
 * the last CONSOLE_RING `console-message` events a page's WebContents emitted,
 * kept in main, never on disk, and dropped with the buffer when it is killed.
 *
 * Chromium reports the page's console calls and its uncaught errors on the
 * WebContents, so nothing is hooked into the page: the isolated world could
 * not see the page's `console` anyway, and nothing may write to the page.
 * Every message is page content; what reaches an agent goes through
 * `wrapUntrusted`, by the MCP page tier, never by concatenation.
 */

/** The most entries one page keeps; an older one leaves as a newer one comes. */
export const CONSOLE_RING = 500

/** The longest message one entry keeps, so the ring's memory is bounded too. */
export const MAX_CONSOLE_TEXT = 2000

export const CONSOLE_LEVELS = ['debug', 'info', 'warning', 'error'] as const

export type ConsoleLevel = (typeof CONSOLE_LEVELS)[number]

export interface ConsoleEntry {
  /** When main heard it, in milliseconds since the epoch. */
  readonly at: number
  readonly level: ConsoleLevel
  /** Page content: the message, cut to MAX_CONSOLE_TEXT. */
  readonly text: string
}

export class ConsoleLog {
  private readonly rings = new Map<string, ConsoleEntry[]>()

  constructor(
    buffers: { subscribe(listener: (list: BufferList) => void): unknown },
    private readonly now: () => number = Date.now,
  ) {
    buffers.subscribe((list) => {
      const alive = new Set(list.buffers.map((buffer) => buffer.id))
      for (const id of [...this.rings.keys()]) if (!alive.has(id)) this.rings.delete(id)
    })
  }

  /** One `console-message` of a page buffer; a level Chromium adds later reads as `info`. */
  record(pageId: string, level: string, message: string): void {
    let ring = this.rings.get(pageId)
    if (ring === undefined) {
      ring = []
      this.rings.set(pageId, ring)
    }
    ring.push({
      at: this.now(),
      level: (CONSOLE_LEVELS as readonly string[]).includes(level)
        ? (level as ConsoleLevel)
        : 'info',
      text: message.slice(0, MAX_CONSOLE_TEXT),
    })
    if (ring.length > CONSOLE_RING) ring.splice(0, ring.length - CONSOLE_RING)
  }

  /** The last `limit` entries of a page, oldest first, and whether older ones were left out. */
  read(
    pageId: string,
    limit: number,
  ): { readonly entries: readonly ConsoleEntry[]; readonly truncated: boolean } {
    const ring = this.rings.get(pageId) ?? []
    const entries = limit >= ring.length ? [...ring] : ring.slice(ring.length - limit)
    return { entries, truncated: entries.length < ring.length }
  }

  /** How many entries a page holds now. */
  size(pageId: string): number {
    return this.rings.get(pageId)?.length ?? 0
  }
}
