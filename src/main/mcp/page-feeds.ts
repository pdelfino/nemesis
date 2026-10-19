import type { BufferInfo, BufferList } from '../../shared/buffers'
import { MUTATION_RING, type MutationKind, type MutationsAnswer } from '../../shared/page-door'
import { wrapUntrusted } from '../agent/boundary'
import { describeOrigin } from '../ipc'
import { CONSOLE_RING, type ConsoleEntry } from '../pages/console'
import type { NetworkEntry } from '../pages/network'
import { formatRef } from '../pages/semantic'
import {
  MUTATION_POLL_MS,
  PAGE_FEEDS,
  PAGE_RESOURCES,
  pageFeedUri,
  parsePageFeedUri,
  type PageFeed,
} from './catalog'

/**
 * The page tier's three feeds (#29, ADR 0008): for each open page buffer,
 * `nemesis://page/{page}/mutations`, `/console` and `/network`, listed
 * while the buffer lives, read whole, and subscribable.
 *
 * The console and network rings live in main and say when they move, so a
 * subscriber hears `notifications/resources/updated` at once. The mutations
 * live in the page's isolated world, #94's observer keeping a ring there;
 * main asks the door's `mutations` request with the last record number it
 * holds, every MUTATION_POLL_MS while a client is subscribed and once on a
 * read, and keeps what came in a ring of its own, each record's element made
 * a ref of the document it was read under (ADR 0009: request and answer, no
 * push channel).
 *
 * The label rule of ADR 0008: a read is one JSON object of what Nemesis
 * controls (the buffer id, the committed origin, times, kinds, levels, refs,
 * methods, request origins, statuses, sizes), and one `wrapUntrusted` block
 * holding every string the page controls, one numbered line per record; the
 * record's own field names that line as `[n]`. Nothing is written to disk.
 *
 * Plain data and no Electron types, so the unit tests drive it on fakes.
 */

/** Where the feeds read from; the cockpit wires the rings and the door. */
export interface PageFeedSources {
  readonly console: {
    read(
      pageId: string,
      limit: number,
    ): { readonly entries: readonly ConsoleEntry[]; readonly truncated: boolean }
    on(listener: (pageId: string) => void): () => void
  }
  readonly network: {
    read(pageId: string): readonly NetworkEntry[]
    on(listener: (pageId: string) => void): () => void
  }
  readonly mutations: {
    /** The number main gives the page's current document, the one its refs are made under. */
    document(pageId: string): number
    /** The door's `mutations` answer, records after `since`. */
    read(pageId: string, since: number): Promise<MutationsAnswer>
  }
  /** A repeating timer, for the unit tests; `setInterval` by default. */
  readonly every?: ((ms: number, run: () => void) => () => void) | undefined
}

export interface PageFeedDeps {
  readonly list: () => readonly BufferInfo[]
  readonly committedUrl: (pageId: string) => string | undefined
  readonly buffers: { subscribe(listener: (list: BufferList) => void): unknown }
  readonly feeds: PageFeedSources
}

/** One mutation as main keeps it. */
interface MutationEntry {
  readonly at: number
  readonly kind: MutationKind
  readonly ref: string | null
  readonly summary: string
}

/** Where main is in one page's mutations. */
interface MutationState {
  document: number
  since: number
  readonly records: MutationEntry[]
  polling: Promise<void> | null
}

/** A resource as `resources/list` shows it. */
export interface FeedListing {
  readonly uri: string
  readonly name: string
  readonly mimeType: string
  readonly description: string
}

/** A read: the structure, then the block. */
export interface FeedContents {
  readonly contents: { readonly uri: string; readonly mimeType: string; readonly text: string }[]
}

export class PageFeeds<Subscriber> {
  /** The subscribers of each feed URI. */
  private readonly subscribers = new Map<string, Set<Subscriber>>()
  private readonly mutationStates = new Map<string, MutationState>()
  /** The poll of each page whose mutations have a subscriber. */
  private readonly polls = new Map<string, () => void>()
  private readonly every: (ms: number, run: () => void) => () => void
  private pageIds = ''

  constructor(
    private readonly deps: PageFeedDeps,
    private readonly notify: (subscriber: Subscriber, uri: string) => void,
    private readonly listChanged: () => void,
  ) {
    this.every = deps.feeds.every ?? every
    deps.feeds.console.on((pageId) => this.changed(pageFeedUri(pageId, 'console')))
    deps.feeds.network.on((pageId) => this.changed(pageFeedUri(pageId, 'network')))
    this.pageIds = this.ids()
    deps.buffers.subscribe(() => {
      const ids = this.ids()
      if (ids === this.pageIds) return
      this.pageIds = ids
      this.forgetGone()
      this.listChanged()
    })
  }

  /** Every feed of every open page buffer, in creation order. */
  list(): FeedListing[] {
    return this.deps.list().flatMap((page) =>
      PAGE_FEEDS.map((feed) => ({
        uri: pageFeedUri(page.id, feed),
        name: `page-${page.id}-${feed}`,
        mimeType: PAGE_RESOURCES[feed].mimeType,
        description: PAGE_RESOURCES[feed].description,
      })),
    )
  }

  /** Whether `uri` names a feed of an open page buffer. */
  has(uri: string): boolean {
    const parsed = parsePageFeedUri(uri)
    return parsed !== null && this.isPage(parsed.page)
  }

  async read(uri: string): Promise<FeedContents> {
    const parsed = parsePageFeedUri(uri)
    if (parsed === null || !this.isPage(parsed.page)) throw new Error(`No resource ${uri}`)
    const { page, feed } = parsed
    if (feed === 'mutations') await this.poll(page)
    const url = this.deps.committedUrl(page)
    const origin = url === undefined ? 'a page not yet loaded' : describeOrigin(url)
    const { records, lines } = this.records(page, feed)
    const structure = JSON.stringify({ page, origin, records })
    const block = wrapUntrusted(origin, lines.length === 0 ? 'No records.' : lines.join('\n'))
    return {
      contents: [
        { uri, mimeType: PAGE_RESOURCES[feed].mimeType, text: structure },
        { uri, mimeType: 'text/plain', text: block },
      ],
    }
  }

  subscribe(uri: string, subscriber: Subscriber): void {
    const parsed = parsePageFeedUri(uri)
    if (parsed === null || !this.isPage(parsed.page)) throw new Error(`No resource ${uri}`)
    let set = this.subscribers.get(uri)
    if (set === undefined) {
      set = new Set()
      this.subscribers.set(uri, set)
    }
    set.add(subscriber)
    if (parsed.feed === 'mutations' && !this.polls.has(parsed.page)) {
      const page = parsed.page
      this.polls.set(
        page,
        this.every(MUTATION_POLL_MS, () => void this.poll(page)),
      )
      void this.poll(page)
    }
  }

  unsubscribe(uri: string, subscriber: Subscriber): void {
    const set = this.subscribers.get(uri)
    set?.delete(subscriber)
    if (set !== undefined && set.size === 0) this.subscribers.delete(uri)
    this.stopIdlePolls()
  }

  /** A subscriber gone: its connection closed. */
  drop(subscriber: Subscriber): void {
    for (const [uri, set] of [...this.subscribers]) {
      set.delete(subscriber)
      if (set.size === 0) this.subscribers.delete(uri)
    }
    this.stopIdlePolls()
  }

  /** The records of one feed, and the block's lines, one per record. */
  private records(
    page: string,
    feed: PageFeed,
  ): { records: Record<string, unknown>[]; lines: string[] } {
    const lines: string[] = []
    const line = (field: string, text: string): string => {
      lines.push(`[${lines.length + 1}] ${field}: ${JSON.stringify(text)}`)
      return `[${lines.length}]`
    }
    switch (feed) {
      case 'mutations':
        return {
          records: (this.mutationStates.get(page)?.records ?? []).map((record) => ({
            at: record.at,
            kind: record.kind,
            ref: record.ref,
            summary: line('summary', record.summary),
          })),
          lines,
        }
      case 'console':
        return {
          records: this.deps.feeds.console.read(page, CONSOLE_RING).entries.map((entry) => ({
            at: entry.at,
            level: entry.level,
            text: line('text', entry.text),
          })),
          lines,
        }
      case 'network':
        return {
          records: this.deps.feeds.network.read(page).map((entry) => ({
            at: entry.at,
            method: entry.method,
            origin: entry.origin,
            path: line('path', entry.path),
            status: entry.status,
            bytes: entry.bytes,
          })),
          lines,
        }
    }
  }

  /**
   * Asks the page for the mutations after the last one main holds, one ask
   * at a time per page. A new document starts from its first record; an
   * answer read across a navigation is dropped, since its refs would name
   * the wrong document. A page that does not answer leaves the ring as it was.
   */
  private poll(page: string): Promise<void> {
    let state = this.mutationStates.get(page)
    if (state === undefined) {
      state = { document: -1, since: 0, records: [], polling: null }
      this.mutationStates.set(page, state)
    }
    if (state.polling !== null) return state.polling
    const held = state
    const run = async (): Promise<void> => {
      const { mutations } = this.deps.feeds
      const document = mutations.document(page)
      const since = document === held.document ? held.since : 0
      const answer = await mutations.read(page, since)
      if (!this.isPage(page) || mutations.document(page) !== document) return
      held.document = document
      held.since = answer.last
      const fresh = answer.records.filter((record) => record.seq > since)
      if (fresh.length === 0) return
      for (const record of fresh) {
        held.records.push({
          at: record.at,
          kind: record.kind,
          ref: record.element > 0 ? formatRef(document, record.element) : null,
          summary: record.summary,
        })
      }
      if (held.records.length > MUTATION_RING) {
        held.records.splice(0, held.records.length - MUTATION_RING)
      }
      this.changed(pageFeedUri(page, 'mutations'))
    }
    held.polling = run()
      .catch(() => undefined)
      .finally(() => {
        held.polling = null
      })
    return held.polling
  }

  private changed(uri: string): void {
    for (const subscriber of [...(this.subscribers.get(uri) ?? [])]) this.notify(subscriber, uri)
  }

  /** Stops the poll of every page no client is subscribed to the mutations of. */
  private stopIdlePolls(): void {
    for (const [page, stop] of [...this.polls]) {
      if (!this.subscribers.has(pageFeedUri(page, 'mutations'))) {
        stop()
        this.polls.delete(page)
      }
    }
  }

  /** Drops the subscriptions, the polls and the mutations of every killed page. */
  private forgetGone(): void {
    for (const uri of [...this.subscribers.keys()]) {
      const parsed = parsePageFeedUri(uri)
      if (parsed === null || !this.isPage(parsed.page)) this.subscribers.delete(uri)
    }
    for (const page of [...this.mutationStates.keys()]) {
      if (!this.isPage(page)) this.mutationStates.delete(page)
    }
    this.stopIdlePolls()
  }

  private isPage(id: string): boolean {
    return this.deps.list().some((page) => page.id === id)
  }

  private ids(): string {
    return this.deps
      .list()
      .map((page) => page.id)
      .join(' ')
  }
}

function every(ms: number, run: () => void): () => void {
  const timer = setInterval(run, ms)
  timer.unref?.()
  return () => clearInterval(timer)
}
