import type { BufferInfo, BufferList, PageEvent } from '../../shared/buffers'
import { MAX_SNAPSHOT_NODES, type FormAnswer, type TextAnswer } from '../../shared/page-door'
import { wrapUntrusted } from '../agent/boundary'
import { describeOrigin } from '../ipc'
import type { ConsoleEntry } from '../pages/console'
import { formReading, formText } from '../pages/form-guide'
import { readerBody, type ReaderDocument } from '../pages/reader'
import {
  semanticText,
  semanticTree,
  type ResolvedRef,
  type SemanticSnapshot,
} from '../pages/semantic'
import {
  CONSOLE_LIMIT,
  READ_TEXT_CHARS,
  WAIT_CAP_SECONDS,
  WAIT_FOR_CAP_SECONDS,
  WAIT_FOR_DEFAULT_SECONDS,
} from './catalog'

/**
 * The page tier of the MCP server, its reading half (#138, ADR 0008): the
 * tools that read a page buffer and never act on it. Each is a thin relay to
 * what the cockpit already reads through the page-script door (ADR 0009):
 * the semantic view (#122), reader extraction (#128), the form snapshot
 * (#94), the door's `text` request, and the console ring kept in main.
 *
 * The label rule of ADR 0008: what Nemesis controls (the buffer id, the
 * origin of the committed top-frame URL main holds, counts, flags, times,
 * refs) is the structure; every string the page controls (title, full URL,
 * tree, element text, console text) goes in one `wrapUntrusted` block, so a
 * client that reads only the structure is never steered by the page.
 *
 * Plain data and no Electron types, so the unit tests drive it on fakes.
 */

/** What a page tool returns: the structure, a line of it for text-only clients, the one block. */
export interface PageAnswer {
  readonly structured: Record<string, unknown>
  readonly text: string
  readonly block?: string
}

export interface PageTierDeps {
  /** The page buffers of this cockpit, in creation order. */
  readonly list: () => readonly BufferInfo[]
  /** A page buffer's committed top-frame URL; undefined when gone or none committed. */
  readonly committedUrl: (pageId: string) => string | undefined
  readonly snapshot: (pageId: string) => Promise<SemanticSnapshot>
  readonly resolve: (ref: string) => ResolvedRef | null
  readonly reader: (pageId: string) => Promise<ReaderDocument>
  /** The door's `text` answer for one element, parsed whole. */
  readonly text: (
    pageId: string,
    element: number,
    from: number,
    chars: number,
  ) => Promise<TextAnswer>
  /** The door's `form` answer, read whole, and the document number its refs are made under. */
  readonly form: (pageId: string) => Promise<{ answer: FormAnswer; document: number }>
  readonly console: {
    read(
      pageId: string,
      limit: number,
    ): { readonly entries: readonly ConsoleEntry[]; readonly truncated: boolean }
  }
  readonly events: (listener: (event: PageEvent) => void) => () => void
  readonly buffers: {
    readonly current: BufferInfo | null
    subscribe(listener: (list: BufferList) => void): unknown
  }
  /** Timers, for the unit tests; the real ones by default. */
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  readonly now?: () => number
}

/** The least time between two snapshots `browser_wait_for` takes. */
export const WAIT_FOR_SNAPSHOT_MS = 250

/** How long `browser_wait_for` sits with no page event before it looks again. */
const WAIT_FOR_POLL_MS = 1000

/** A page resolved: its buffer id, and the URL and origin it had committed when asked. */
interface Resolved {
  readonly pageId: string
  readonly url: string
  readonly origin: string
}

export class PageTier {
  /** The page buffer that was current last, the default when the current buffer is no page. */
  private lastPage: string | null = null
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>
  private readonly now: () => number

  constructor(private readonly deps: PageTierDeps) {
    this.sleep = deps.sleep ?? sleep
    this.now = deps.now ?? Date.now
    deps.buffers.subscribe((list) => {
      if (list.currentId !== null && this.isPage(list.currentId)) this.lastPage = list.currentId
    })
  }

  async call(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<PageAnswer> {
    const page = optionalString(args['page'])
    switch (name) {
      case 'browser_snapshot':
        return this.snapshot(page)
      case 'browser_wait':
        return this.wait(page, numberOr(args['time'], 0), signal)
      case 'browser_wait_for':
        return this.waitFor(
          page,
          {
            ref: optionalString(args['ref']),
            text: optionalString(args['text']),
            url: optionalString(args['url']),
          },
          numberOr(args['timeout'], WAIT_FOR_DEFAULT_SECONDS),
          signal,
        )
      case 'browser_read_text':
        return this.readText(
          page,
          optionalString(args['ref']),
          numberOr(args['from'], 0),
          numberOr(args['chars'], READ_TEXT_CHARS),
        )
      case 'browser_form_state':
        return this.formState(page)
      case 'browser_get_console_logs':
        return this.consoleLogs(page, numberOr(args['limit'], CONSOLE_LIMIT))
      default:
        throw new Error(`No relay for ${name}`)
    }
  }

  private isPage(id: string): boolean {
    return this.deps.list().some((buffer) => buffer.id === id)
  }

  /**
   * The page a call names, or the current page buffer: the current buffer
   * when it is a page, else the page that was current last, else the newest.
   */
  private pageOf(given: string | undefined): string {
    if (given !== undefined) {
      if (!this.isPage(given)) throw new Error(`No page buffer with id "${given}"`)
      return given
    }
    const current = this.deps.buffers.current?.id
    if (current !== undefined && this.isPage(current)) return current
    if (this.lastPage !== null && this.isPage(this.lastPage)) return this.lastPage
    const newest = this.deps.list().at(-1)
    if (newest === undefined) {
      throw new Error(
        'No page buffer is open: open a page, or pass `page` from cockpit_list_buffers',
      )
    }
    return newest.id
  }

  private resolve(given: string | undefined): Resolved {
    const pageId = this.pageOf(given)
    const url = this.deps.committedUrl(pageId)
    if (url === undefined) throw new Error(`The page ${pageId} has not loaded a URL yet`)
    return { pageId, url, origin: describeOrigin(url) }
  }

  private async snapshot(given: string | undefined): Promise<PageAnswer> {
    const { pageId } = this.resolve(given)
    const snapshot = await this.deps.snapshot(pageId)
    const truncated = snapshot.count >= MAX_SNAPSHOT_NODES
    return {
      structured: { page: pageId, origin: snapshot.origin, refs: snapshot.count, truncated },
      text: `Snapshot of ${pageId} on ${snapshot.origin}: ${snapshot.count} refs${truncated ? ', cut at the cap' : ''}.`,
      block: wrapUntrusted(snapshot.origin, semanticText(snapshot)),
    }
  }

  private async wait(
    given: string | undefined,
    seconds: number,
    signal: AbortSignal | undefined,
  ): Promise<PageAnswer> {
    this.pageOf(given)
    const capped = Math.min(Math.max(seconds, 0), WAIT_CAP_SECONDS)
    const started = this.now()
    await this.sleep(capped * 1000, signal).catch(() => undefined)
    const waited = Math.min(capped, (this.now() - started) / 1000)
    return { structured: { waited }, text: `Waited ${waited} seconds.` }
  }

  /**
   * Waits in main until every condition given holds: the committed URL
   * contains `url`, the ref is in a fresh snapshot, `text` is in a snapshot's
   * names or values. It looks again on each event of the page, or after a
   * quiet second, never two snapshots within WAIT_FOR_SNAPSHOT_MS.
   */
  private async waitFor(
    given: string | undefined,
    until: {
      readonly ref: string | undefined
      readonly text: string | undefined
      readonly url: string | undefined
    },
    timeout: number,
    signal: AbortSignal | undefined,
  ): Promise<PageAnswer> {
    if (until.ref === undefined && until.text === undefined && until.url === undefined) {
      throw new Error('Name a ref, a text or a url to wait for')
    }
    let pageId = given === undefined ? undefined : this.pageOf(given)
    if (until.ref !== undefined) {
      const resolved = this.deps.resolve(until.ref)
      if (resolved === null)
        throw new Error(`The ref ${until.ref} is not live: take a new snapshot`)
      if (pageId !== undefined && resolved.pageId !== pageId) {
        throw new Error(`The ref ${until.ref} is not on the page ${pageId}`)
      }
      pageId = resolved.pageId
    }
    const page = this.resolve(pageId)
    const snapshots = until.ref !== undefined || until.text !== undefined
    const started = this.now()
    const deadline = started + Math.min(Math.max(timeout, 0), WAIT_FOR_CAP_SECONDS) * 1000
    let moved: boolean
    let wake: (() => void) | null = null
    const off = this.deps.events((event) => {
      if (event.pageId !== page.pageId) return
      moved = true
      wake?.()
    })
    try {
      for (;;) {
        if (!this.isPage(page.pageId)) throw new Error(`The page ${page.pageId} is gone`)
        moved = false
        const looked = this.now()
        const met = await this.conditionsMet(page.pageId, until)
        const now = this.now()
        if (met || now >= deadline || signal?.aborted === true) {
          const after = now - started
          return {
            structured: {
              page: page.pageId,
              origin: describeOrigin(this.deps.committedUrl(page.pageId) ?? page.url),
              met,
              after,
            },
            text: `${met ? 'Met' : 'Not met'} on ${page.pageId} after ${after} ms.`,
          }
        }
        // The next look: on the page's next event or after a quiet spell, never past the deadline.
        if (!moved) {
          const controller = new AbortController()
          const stop = (): void => controller.abort()
          wake = stop
          signal?.addEventListener('abort', stop)
          await this.sleep(Math.min(WAIT_FOR_POLL_MS, deadline - now), controller.signal).catch(
            () => undefined,
          )
          signal?.removeEventListener('abort', stop)
          wake = null
        }
        // Snapshots stay WAIT_FOR_SNAPSHOT_MS apart, however busy the page is.
        const gap = Math.min(looked + WAIT_FOR_SNAPSHOT_MS, deadline) - this.now()
        if (snapshots && gap > 0) await this.sleep(gap, signal).catch(() => undefined)
      }
    } finally {
      off()
    }
  }

  private async conditionsMet(
    pageId: string,
    until: {
      readonly ref: string | undefined
      readonly text: string | undefined
      readonly url: string | undefined
    },
  ): Promise<boolean> {
    if (until.url !== undefined && !(this.deps.committedUrl(pageId) ?? '').includes(until.url)) {
      return false
    }
    if (until.ref === undefined && until.text === undefined) return true
    if (until.ref !== undefined && this.deps.resolve(until.ref) === null) return false
    let snapshot: SemanticSnapshot
    try {
      snapshot = await this.deps.snapshot(pageId)
    } catch {
      // A page between documents has no snapshot yet; the next look tries again.
      return false
    }
    if (until.ref !== undefined && !hasRef(snapshot, until.ref)) return false
    if (until.text !== undefined && !semanticTree(snapshot.nodes).includes(until.text)) {
      return false
    }
    return true
  }

  private async readText(
    given: string | undefined,
    ref: string | undefined,
    from: number,
    chars: number,
  ): Promise<PageAnswer> {
    if (ref === undefined) {
      const { pageId } = this.resolve(given)
      const document = await this.deps.reader(pageId)
      const whole = `${document.title}\n\n${readerBody(document)}`
      return this.textAnswer(
        pageId,
        document.origin,
        whole.slice(from, from + chars),
        from + chars < whole.length,
      )
    }
    const resolved = this.deps.resolve(ref)
    if (resolved === null) throw new Error(`The ref ${ref} is not live: take a new snapshot`)
    if (given !== undefined && resolved.pageId !== this.pageOf(given)) {
      throw new Error(`The ref ${ref} is not on the page ${given}`)
    }
    const { pageId, url, origin } = this.resolve(resolved.pageId)
    const answer = await this.deps.text(pageId, resolved.element, from, chars)
    if (this.deps.committedUrl(pageId) !== url || this.deps.resolve(ref) === null) {
      throw new Error('The page navigated while its text was read')
    }
    if (answer.status === 'masked') throw new Error('masked field: the human reads it')
    if (answer.status === 'gone') throw new Error(`The element of ${ref} is no longer on the page`)
    return this.textAnswer(pageId, origin, answer.text, from + answer.text.length < answer.total)
  }

  private textAnswer(pageId: string, origin: string, text: string, truncated: boolean): PageAnswer {
    return {
      structured: { page: pageId, origin, chars: text.length, truncated },
      text: `${text.length} characters of ${pageId} on ${origin}${truncated ? ', more follow' : ''}.`,
      block: wrapUntrusted(origin, text),
    }
  }

  private async formState(given: string | undefined): Promise<PageAnswer> {
    const { pageId, url } = this.resolve(given)
    const { answer, document } = await this.deps.form(pageId)
    if (this.deps.committedUrl(pageId) !== url) {
      throw new Error('The page navigated while its form was read')
    }
    const reading = formReading(url, document, answer)
    return {
      structured: {
        page: pageId,
        origin: reading.origin,
        fields: reading.fields.length,
        focused: reading.focused,
      },
      text: `${reading.fields.length} form fields on ${pageId} at ${reading.origin}${reading.focused === null ? '' : `, ${reading.focused} focused`}.`,
      block: wrapUntrusted(reading.origin, formText(reading)),
    }
  }

  private consoleLogs(given: string | undefined, limit: number): PageAnswer {
    const { pageId, origin } = this.resolve(given)
    const { entries, truncated } = this.deps.console.read(pageId, limit)
    const lines = entries.map(
      (entry) => `${new Date(entry.at).toISOString()} ${entry.level}: ${entry.text}`,
    )
    return {
      structured: { page: pageId, origin, entries: entries.length, truncated },
      text: `${entries.length} console entries of ${pageId} on ${origin}${truncated ? ', older ones left out' : ''}.`,
      block: wrapUntrusted(origin, lines.length === 0 ? 'No console entries.' : lines.join('\n')),
    }
  }
}

function hasRef(snapshot: SemanticSnapshot, ref: string): boolean {
  const stack = [...snapshot.nodes]
  for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
    if (node.ref === ref) return true
    stack.push(...node.children)
  }
  return false
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new Error('aborted'))
      return
    }
    const timer = setTimeout(
      () => {
        signal?.removeEventListener('abort', stop)
        resolve()
      },
      Math.max(ms, 0),
    )
    const stop = (): void => {
      clearTimeout(timer)
      reject(new Error('aborted'))
    }
    signal?.addEventListener('abort', stop, { once: true })
  })
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}
