import type { WebPreferences } from 'electron'
import type { AgentEvent, AgentEventListener } from './agent/events'
import type { BufferInfo, PageBounds, PageEvent, PageSpec } from '../shared/buffers'
import type { BufferRegistry } from './buffers'
import { CommandError } from './commands/registry'
import { navigationAllowed } from './security/navigation-policy'
import { hostOf, upgradeOf } from './security/transport'
import { HARDENED_WEB_PREFERENCES } from './security/web-preferences'

/**
 * The page buffers of one cockpit (#119, study 07 items 1 to 3): a buffer kind
 * that holds a web page, on a `WebContentsView` the main process creates
 * (SECURITY.org T1), under the whole baseline.
 *
 * - `createPage` builds the view with HARDENED_WEB_PREFERENCES and no preload,
 *   in `persist:default` unless the spec asks for `ephemeral` (#54), and runs
 *   the navigation policy (#48), the transport watch (#52) and the permission
 *   policy (#49) before the first load. `web-contents-created` has already
 *   applied all three; applying them here again is a no-op by their own
 *   contract, and it is what keeps this creation site correct on its own.
 * - `load`, `reload`, `back` and `forward` ask `navigationAllowed('page', url)`
 *   and `upgradeOf` first, because `loadURL` raises no `will-navigate` for
 *   the policies to see. A refusal is a notice, never a throw.
 * - One event stream per page, read off the WebContents and checked here
 *   before the registry or a listener sees it (#53). The URL a buffer shows
 *   is the committed top-frame URL (T3), never the one a navigation started
 *   on.
 * - The page of the current buffer is attached to the window's content view
 *   at the rectangle the renderer reports, and every other page is detached,
 *   its state, history and scroll kept. No rectangle (the palette is open, or
 *   the renderer has not laid out the page section yet) attaches nothing.
 *
 * The module holds no Electron value: the view, the window's content view and
 * the policies come in through `PageBuffersOptions`, so the unit tests drive
 * it on fakes.
 */

/** The partitions of #54, by name; src/main/security/partitions.ts owns them. */
const PARTITIONS: Readonly<Record<NonNullable<PageSpec['partition']>, string>> = {
  persistent: 'persist:default',
  ephemeral: 'ephemeral',
}

/** Where every page buffer's section is in the renderer. */
export const PAGE_ELEMENT_ID = 'page'

/** A URL longer than this is not one a page buffer takes, from the user or from the page. */
const MAX_URL = 8192
/** Matches the registry's limit; a longer title is cut there. */
const MAX_TITLE = 200
/** Chromium's ERR_ABORTED: a load replaced by another navigation, which reports itself. */
const ERR_ABORTED = -3
/** A rectangle past this, in CSS pixels, is no window's. */
const MAX_EXTENT = 100_000

/** What a redirect reports, the part of Electron's event a page buffer reads. */
export interface RedirectDetails {
  readonly url: string
  readonly isMainFrame: boolean
}

/** The minimum of a WebContents a page buffer drives; a fake satisfies it in the unit tests. */
export interface PageContents {
  readonly id: number
  on(event: 'did-start-loading' | 'did-finish-load', listener: () => void): unknown
  on(event: 'did-navigate', listener: (event: unknown, url: string) => void): unknown
  on(
    event: 'did-navigate-in-page',
    listener: (event: unknown, url: string, isMainFrame: boolean) => void,
  ): unknown
  on(event: 'page-title-updated', listener: (event: unknown, title: string) => void): unknown
  on(
    event: 'did-fail-load',
    listener: (
      event: unknown,
      errorCode: number,
      errorDescription: string,
      validatedURL: string,
      isMainFrame: boolean,
    ) => void,
  ): unknown
  on(event: 'did-redirect-navigation', listener: (details: RedirectDetails) => void): unknown
  off(event: string, listener: (...args: never[]) => void): unknown
  loadURL(url: string): Promise<void>
  reload(): void
  getURL(): string
  isDestroyed(): boolean
  close(): void
  readonly navigationHistory: {
    canGoBack(): boolean
    canGoForward(): boolean
    goBack(): void
    goForward(): void
    getActiveIndex(): number
    getEntryAtIndex(index: number): { readonly url: string } | null
  }
}

/** The minimum of a WebContentsView a page buffer needs. */
export interface PageView {
  readonly webContents: PageContents
  setBounds(bounds: PageBounds): void
}

/** The window's content view, where the current page's view is attached. */
export interface PageHost<V extends PageView> {
  addChildView(view: V): void
  removeChildView(view: V): void
  /**
   * Gives the keyboard back to the cockpit's own page. Keys and focus inside
   * a page are M4.2's (#120); until then a page shown takes no keys from the
   * cockpit, so `C-x k` and `M-x` reach the page buffer.
   */
  focusCockpit(): void
}

/** The baseline a page buffer runs under, applied before its first load. */
export interface PagePolicies<V extends PageView> {
  /** `applyNavigationPolicy(contents, 'page')` (#48). */
  navigation(contents: V['webContents']): void
  /** The upgrade of plain `http:` off loopback (#52). */
  transport(contents: V['webContents']): void
  /** The deny-by-default handlers on the page's session and its chooser (#49). */
  permissions(contents: V['webContents']): void
}

export interface PageBuffersOptions<V extends PageView> {
  readonly buffers: BufferRegistry
  /** Builds the view; in the app, `new WebContentsView({ webPreferences })`. */
  readonly createView: (webPreferences: WebPreferences) => V
  readonly host: PageHost<V>
  readonly policies: PagePolicies<V>
}

/** What the commands ask of the page buffers; a window without them refuses (keyscheme.ts). */
export interface PageCommands {
  /** Opens `text` as a page buffer and makes it current; a refused URL opens nothing. */
  open(text: string): Promise<void>
  /** The current page buffer reloads, goes back or goes forward. */
  reload(): void
  back(): void
  forward(): void
}

/** Without a window there is no view to hold a page. */
export const NO_PAGES: PageCommands = {
  open: () => Promise.reject(new CommandError('No page buffers in this window')),
  reload: () => {
    throw new CommandError('No page buffers in this window')
  },
  back: () => {
    throw new CommandError('No page buffers in this window')
  },
  forward: () => {
    throw new CommandError('No page buffers in this window')
  },
}

export type PageEventListener = (event: PageEvent) => void

interface Page<V extends PageView> {
  readonly id: string
  readonly view: V
  /** Every listener this module put on the contents, for destroy to take off. */
  readonly listeners: (readonly [string, (...args: never[]) => void])[]
  attached: boolean
}

/** A string the page sent that may stand as a URL: bounded and parseable, or null. */
function boundedUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_URL) return null
  try {
    return new URL(raw).href
  } catch {
    return null
  }
}

/** A title the page sent, one line and bounded. */
function boundedTitle(raw: unknown): string {
  return typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE) : ''
}

/** The scheme of a URL as a refusal names it; never the rest, which can carry a secret. */
function schemeOf(url: string): string {
  try {
    return new URL(url).protocol
  } catch {
    return 'not a URL'
  }
}

/**
 * What the user typed at `open-url`, as a URL: kept when it names a scheme,
 * else read as an `https:` host, as a browser's address bar does.
 */
export function urlFromInput(text: string): string {
  const trimmed = text.trim()
  return /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`
}

/**
 * The rectangle the renderer reported, checked at the boundary (#53): null,
 * or four finite numbers inside any window, rounded to whole pixels.
 */
export function parsePageBounds(payload: unknown): PageBounds | null {
  if (payload === null) return null
  if (typeof payload !== 'object') throw new TypeError('Page bounds are not an object')
  const value = payload as Record<string, unknown>
  const read = (key: string, min: number): number => {
    const one = value[key]
    if (typeof one !== 'number' || !Number.isFinite(one) || one < min || one > MAX_EXTENT) {
      throw new TypeError(`Page bounds have no usable ${key}`)
    }
    return Math.round(one)
  }
  return { x: read('x', 0), y: read('y', 0), width: read('width', 0), height: read('height', 0) }
}

export class PageBuffers<V extends PageView> implements PageCommands {
  private readonly pages = new Map<string, Page<V>>()
  private readonly notices = new Set<AgentEventListener>()
  private readonly streams = new Set<PageEventListener>()
  private bounds: PageBounds | null = null

  constructor(private readonly options: PageBuffersOptions<V>) {
    // A kill from anywhere, `C-x k` or the palette, destroys the page, and a
    // switch shows the current page and hides the rest.
    options.buffers.subscribe((list) => {
      const alive = new Set(list.buffers.map((buffer) => buffer.id))
      for (const id of [...this.pages.keys()]) if (!alive.has(id)) this.destroyPage(id)
      this.show()
    })
  }

  /** The cockpit's notices: a refused URL, a failed load. */
  on(listener: AgentEventListener): () => void {
    this.notices.add(listener)
    return () => {
      this.notices.delete(listener)
    }
  }

  /** Every page's event stream, after the checks. */
  onPageEvent(listener: PageEventListener): () => void {
    this.streams.add(listener)
    return () => {
      this.streams.delete(listener)
    }
  }

  /** The page buffers, in creation order. */
  list(): readonly BufferInfo[] {
    return this.options.buffers.list().filter((buffer) => this.pages.has(buffer.id))
  }

  /** The view of a page buffer, for the specs that reach its contents. */
  viewOf(id: string): V | undefined {
    return this.pages.get(id)?.view
  }

  /**
   * Builds a page buffer under the baseline and, when the spec names a URL,
   * loads it. The buffer is not made current here; `open` does that.
   */
  createPage(spec: PageSpec = {}): BufferInfo {
    const partition = PARTITIONS[spec.partition ?? 'persistent']
    // No preload: the bridge belongs to internal pages only (T1, ADR 0009 for any later door).
    const view = this.options.createView({ ...HARDENED_WEB_PREFERENCES, partition })
    const contents = view.webContents
    const { policies } = this.options
    policies.navigation(contents)
    policies.transport(contents)
    policies.permissions(contents)

    const buffer = this.options.buffers.create({
      kind: 'page',
      title: spec.url === undefined ? 'Page' : hostOf(spec.url),
      elementId: PAGE_ELEMENT_ID,
    })
    const page: Page<V> = { id: buffer.id, view, listeners: [], attached: false }
    this.pages.set(buffer.id, page)
    this.listen(page)
    if (spec.url !== undefined) void this.load(buffer.id, spec.url)
    return buffer
  }

  /** Closes the page's contents, takes its view off the window and every listener off the contents. */
  destroyPage(id: string): void {
    const page = this.pages.get(id)
    if (page === undefined) return
    this.pages.delete(id)
    const contents = page.view.webContents
    for (const [event, listener] of page.listeners) contents.off(event, listener)
    page.listeners.length = 0
    if (page.attached) {
      this.options.host.removeChildView(page.view)
      page.attached = false
    }
    if (!contents.isDestroyed()) contents.close()
    if (this.options.buffers.get(id) !== undefined) this.options.buffers.kill(id)
  }

  /** Every page, when the window closes. */
  destroyAll(): void {
    for (const id of [...this.pages.keys()]) this.destroyPage(id)
  }

  /**
   * Loads `url` in a page buffer: refused unless `navigationAllowed('page')`,
   * re-issued on `https:` when transport would upgrade it. Answers null when
   * the load committed, else the reason, which a refusal has also said as a
   * notice; a load that failed says so through its `failed` event.
   */
  async load(id: string, url: string): Promise<string | null> {
    const page = this.pages.get(id)
    if (page === undefined) return `No page buffer with id "${id}"`
    const target = this.allowed(url)
    if (target === null) return 'refused'
    try {
      await page.view.webContents.loadURL(target)
      return null
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
  }

  /** The renderer's content area, or null; applied to the current page at once. */
  setBounds(bounds: PageBounds | null): void {
    this.bounds = bounds
    this.show()
  }

  async open(text: string): Promise<void> {
    const url = urlFromInput(text)
    if (this.allowed(url) === null) return
    const buffer = this.createPage()
    this.options.buffers.switchTo(buffer.id)
    await this.load(buffer.id, url)
  }

  reload(): void {
    const page = this.current()
    const contents = page.view.webContents
    const target = this.allowed(contents.getURL())
    if (target === null) return
    if (target !== contents.getURL()) void this.load(page.id, target)
    else contents.reload()
  }

  back(): void {
    this.step(-1)
  }

  forward(): void {
    this.step(1)
  }

  private step(by: -1 | 1): void {
    const page = this.current()
    const history = page.view.webContents.navigationHistory
    if (by === -1 ? !history.canGoBack() : !history.canGoForward()) {
      this.notify(by === -1 ? 'No page to go back to' : 'No page to go forward to')
      return
    }
    const entry = history.getEntryAtIndex(history.getActiveIndex() + by)
    const target = this.allowed(entry?.url ?? '')
    if (target === null) return
    if (target !== entry?.url) void this.load(page.id, target)
    else if (by === -1) history.goBack()
    else history.goForward()
  }

  /** The current buffer's page, or a CommandError when the current buffer holds none. */
  private current(): Page<V> {
    const current = this.options.buffers.current
    const page = current === null ? undefined : this.pages.get(current.id)
    if (page === undefined) throw new CommandError('The current buffer is not a page')
    return page
  }

  /**
   * The URL to load for `url`: itself, its `https:` upgrade, or null after a
   * notice when the page policy refuses it. The notice names the scheme, never
   * the URL.
   */
  private allowed(url: string): string | null {
    const bounded = url.length <= MAX_URL ? url : ''
    if (!navigationAllowed('page', bounded)) {
      this.notify(
        `Not opened: ${schemeOf(bounded)} is not a page URL; a page buffer opens http: and https: only (SECURITY.org, T3)`,
      )
      return null
    }
    return upgradeOf(bounded) ?? bounded
  }

  /** Attaches the current page at the reported rectangle and detaches every other. */
  private show(): void {
    const current = this.options.buffers.current
    const shown =
      current !== null && current.kind === 'page' && this.bounds !== null
        ? this.pages.get(current.id)
        : undefined
    for (const page of this.pages.values()) {
      if (page !== shown && page.attached) {
        this.options.host.removeChildView(page.view)
        page.attached = false
      }
    }
    if (shown === undefined || this.bounds === null) return
    if (!shown.attached) {
      this.options.host.addChildView(shown.view)
      shown.attached = true
      this.options.host.focusCockpit()
    }
    shown.view.setBounds(this.bounds)
  }

  /** The event stream of one page, each event checked before it is acted on. */
  private listen(page: Page<V>): void {
    const contents = page.view.webContents
    const pageId = page.id
    const add = (event: string, listener: (...args: never[]) => void): void => {
      page.listeners.push([event, listener])
    }

    const started = (): void => this.emit({ type: 'loading-started', pageId })
    contents.on('did-start-loading', started)
    add('did-start-loading', started)

    const finished = (): void => this.emit({ type: 'finished', pageId })
    contents.on('did-finish-load', finished)
    add('did-finish-load', finished)

    const navigated = (_event: unknown, raw: string): void => {
      const url = boundedUrl(raw)
      if (url === null) return
      this.emit({ type: 'committed', pageId, url })
      this.emit({ type: 'url-changed', pageId, url })
    }
    contents.on('did-navigate', navigated)
    add('did-navigate', navigated)

    const inPage = (_event: unknown, raw: string, isMainFrame: boolean): void => {
      const url = boundedUrl(raw)
      if (isMainFrame !== true || url === null) return
      this.emit({ type: 'url-changed', pageId, url })
    }
    contents.on('did-navigate-in-page', inPage)
    add('did-navigate-in-page', inPage)

    const titled = (_event: unknown, raw: string): void => {
      const title = boundedTitle(raw)
      if (title.length > 0) this.emit({ type: 'title-changed', pageId, title })
    }
    contents.on('page-title-updated', titled)
    add('page-title-updated', titled)

    const failed = (
      _event: unknown,
      code: number,
      description: string,
      raw: string,
      isMainFrame: boolean,
    ): void => {
      if (isMainFrame !== true || typeof code !== 'number' || code === ERR_ABORTED) return
      const url = boundedUrl(raw) ?? ''
      const reason = boundedTitle(description) || `error ${code}`
      this.emit({ type: 'failed', pageId, url, code, reason })
    }
    contents.on('did-fail-load', failed)
    add('did-fail-load', failed)

    const redirected = (details: RedirectDetails): void => {
      const url = boundedUrl(details.url)
      if (details.isMainFrame !== true || url === null) return
      this.emit({ type: 'redirect', pageId, url })
    }
    contents.on('did-redirect-navigation', redirected)
    add('did-redirect-navigation', redirected)
  }

  /** The registry follows the stream: the committed URL and the title; a failure is a notice. */
  private emit(event: PageEvent): void {
    const buffers = this.options.buffers
    if (!this.pages.has(event.pageId) || buffers.get(event.pageId) === undefined) return
    switch (event.type) {
      case 'committed':
        // Chromium hands the keyboard to a page that commits; the cockpit
        // keeps it until keys inside a page exist (M4.2, #120).
        if (this.pages.get(event.pageId)?.attached === true) this.options.host.focusCockpit()
        break
      case 'url-changed': {
        const before = buffers.get(event.pageId)
        // A page with no title of its own is named by its host.
        const untitled = before?.url === undefined || before.title === hostOf(before.url)
        buffers.update(event.pageId, {
          url: event.url,
          ...(untitled ? { title: hostOf(event.url) } : {}),
        })
        break
      }
      case 'title-changed':
        buffers.update(event.pageId, { title: event.title })
        break
      case 'failed':
        this.notify(`Could not load ${hostOf(event.url)}: ${event.reason}`)
        break
      default:
        break
    }
    for (const listener of this.streams) listener(event)
  }

  private notify(text: string): void {
    const event: AgentEvent = { type: 'notice', text }
    for (const listener of this.notices) listener(event)
  }
}
