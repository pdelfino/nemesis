import type { BufferInfo, BufferList, PageEvent } from '../../shared/buffers'
import {
  FORM_FLAGS,
  MAX_SNAPSHOT_NODES,
  type FormAnswer,
  type HintsAnswer,
  type OptionsAnswer,
  type QueryAnswer,
  type SelectAnswer,
  type SelectStatus,
  type TextAnswer,
} from '../../shared/page-door'
import { wrapUntrusted } from '../agent/boundary'
import { describeOrigin } from '../ipc'
import { navigationAllowed } from '../security/navigation-policy'
import { upgradeOf } from '../security/transport'
import { keyStroke } from '../page-buffer'
import { normalizeUrl } from '../url-sources'
import type { ConsoleEntry } from '../pages/console'
import type { PageFeedSources } from './page-feeds'
import { formReading, formText } from '../pages/form-guide'
import { readerBody, type ReaderDocument } from '../pages/reader'
import {
  formatRef,
  parseRef,
  semanticText,
  semanticTree,
  type ResolvedRef,
  type SemanticNode,
  type SemanticRect,
  type SemanticSnapshot,
} from '../pages/semantic'
import {
  CONSOLE_LIMIT,
  QUERY_LIMIT,
  READ_TEXT_CHARS,
  SETTLE_CAP_SECONDS,
  WAIT_CAP_SECONDS,
  WAIT_FOR_CAP_SECONDS,
  WAIT_FOR_DEFAULT_SECONDS,
} from './catalog'

/**
 * The page tier of the MCP server (ADR 0008). Its reading half (#138): the
 * tools that read a page buffer and never act on it. Each is a thin relay to
 * what the cockpit already reads through the page-script door (ADR 0009):
 * the semantic view (#122), reader extraction (#128), the form snapshot
 * (#94), the door's `text` request, and the console ring kept in main.
 *
 * Its navigation (#139): navigate, back, forward, open and close, through
 * the page buffers' own paths, so the navigation policy (#48) and transport
 * (#52) decide as they do for the keys. The agent names a URL rather than
 * typing one, so a plain `http:` URL off loopback is refused with the reason
 * rather than upgraded behind its back, and `javascript:`, `file:` and
 * `data:` are refused before anything loads. A move answers once the load
 * settles, capped at SETTLE_CAP_SECONDS, with the page's snapshot.
 *
 * Its acting tools (#140): click, hover, type, press a key, drag and
 * capture. A `ref` resolves through the snapshot main takes of its page at
 * the call, so a ref of a document the page left is refused with a word to
 * take a new snapshot. Input is synthesized in main, as hint mode clicks
 * (#123): the element's box from the snapshot is placed in the viewport by
 * the door's `hints` read, and the page sees the user's own kind of input,
 * never a script (ADR 0009). The question names the tool, the page's origin
 * and the agent's `element` words quoted, never the page's own text; a stale
 * ref, and a masked field for `browser_type`, are refused before it.
 *
 * Its two rows through ADR 0009's exceptions (#141). `browser_query` sends
 * the agent's CSS selector to the door's `query`, which runs it in the
 * page's isolated world; the matches come back as refs and outer HTML, the
 * HTML in the block. `browser_select_option` reads a `<select>`'s options
 * with the door's `options`, matches the agent's values against them in
 * main, by value and then by label, and sends the door's one write, `select`,
 * the chosen indexes: numbers, never the values. A masked field, a stale ref,
 * an element that is no `<select>` and a value no option has are refused
 * before anyone is asked.
 *
 * The label rule of ADR 0008: what Nemesis controls (the buffer id, the
 * origin of the committed top-frame URL main holds, counts, flags, times,
 * refs) is the structure; every string the page controls (title, full URL,
 * tree, element text, console text) goes in one `wrapUntrusted` block. The
 * server sends that block as a text item and as the structure's `untrusted`
 * field (#151), the one field a page string may reach, always inside its
 * header and footer; no field this file builds holds one.
 *
 * Plain data and no Electron types, so the unit tests drive it on fakes.
 */

/** What a page tool returns: the structure, a line of it for text-only clients, the one block. */
export interface PageAnswer {
  readonly structured: Record<string, unknown>
  readonly text: string
  readonly block?: string
  /** A screenshot (#140): a PNG, base64, checked by its signature. */
  readonly image?: string
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
  /** The moves of the navigation tools (#139), the page buffers' own paths. */
  readonly moves: PageMoves
  /** The acting tools' input and captures (#140); absent, every acting call is an error. */
  readonly acts?: PageActs | undefined
  /** The door's `query` for `browser_query` (#141), and the document its refs are made under; absent, the call is an error. */
  readonly query?:
    | ((
        pageId: string,
        selector: string,
        limit: number,
      ) => Promise<{ answer: QueryAnswer; document: number }>)
    | undefined
  /** The door's `options` and `select` for `browser_select_option` (#141); absent, the call is an error. */
  readonly selects?: PageSelects | undefined
  /** The three feeds of #29, served as resources by page-feeds.ts; absent, none is served. */
  readonly feeds?: PageFeedSources | undefined
  readonly buffers: {
    readonly current: BufferInfo | null
    subscribe(listener: (list: BufferList) => void): unknown
  }
  /** Timers, for the unit tests; the real ones by default. */
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  readonly now?: () => number
}

/** What the navigation tools ask of the page buffers (#139); page-buffer.ts answers. */
export interface PageMoves {
  /** Loads `url` in the page, as open-url does: null once loaded, else the reason. */
  load(pageId: string, url: string): Promise<string | null>
  /** A new page buffer, not made current, and its id. */
  create(): string
  /** One step through the page's history, as `back` and `forward` take it. */
  step(pageId: string, by: -1 | 1): 'moved' | 'none' | 'refused'
  /** Kills the page buffer. */
  close(pageId: string): void
}

/** A point of a page's viewport, in CSS pixels. */
export interface ViewportPoint {
  readonly x: number
  readonly y: number
}

/**
 * What the acting tools ask of the page buffers (#140). Input is synthesized
 * in main, never by a page script; a capture is a PNG, base64.
 */
export interface PageActs {
  /** The door's `hints` read: the interactive elements in view, their boxes in the viewport. */
  hints(pageId: string): Promise<HintsAnswer>
  /** The page's viewport in CSS pixels; null for a page never laid out. */
  viewport(pageId: string): { readonly width: number; readonly height: number } | null
  click(pageId: string, at: ViewportPoint): void
  hover(pageId: string, at: ViewportPoint): void
  drag(pageId: string, from: ViewportPoint, to: ViewportPoint): void
  /** Replaces the focused field's text, as the form guide types it (#94). */
  type(pageId: string, text: string): Promise<void>
  /** One key keyStroke knows. */
  key(pageId: string, key: string): void
  /** The viewport, or a box of it in CSS pixels, as `capturePage` takes it. */
  capture(pageId: string, box?: SemanticRect): Promise<string>
  /** The whole page, through the DevTools protocol's one method, attached for the call. */
  captureFull(pageId: string): Promise<string>
}

/**
 * A `<select>`'s choice through the door (#141): its options, read, and the
 * one write, by index, each with the document number the element's ref is under.
 */
export interface PageSelects {
  options(pageId: string, element: number): Promise<{ answer: OptionsAnswer; document: number }>
  select(
    pageId: string,
    element: number,
    count: number,
    indexes: readonly number[],
  ): Promise<{ answer: SelectAnswer; document: number }>
}

/** The tools that act on a page (#140, #141), each asked once per call. */
export const ACTING_TOOLS: ReadonlySet<string> = new Set([
  'browser_click',
  'browser_hover',
  'browser_type',
  'browser_select_option',
  'browser_press_key',
  'browser_drag',
  'browser_screenshot',
])

/** What `browser_type` answers for a secret field, before anyone is asked (ADR 0008). */
export const MASKED_TYPE = 'masked field: the human types it'

/** What `browser_select_option` answers for a secret field, before anyone is asked (#141). */
export const MASKED_SELECT = 'masked field: the human chooses it'

/** What `browser_query` answers on a page whose secret field carries a value attribute (#141). */
export const MASKED_QUERY =
  'masked field: a secret field of this page carries a value attribute, which a selector could test, so no selector is answered here; the human reads it'

/** How many of `browser_select_option`'s values its question quotes. */
const QUOTED_VALUES = 5

/** How long an act waits for the page to start a navigation it caused. */
export const ACT_SETTLE_MS = 300

/** How many times `browser_type` looks for the focus its click gave, and how far apart. */
const FOCUS_LOOKS = 10
const FOCUS_LOOK_MS = 50

/**
 * The URL a navigation tool loads for `raw`, the open-url normalization of
 * #124 (a host alone goes on `https:`), or an error with the refusal
 * (SECURITY.org T3): plain `http:` off loopback, or a scheme the page policy
 * refuses. The reason names the scheme, never the URL.
 */
export function navigationTarget(raw: string): string {
  const trimmed = raw.trim()
  if (upgradeOf(trimmed) !== null) {
    throw new Error(
      'Refused: a plain http: URL off loopback never loads; ask for its https: URL (SECURITY.org, T3)',
    )
  }
  const url = normalizeUrl(trimmed)
  if (!navigationAllowed('page', url)) {
    throw new Error(
      `Refused: ${schemeOf(url)} is not a page URL; a page buffer opens https:, and http: on loopback only (SECURITY.org, T3)`,
    )
  }
  return url
}

/** What `within` answers when the cap came first. */
const TIMEOUT = Symbol('timeout')
type Timeout = typeof TIMEOUT

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
      case 'browser_query':
        return this.query(page, String(args['selector']), numberOr(args['limit'], QUERY_LIMIT))
      case 'browser_navigate':
        return this.navigate(page, String(args['url']), signal)
      case 'browser_go_back':
        return this.step(page, -1, signal)
      case 'browser_go_forward':
        return this.step(page, 1, signal)
      case 'browser_open_page':
        return this.openPage(String(args['url']), signal)
      case 'browser_close_page':
        return this.closePage(String(args['page']))
      case 'browser_click':
        return this.pointAt(page, String(args['ref']), 'click', signal)
      case 'browser_hover':
        return this.pointAt(page, String(args['ref']), 'hover', signal)
      case 'browser_type':
        return this.type(
          page,
          String(args['ref']),
          String(args['text']),
          args['submit'] === true,
          signal,
        )
      case 'browser_select_option':
        return this.selectOption(page, String(args['ref']), stringList(args['values']), signal)
      case 'browser_press_key':
        return this.pressKey(page, String(args['key']), signal)
      case 'browser_drag':
        return this.drag(page, String(args['startRef']), String(args['endRef']), signal)
      case 'browser_screenshot':
        return this.screenshot(page, optionalString(args['ref']), args['fullPage'] === true)
      default:
        throw new Error(`No relay for ${name}`)
    }
  }

  /**
   * The socket door's question for a navigation tool (#139): the tool, the
   * origin of the page it moves, and the URL the client named as `quote`
   * renders it; never a string the page wrote. The page the question names
   * is pinned in the arguments it answers with, so a switch of buffer while
   * the user answers never moves another page. A refusal throws here, before
   * anyone is asked.
   */
  async question(
    name: string,
    args: Record<string, unknown>,
    quote: (text: string) => string,
  ): Promise<{ readonly question: string; readonly args: Record<string, unknown> }> {
    if (ACTING_TOOLS.has(name)) return this.actQuestion(name, args, quote)
    if (name === 'browser_open_page') {
      const url = navigationTarget(String(args['url']))
      return {
        question: `${name} on ${describeOrigin(url)}: open ${quote(url)} in a new page?`,
        args,
      }
    }
    const pageId = this.pageOf(optionalString(args['page']))
    const on = `${name} on ${this.originOf(pageId)}`
    const pinned = { ...args, page: pageId }
    switch (name) {
      case 'browser_navigate': {
        const url = navigationTarget(String(args['url']))
        return { question: `${on}: load ${quote(url)} in ${pageId}?`, args: pinned }
      }
      case 'browser_go_back':
        return { question: `${on}: go back in ${pageId}?`, args: pinned }
      case 'browser_go_forward':
        return { question: `${on}: go forward in ${pageId}?`, args: pinned }
      case 'browser_close_page':
        return { question: `${on}: close ${pageId}?`, args: pinned }
      default:
        throw new Error(`No question for ${name}`)
    }
  }

  /**
   * The question of an acting tool (#140): the tool, the page's origin, then
   * what it does in the agent's own words for the element, quoted and cut by
   * `quote`. Every ref is resolved first, through a fresh snapshot, so a stale
   * ref, and a masked field for `browser_type`, are refused before anyone is
   * asked. The page the refs are on is pinned in the arguments.
   */
  private async actQuestion(
    name: string,
    args: Record<string, unknown>,
    quote: (text: string) => string,
  ): Promise<{ readonly question: string; readonly args: Record<string, unknown> }> {
    const given = optionalString(args['page'])
    const refs = (
      name === 'browser_drag' ? [args['startRef'], args['endRef']] : [args['ref']]
    ).filter((ref): ref is string => typeof ref === 'string')
    let pageId = refs.length === 0 ? this.pageOf(given) : undefined
    for (const ref of refs) {
      const { page, node } = await this.element(given, ref)
      if (pageId !== undefined && page.pageId !== pageId) {
        throw new Error(`The refs ${refs.join(' and ')} are on different pages`)
      }
      pageId = page.pageId
      if (name === 'browser_type' && isMasked(node)) throw new Error(MASKED_TYPE)
      if (name === 'browser_select_option' && isMasked(node)) throw new Error(MASKED_SELECT)
    }
    if (pageId === undefined) throw new Error('No page to act on')
    const element = quote(String(args['element']))
    let does: string
    switch (name) {
      case 'browser_click':
        does = `click ${element} in ${pageId}`
        break
      case 'browser_hover':
        does = `hover over ${element} in ${pageId}`
        break
      case 'browser_type': {
        const count = [...String(args['text'])].length
        const then = args['submit'] === true ? ', then press Enter to submit it' : ''
        does = `type ${count} character${count === 1 ? '' : 's'} into ${element} in ${pageId}${then}`
        break
      }
      case 'browser_select_option': {
        const values = stringList(args['values'])
        await this.choices(pageId, String(args['ref']), values)
        const shown = values.slice(0, QUOTED_VALUES).map(quote).join(', ')
        const more =
          values.length > QUOTED_VALUES ? `, and ${values.length - QUOTED_VALUES} more` : ''
        does = `choose ${shown}${more} in ${element} in ${pageId}`
        break
      }
      case 'browser_press_key': {
        const key = String(args['key'])
        if (keyStroke(key) === null)
          throw new Error(`Not a key the page tier presses: ${quote(key)}`)
        const submits = key === 'Enter' ? ', which may submit a form' : ''
        does = `press ${quote(key)} in ${pageId}${submits}`
        break
      }
      case 'browser_drag':
        does = `drag ${quote(String(args['startElement']))} onto ${quote(String(args['endElement']))} in ${pageId}`
        break
      default: {
        const ref = optionalString(args['ref'])
        if (ref !== undefined && args['fullPage'] === true) {
          throw new Error('Pass ref or fullPage, not both')
        }
        const what =
          ref !== undefined
            ? `the element ${ref}`
            : args['fullPage'] === true
              ? 'the whole page'
              : 'the viewport'
        does = `capture ${what} of ${pageId} as an image, secret fields as the page draws them`
      }
    }
    return {
      question: `${name} on ${this.originOf(pageId)}: ${does}?`,
      args: { ...args, page: pageId },
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

  /** The origin of a page's committed URL, as a question names it. */
  private originOf(pageId: string): string {
    const url = this.deps.committedUrl(pageId)
    return url === undefined ? 'a page not yet loaded' : describeOrigin(url)
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

  private async navigate(
    given: string | undefined,
    raw: string,
    signal: AbortSignal | undefined,
  ): Promise<PageAnswer> {
    const pageId = this.pageOf(given)
    const url = navigationTarget(raw)
    const status = await this.loaded(this.deps.moves.load(pageId, url), signal)
    return this.landed(pageId, { status }, `Navigation ${status}:`)
  }

  private async openPage(raw: string, signal: AbortSignal | undefined): Promise<PageAnswer> {
    const url = navigationTarget(raw)
    const pageId = this.deps.moves.create()
    const status = await this.loaded(this.deps.moves.load(pageId, url), signal)
    return this.landed(pageId, { status }, `Opened, ${status}:`)
  }

  /**
   * Back or forward, as the keys go: the step through the page buffers, then
   * the page's next stop of loading, or a failure, capped.
   */
  private async step(
    given: string | undefined,
    by: -1 | 1,
    signal: AbortSignal | undefined,
  ): Promise<PageAnswer> {
    const pageId = this.pageOf(given)
    let settle = (): void => undefined
    const settled = new Promise<void>((resolve) => {
      settle = resolve
    })
    const off = this.deps.events((event) => {
      if (event.pageId !== pageId) return
      if (event.type === 'stopped' || event.type === 'failed') settle()
    })
    let moved: 'moved' | 'none' | 'refused'
    try {
      moved = this.deps.moves.step(pageId, by)
      if (moved === 'refused') {
        throw new Error(
          `Refused: the ${by === -1 ? 'previous' : 'next'} entry is not a page URL (SECURITY.org, T3)`,
        )
      }
      if (moved === 'moved')
        await this.within(
          settled.then(() => 'settled' as const),
          signal,
        )
    } finally {
      off()
    }
    const way = by === -1 ? 'back' : 'forward'
    return this.landed(
      pageId,
      { moved: moved === 'moved' },
      moved === 'moved' ? `Went ${way}:` : `No page to go ${way} to:`,
    )
  }

  private closePage(pageId: string): PageAnswer {
    if (!this.isPage(pageId)) throw new Error(`No page buffer with id "${pageId}"`)
    this.deps.moves.close(pageId)
    const closed = !this.isPage(pageId)
    return {
      structured: { page: pageId, closed },
      text: closed ? `Closed ${pageId}.` : `${pageId} is still open.`,
    }
  }

  /** How a load ended: loaded, failed with the reason the buffers gave, or not settled by the cap. */
  private async loaded(
    load: Promise<string | null>,
    signal: AbortSignal | undefined,
  ): Promise<'loaded' | 'failed' | 'timeout'> {
    const reason = await this.within(load, signal)
    if (reason === 'refused') throw new Error('Refused by the navigation policy (SECURITY.org, T3)')
    if (reason === TIMEOUT) return 'timeout'
    return reason === null ? 'loaded' : 'failed'
  }

  /** `work`, or TIMEOUT once SETTLE_CAP_SECONDS have passed or the call was withdrawn. */
  private async within<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T | Timeout> {
    const controller = new AbortController()
    const stop = (): void => controller.abort()
    signal?.addEventListener('abort', stop)
    try {
      return await Promise.race([
        work,
        this.sleep(SETTLE_CAP_SECONDS * 1000, controller.signal).then(
          (): Timeout => TIMEOUT,
          (): Timeout => TIMEOUT,
        ),
      ])
    } finally {
      controller.abort()
      signal?.removeEventListener('abort', stop)
    }
  }

  /**
   * Where a move left the page: its id and the origin it committed in the
   * structure, the snapshot in the block, as browser_snapshot gives it. A
   * page that has no document to read yet answers without a block.
   */
  private async landed(
    pageId: string,
    fields: Record<string, unknown>,
    said: string,
  ): Promise<PageAnswer> {
    const committed = this.deps.committedUrl(pageId)
    let snapshot: SemanticSnapshot | null = null
    if (committed !== undefined && this.isPage(pageId)) {
      snapshot = await this.deps.snapshot(pageId).catch(() => null)
    }
    const origin = snapshot?.origin ?? this.originOf(pageId)
    return {
      structured: { page: pageId, origin, ...fields },
      text: `${said} ${pageId} on ${origin}${snapshot === null ? ', no snapshot yet' : `, ${snapshot.count} refs`}.`,
      ...(snapshot === null
        ? {}
        : { block: wrapUntrusted(snapshot.origin, semanticText(snapshot)) }),
    }
  }

  private acts(): PageActs {
    if (this.deps.acts === undefined) throw new Error('This cockpit does not act on pages')
    return this.deps.acts
  }

  /**
   * A ref's element, from a fresh snapshot of its page: refused when its
   * document is gone (the page navigated), when it is on another page than
   * `given`, and when the element left the page.
   */
  private async element(
    given: string | undefined,
    ref: string,
  ): Promise<{ page: Resolved; snapshot: SemanticSnapshot; node: SemanticNode }> {
    const resolved = this.deps.resolve(ref)
    if (resolved === null) throw new Error(`The ref ${ref} is not live: take a new snapshot`)
    if (given !== undefined && resolved.pageId !== this.pageOf(given)) {
      throw new Error(`The ref ${ref} is not on the page ${given}`)
    }
    const page = this.resolve(resolved.pageId)
    const snapshot = await this.deps.snapshot(page.pageId)
    const node = findNode(snapshot.nodes, ref)
    if (node === undefined) {
      throw new Error(`The element of ${ref} is no longer on the page: take a new snapshot`)
    }
    return { page, snapshot, node }
  }

  /**
   * Where an element is in the viewport now, in CSS pixels. The door's
   * `hints` read gives the box of an interactive element in view; any other
   * element is placed by the snapshot's page box less the scroll, which an
   * element both reads hold gives. An element whose centre is out of view
   * is refused: input at it would land on something else.
   */
  private async box(
    pageId: string,
    snapshot: SemanticSnapshot,
    node: SemanticNode,
  ): Promise<SemanticRect> {
    const acts = this.acts()
    const viewport = acts.viewport(pageId)
    if (viewport === null || viewport.width <= 0 || viewport.height <= 0) {
      throw new Error(`The page ${pageId} has not been shown yet, so it has no viewport to act in`)
    }
    const { nodes } = await acts.hints(pageId)
    const id = parseRef(node.ref)?.element
    let box: SemanticRect | undefined = nodes.find((one) => one.id === id)
    if (box === undefined) {
      const placed = new Map<number, SemanticRect>()
      for (const one of flatten(snapshot.nodes)) {
        const element = parseRef(one.ref)?.element
        if (element !== undefined) placed.set(element, one.rect)
      }
      const anchor = nodes.find((one) => placed.has(one.id))
      const at = anchor === undefined ? undefined : placed.get(anchor.id)
      if (anchor !== undefined && at !== undefined) {
        box = {
          x: node.rect.x - (at.x - anchor.x),
          y: node.rect.y - (at.y - anchor.y),
          width: node.rect.width,
          height: node.rect.height,
        }
      }
    }
    const centre = box === undefined ? undefined : centreOf(box)
    if (
      box === undefined ||
      centre === undefined ||
      centre.x < 0 ||
      centre.y < 0 ||
      centre.x >= viewport.width ||
      centre.y >= viewport.height
    ) {
      throw new Error(
        `The element of ${node.ref} is out of view: scroll it in with browser_press_key (PageDown, PageUp), then call again`,
      )
    }
    return box
  }

  /** A click or a hover at a ref's centre, then the page as it settled. */
  private async pointAt(
    given: string | undefined,
    ref: string,
    how: 'click' | 'hover',
    signal: AbortSignal | undefined,
  ): Promise<PageAnswer> {
    const { page, snapshot, node } = await this.element(given, ref)
    const at = centreOf(await this.box(page.pageId, snapshot, node))
    const settled = this.settle(page.pageId, signal)
    if (how === 'click') this.acts().click(page.pageId, at)
    else this.acts().hover(page.pageId, at)
    await settled
    return this.landed(
      page.pageId,
      { ref },
      how === 'click' ? `Clicked ${ref}:` : `Hovered over ${ref}:`,
    )
  }

  /**
   * Types into a field: refused when it is masked, focused by a click at its
   * centre, and typed into only once the door says the focus is on that very
   * field, so the text never lands anywhere else; Enter after it on `submit`.
   */
  private async type(
    given: string | undefined,
    ref: string,
    text: string,
    submit: boolean,
    signal: AbortSignal | undefined,
  ): Promise<PageAnswer> {
    const { page, snapshot, node } = await this.element(given, ref)
    if (isMasked(node)) throw new Error(MASKED_TYPE)
    const target = parseRef(ref)
    const acts = this.acts()
    acts.click(page.pageId, centreOf(await this.box(page.pageId, snapshot, node)))
    let focused = false
    for (let look = 0; look < FOCUS_LOOKS && !focused; look += 1) {
      if (look > 0) await this.sleep(FOCUS_LOOK_MS, signal).catch(() => undefined)
      const { answer, document } = await this.deps.form(page.pageId)
      if (document !== target?.document)
        throw new Error(`The ref ${ref} is not live: take a new snapshot`)
      const field = answer.fields.find((one) => one.id === answer.focused)
      if (field !== undefined && (field.flags & MASKED_FLAG) !== 0) throw new Error(MASKED_TYPE)
      focused = answer.focused === target.element
    }
    if (!focused) throw new Error(`The element of ${ref} did not take the focus: nothing was typed`)
    const settled = this.settle(page.pageId, signal)
    await acts.type(page.pageId, text)
    if (submit) acts.key(page.pageId, 'Enter')
    await settled
    return this.landed(
      page.pageId,
      { ref, submitted: submit },
      `Typed into ${ref}${submit ? ' and pressed Enter' : ''}:`,
    )
  }

  /**
   * Chooses options in a `<select>`: refused when it is masked, its values
   * matched against the options the door reads, and the indexes sent with
   * the option count, so a dropdown whose options changed since is refused
   * in the page rather than chosen in wrong.
   */
  private async selectOption(
    given: string | undefined,
    ref: string,
    values: readonly string[],
    signal: AbortSignal | undefined,
  ): Promise<PageAnswer> {
    const { page, node } = await this.element(given, ref)
    if (isMasked(node)) throw new Error(MASKED_SELECT)
    const { element, count, indexes } = await this.choices(page.pageId, ref, values)
    const settled = this.settle(page.pageId, signal)
    const { answer, document } = await this.selects().select(page.pageId, element, count, indexes)
    if (document !== parseRef(ref)?.document) {
      throw new Error(`The ref ${ref} is not live: take a new snapshot`)
    }
    if (answer.status !== 'ok') throw new Error(selectRefusal(answer.status, ref))
    await settled
    return this.landed(
      page.pageId,
      { ref, selected: answer.selected },
      `Chose ${indexes.length} option${indexes.length === 1 ? '' : 's'} in ${ref}:`,
    )
  }

  private selects(): PageSelects {
    if (this.deps.selects === undefined) throw new Error('This cockpit does not choose in pages')
    return this.deps.selects
  }

  /**
   * The indexes `values` name among a `<select>`'s options, as the door
   * reads them: each value is an option's value, else its label. Refused
   * when the element is no live `<select>`, a value names no option or a
   * disabled one, or a single-choice dropdown is given two.
   */
  private async choices(
    pageId: string,
    ref: string,
    values: readonly string[],
  ): Promise<{ element: number; count: number; indexes: readonly number[] }> {
    const target = parseRef(ref)
    if (target === null) throw new Error(`The ref ${ref} is not live: take a new snapshot`)
    const { answer, document } = await this.selects().options(pageId, target.element)
    if (document !== target.document) {
      throw new Error(`The ref ${ref} is not live: take a new snapshot`)
    }
    if (answer.status !== 'ok') throw new Error(selectRefusal(answer.status, ref))
    if (values.length === 0) throw new Error('Name at least one value to choose')
    const indexes: number[] = []
    for (const value of values) {
      let index = answer.options.findIndex((option) => option.value === value)
      if (index < 0) index = answer.options.findIndex((option) => option.label === value)
      const option = answer.options[index]
      if (option === undefined)
        throw new Error(`No option of ${ref} has the value or label "${value}"`)
      if (option.disabled === 1) throw new Error(`The option "${value}" of ${ref} is disabled`)
      if (!indexes.includes(index)) indexes.push(index)
    }
    if (answer.multiple === 0 && indexes.length > 1) {
      throw new Error(`The dropdown of ${ref} takes one choice: pass one value`)
    }
    return { element: target.element, count: answer.options.length, indexes }
  }

  private async pressKey(
    given: string | undefined,
    key: string,
    signal: AbortSignal | undefined,
  ): Promise<PageAnswer> {
    if (keyStroke(key) === null) throw new Error(`Not a key the page tier presses: ${key}`)
    const { pageId } = this.resolve(given)
    const settled = this.settle(pageId, signal)
    this.acts().key(pageId, key)
    await settled
    const origin = this.originOf(pageId)
    return {
      structured: { page: pageId, origin, key },
      text: `Pressed a key in ${pageId} on ${origin}.`,
    }
  }

  private async drag(
    given: string | undefined,
    startRef: string,
    endRef: string,
    signal: AbortSignal | undefined,
  ): Promise<PageAnswer> {
    const start = await this.element(given, startRef)
    const end = await this.element(given, endRef)
    if (start.page.pageId !== end.page.pageId) {
      throw new Error(`The refs ${startRef} and ${endRef} are on different pages`)
    }
    const pageId = start.page.pageId
    const from = centreOf(await this.box(pageId, start.snapshot, start.node))
    const to = centreOf(await this.box(pageId, end.snapshot, end.node))
    const settled = this.settle(pageId, signal)
    this.acts().drag(pageId, from, to)
    await settled
    return this.landed(pageId, {}, `Dragged ${startRef} onto ${endRef}:`)
  }

  /**
   * A PNG of the viewport, of one element's box cut to the viewport, or of
   * the whole page. The bytes are checked as a PNG and measured here; a page
   * that navigated while it was captured is refused.
   */
  private async screenshot(
    given: string | undefined,
    ref: string | undefined,
    fullPage: boolean,
  ): Promise<PageAnswer> {
    if (ref !== undefined && fullPage) throw new Error('Pass ref or fullPage, not both')
    const acts = this.acts()
    let page: Resolved
    let data: string
    if (ref !== undefined) {
      const found = await this.element(given, ref)
      page = found.page
      const box = await this.box(page.pageId, found.snapshot, found.node)
      const viewport = acts.viewport(page.pageId) ?? { width: 0, height: 0 }
      const x = Math.max(box.x, 0)
      const y = Math.max(box.y, 0)
      data = await acts.capture(page.pageId, {
        x,
        y,
        width: Math.min(box.x + box.width, viewport.width) - x,
        height: Math.min(box.y + box.height, viewport.height) - y,
      })
    } else {
      page = this.resolve(given)
      data = fullPage ? await acts.captureFull(page.pageId) : await acts.capture(page.pageId)
    }
    if (this.deps.committedUrl(page.pageId) !== page.url) {
      throw new Error('The page navigated while it was captured')
    }
    const { width, height } = pngSize(data)
    const what = ref !== undefined ? ref : fullPage ? 'the whole page' : 'the viewport'
    return {
      structured: { page: page.pageId, origin: page.origin, width, height },
      text: `A ${width} by ${height} PNG of ${what} of ${page.pageId} on ${page.origin}.`,
      image: data,
    }
  }

  /**
   * Resolves once an act's effect has settled: ACT_SETTLE_MS for the page
   * to start a navigation, and when it did, the end of that load, capped.
   * Listening starts before the act, so a quick load is not missed.
   */
  private async settle(pageId: string, signal: AbortSignal | undefined): Promise<void> {
    let started = false
    let stop = (): void => undefined
    const stopped = new Promise<'stopped'>((resolve) => {
      stop = () => resolve('stopped')
    })
    const off = this.deps.events((event) => {
      if (event.pageId !== pageId) return
      if (event.type === 'loading-started') started = true
      else if (started && (event.type === 'stopped' || event.type === 'failed')) stop()
    })
    try {
      await this.sleep(ACT_SETTLE_MS, signal).catch(() => undefined)
      if (started) await this.within(stopped, signal)
    } finally {
      off()
    }
  }

  /**
   * The elements a CSS selector matches, through the door's `query`: the
   * count and whether more matched than came back in the structure, each
   * match's ref and outer HTML in the block. A selector the page's engine
   * cannot parse, and a page whose secret field carries a value attribute,
   * are refused.
   */
  private async query(
    given: string | undefined,
    selector: string,
    limit: number,
  ): Promise<PageAnswer> {
    if (this.deps.query === undefined) throw new Error('This cockpit does not query pages')
    const { pageId, url, origin } = this.resolve(given)
    const { answer, document } = await this.deps.query(pageId, selector, limit)
    if (this.deps.committedUrl(pageId) !== url) {
      throw new Error('The page navigated while it was queried')
    }
    if (answer.status === 'invalid') {
      throw new Error('Not a selector the page can match: check its CSS syntax')
    }
    if (answer.status === 'masked') throw new Error(MASKED_QUERY)
    const truncated = answer.matched > answer.matches.length
    const parts = answer.matches.map(
      (match) =>
        `[${formatRef(document, match.id)}]\n${match.masked === 1 ? '(a secret field: no HTML, the human reads it)' : match.html}`,
    )
    return {
      structured: { page: pageId, origin, matched: answer.matched, truncated },
      text: `${answer.matched} elements of ${pageId} on ${origin} match${truncated ? `, the first ${answer.matches.length} given` : ''}.`,
      block: wrapUntrusted(origin, parts.length === 0 ? 'No element matches.' : parts.join('\n\n')),
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

/** The scheme of a URL as a refusal names it; never the rest, which can carry a secret. */
function schemeOf(url: string): string {
  try {
    return new URL(url).protocol
  } catch {
    return 'not a URL'
  }
}

/** Why the door refused an `options` read or a `select` (#141). */
function selectRefusal(status: Exclude<SelectStatus, 'ok'>, ref: string): string {
  switch (status) {
    case 'masked':
      return MASKED_SELECT
    case 'gone':
      return `The element of ${ref} is no longer on the page: take a new snapshot`
    case 'not-select':
      return `The element of ${ref} is not a <select>: open a custom dropdown with browser_click`
    case 'disabled':
      return `The dropdown of ${ref} is disabled`
    case 'changed':
      return `The options of ${ref} changed while it was chosen in: call again`
    case 'invalid':
      return `The dropdown of ${ref} cannot take that choice`
  }
}

const MASKED_STATE = 'masked'
const MASKED_FLAG = 1 << FORM_FLAGS.indexOf('masked')

/** A secret field by the one list of #94, as the snapshot marks it. */
function isMasked(node: SemanticNode): boolean {
  return node.state.includes(MASKED_STATE)
}

function flatten(nodes: readonly SemanticNode[]): SemanticNode[] {
  return nodes.flatMap((node) => [node, ...flatten(node.children)])
}

function findNode(nodes: readonly SemanticNode[], ref: string): SemanticNode | undefined {
  return flatten(nodes).find((node) => node.ref === ref)
}

function centreOf(box: SemanticRect): ViewportPoint {
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** A PNG's size from its header, or an error when the bytes are no PNG. */
export function pngSize(base64: string): { width: number; height: number } {
  const bytes = Buffer.from(base64, 'base64')
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error('The capture is not a PNG')
  }
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
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

function stringList(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : []
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}
