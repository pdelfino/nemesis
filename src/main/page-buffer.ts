import type { WebPreferences } from 'electron'
import type { AgentEvent, AgentEventListener } from './agent/events'
import type { BufferInfo, PageBounds, PageEvent, PageSpec } from '../shared/buffers'
import type { KeyPress } from '../shared/keys'
import type { BufferRegistry } from './buffers'
import { CommandError } from './commands/registry'
import type { PageBlocker } from './pages/blocker'
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
 * - Keys (#120): a main-process `before-input-event` listener on each page
 *   asks the cockpit's keymap, for the `page` buffer type and the page's
 *   modes, whether a key is the cockpit's. A bound key is consumed and
 *   dispatched, every other key goes to the page; no script runs in the
 *   page and the page never learns a binding. Every page is in `document`;
 *   `passthrough` goes in front of it on `C-z` and seals the layers below.
 * - Focus follows the current buffer: a page shown takes the keyboard, and
 *   a page hidden (a switch away, or the palette's null rectangle) gives it
 *   back to the cockpit.
 * - Blocker mode (#126): every page is attached to the blocker of
 *   pages/blocker.ts with the mode on, `toggle-blocker` turns it off and on,
 *   and the buffer carries the mode and the count of requests cancelled
 *   since the page last committed a URL, for the mode line. The first page
 *   starts the blocker's update schedule, so launch fetches nothing.
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

/** The mode every page buffer is in, and the one `C-z` puts in front of it (#120). */
export const DOCUMENT_MODE = 'document'
export const PASSTHROUGH_MODE = 'passthrough'

/** Chromium's zoom steps, as factors; Chromium's own menu walks the same list. */
const ZOOM_FACTORS = [
  0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5,
]
/** A zoom level is a power of 1.2: level 0 is 100 percent. */
const ZOOM_BASE = 1.2
/** A find longer than this is not one the user typed. */
const MAX_FIND = 1000

/** The part of Electron's `Input` a page's key listener reads. */
export interface PageInput {
  readonly type: string
  readonly key: string
  readonly code: string
  readonly shift: boolean
  readonly control: boolean
  readonly alt: boolean
  readonly meta: boolean
  readonly isComposing?: boolean
}

/** How `document` mode moves a page: synthesized keys, never a page script. */
export type PageScroll = 'page-down' | 'page-up' | 'line-down' | 'line-up' | 'top' | 'bottom'

/** The key Chromium scrolls on for each move, as `sendInputEvent` spells it. */
const SCROLL_KEYS: Readonly<Record<PageScroll, string>> = {
  'page-down': 'PageDown',
  'page-up': 'PageUp',
  'line-down': 'Down',
  'line-up': 'Up',
  top: 'Home',
  bottom: 'End',
}

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
  on(
    event: 'before-input-event',
    listener: (event: { preventDefault(): void }, input: PageInput) => void,
  ): unknown
  off(event: string, listener: (...args: never[]) => void): unknown
  loadURL(url: string): Promise<void>
  reload(): void
  getURL(): string
  isDestroyed(): boolean
  close(): void
  focus(): void
  /** Chromium's zoom, kept per origin in the session's zoom level store. */
  getZoomLevel(): number
  setZoomLevel(level: number): void
  findInPage(text: string): number
  stopFindInPage(action: 'clearSelection' | 'keepSelection' | 'activateSelection'): void
  copy(): void
  sendInputEvent(event: { readonly type: 'keyDown' | 'keyUp'; readonly keyCode: string }): void
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
  /** Gives the keyboard back to the cockpit's own page, when no page shows (#120). */
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
  /**
   * The cockpit's keymap, asked on every key typed in a page (#120): true
   * when the cockpit binds it in these modes and has taken it, false when the
   * page should have it. Absent, every key is the page's.
   */
  readonly keys?: (press: KeyPress, modes: readonly string[]) => boolean
  /** The blocker every page is attached to (#126). Absent, no page has blocker mode. */
  readonly blocker?: PageBlocker
}

/** The current page as bookmark-page reads it (#125). */
export interface CurrentPage {
  readonly url: string
  readonly title: string
  readonly partition: NonNullable<PageSpec['partition']>
}

/** What the commands ask of the page buffers; a window without them refuses (keyscheme.ts). */
export interface PageCommands {
  /**
   * Opens `url`, as url-sources.ts resolved it (#124): in the current page
   * buffer when the current buffer is a page and `newBuffer` is not set,
   * else in a new page buffer made current. A refused URL opens nothing.
   */
  open(url: string, newBuffer?: boolean): Promise<void>
  /** The current page buffer reloads, goes back or goes forward. */
  reload(): void
  back(): void
  forward(): void
  /** `document` mode on the current page buffer (#120). */
  scroll(how: PageScroll): void
  /** Finds `text` in the page, the next match on a repeat; empty clears the find. */
  find(text: string): void
  /** One of Chromium's zoom steps in or out, for the page's origin. */
  zoom(by: 1 | -1): void
  /** The page's selection to the clipboard. */
  copy(): void
  /** Puts `passthrough` in front of `document`, or takes it off. */
  togglePassthrough(): void
  /** Blocker mode off or on for the current page buffer (#126). */
  toggleBlocker(): void
  /** The current page buffer's committed URL, its title and its partition (#125). */
  currentPage(): CurrentPage
}

const noPages = (): never => {
  throw new CommandError('No page buffers in this window')
}

/** Without a window there is no view to hold a page. */
export const NO_PAGES: PageCommands = {
  open: () => Promise.reject(new CommandError('No page buffers in this window')),
  reload: noPages,
  back: noPages,
  forward: noPages,
  scroll: noPages,
  find: noPages,
  zoom: noPages,
  copy: noPages,
  togglePassthrough: noPages,
  toggleBlocker: noPages,
  currentPage: noPages,
}

export type PageEventListener = (event: PageEvent) => void

interface Page<V extends PageView> {
  readonly id: string
  readonly view: V
  /** Every listener this module put on the contents, for destroy to take off. */
  readonly listeners: (readonly [string, (...args: never[]) => void])[]
  attached: boolean
  /** The page's modes, first wins: `document`, with `passthrough` in front while on. */
  modes: readonly string[]
  /** The text of the last find, so a repeat steps to the next match. */
  found: string
  /** The partition of #54 the page lives in; the history never records `ephemeral` (#125). */
  readonly partition: NonNullable<PageSpec['partition']>
  /** Blocker mode, on from creation when the window has a blocker (#126). */
  blocker: boolean
  /** Requests the blocker cancelled since the page last committed a URL. */
  blocked: number
}

/** A zoom level as the percentage the mode line shows. */
export function zoomPercent(level: number): number {
  return Math.round(100 * ZOOM_BASE ** level)
}

/** The zoom level one Chromium step from `level`, in or out, kept inside the steps. */
export function nextZoomLevel(level: number, by: 1 | -1): number {
  const factor = ZOOM_BASE ** level
  const steps = by === 1 ? ZOOM_FACTORS : [...ZOOM_FACTORS].reverse()
  // A level set by Chromium itself can sit between steps; the next one past it wins.
  const next =
    steps.find((step) => (by === 1 ? step > factor + 1e-6 : step < factor - 1e-6)) ?? steps.at(-1)
  return Math.log(next ?? 1) / Math.log(ZOOM_BASE)
}

/** A key typed in a page, read as the cockpit reads a key from its own renderer. */
export function pressFromInput(input: PageInput): KeyPress | null {
  if (input.type !== 'keyDown' || input.isComposing === true) return null
  if (typeof input.key !== 'string' || input.key.length === 0 || input.key.length > 32) return null
  return {
    key: input.key,
    code: typeof input.code === 'string' ? input.code.slice(0, 32) : '',
    ctrlKey: input.control === true,
    altKey: input.alt === true,
    shiftKey: input.shift === true,
    metaKey: input.meta === true,
    bufferType: 'page',
  }
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
  /** The page that has the keyboard, so focus moves only when the shown page changes. */
  private focused: string | null = null

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
    const partitionName = spec.partition ?? 'persistent'
    const partition = PARTITIONS[partitionName]
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
    const page: Page<V> = {
      id: buffer.id,
      view,
      listeners: [],
      attached: false,
      modes: [DOCUMENT_MODE],
      found: '',
      partition: partitionName,
      blocker: this.options.blocker !== undefined,
      blocked: 0,
    }
    this.pages.set(buffer.id, page)
    this.options.buffers.update(buffer.id, {
      modes: page.modes,
      zoom: zoomPercent(contents.getZoomLevel()),
      ...(page.blocker ? { blocker: true, blocked: 0 } : {}),
    })
    const blocker = this.options.blocker
    if (blocker !== undefined) {
      blocker.attach(contents.id, {
        url: () => (contents.isDestroyed() ? '' : contents.getURL()),
        blocked: () => this.countBlocked(page),
      })
      blocker.start()
    }
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
    this.options.blocker?.detach(contents.id)
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

  async open(url: string, newBuffer = false): Promise<void> {
    if (this.allowed(url) === null) return
    const current = this.options.buffers.current
    if (!newBuffer && current !== null && this.pages.has(current.id)) {
      await this.load(current.id, url)
      return
    }
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

  scroll(how: PageScroll): void {
    const contents = this.current().view.webContents
    const keyCode = SCROLL_KEYS[how]
    contents.sendInputEvent({ type: 'keyDown', keyCode })
    contents.sendInputEvent({ type: 'keyUp', keyCode })
  }

  find(text: string): void {
    const page = this.current()
    const contents = page.view.webContents
    const wanted = text.slice(0, MAX_FIND)
    if (wanted.length === 0) {
      page.found = ''
      contents.stopFindInPage('clearSelection')
      return
    }
    // A repeat of the same text steps to the next match, as C-s C-s does.
    if (wanted !== page.found) contents.stopFindInPage('clearSelection')
    page.found = wanted
    contents.findInPage(wanted)
  }

  zoom(by: 1 | -1): void {
    const contents = this.current().view.webContents
    contents.setZoomLevel(nextZoomLevel(contents.getZoomLevel(), by))
    // Chromium zooms every page of the origin in this session, so every page is read again.
    this.readZoom()
  }

  copy(): void {
    this.current().view.webContents.copy()
  }

  togglePassthrough(): void {
    const page = this.current()
    page.modes = page.modes.includes(PASSTHROUGH_MODE)
      ? page.modes.filter((mode) => mode !== PASSTHROUGH_MODE)
      : [PASSTHROUGH_MODE, ...page.modes]
    this.options.buffers.update(page.id, { modes: page.modes })
  }

  toggleBlocker(): void {
    const blocker = this.options.blocker
    if (blocker === undefined) throw new CommandError('This window has no blocker')
    const page = this.current()
    page.blocker = !page.blocker
    blocker.enable(page.view.webContents.id, page.blocker)
    this.options.buffers.update(page.id, { blocker: page.blocker })
  }

  /** The partition of a page buffer, or undefined for an id that holds no page. */
  partitionOf(id: string): NonNullable<PageSpec['partition']> | undefined {
    return this.pages.get(id)?.partition
  }

  /** The URL, title and partition of the current page buffer, for bookmark-page (#125). */
  currentPage(): CurrentPage {
    const page = this.current()
    const buffer = this.options.buffers.get(page.id)
    if (buffer?.url === undefined) throw new CommandError('The page has not loaded a URL yet')
    return { url: buffer.url, title: buffer.title, partition: page.partition }
  }

  /** The modes of a page buffer, first wins; empty for an id that holds no page. */
  modesOf(id: string): readonly string[] {
    return this.pages.get(id)?.modes ?? []
  }

  /** One more request the blocker cancelled for the page, into the buffer list. */
  private countBlocked(page: Page<V>): void {
    if (!this.pages.has(page.id)) return
    page.blocked += 1
    this.options.buffers.update(page.id, { blocked: page.blocked })
  }

  /** Every page's zoom into the buffer list, as Chromium holds it per origin now. */
  private readZoom(): void {
    for (const page of this.pages.values()) {
      const contents = page.view.webContents
      if (contents.isDestroyed()) continue
      this.options.buffers.update(page.id, { zoom: zoomPercent(contents.getZoomLevel()) })
    }
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

  /**
   * Attaches the current page at the reported rectangle and detaches every
   * other. The keyboard goes to a page when it starts to show, and back to
   * the cockpit when no page shows any more.
   */
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
    if (shown === undefined || this.bounds === null) {
      if (this.focused !== null) {
        this.focused = null
        this.options.host.focusCockpit()
      }
      return
    }
    if (!shown.attached) {
      this.options.host.addChildView(shown.view)
      shown.attached = true
    }
    shown.view.setBounds(this.bounds)
    if (this.focused !== shown.id) {
      this.focused = shown.id
      shown.view.webContents.focus()
    }
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

    // The cockpit's keys first (#120): a key bound in the page's modes never
    // reaches the page. The listener runs in the main process; nothing of
    // the keymap crosses into the page.
    const typed = (event: { preventDefault(): void }, input: PageInput): void => {
      const keys = this.options.keys
      const press = pressFromInput(input)
      if (keys === undefined || press === null) return
      if (keys(press, this.modesOf(pageId))) event.preventDefault()
    }
    contents.on('before-input-event', typed)
    add('before-input-event', typed)
  }

  /** The registry follows the stream: the committed URL and the title; a failure is a notice. */
  private emit(event: PageEvent): void {
    const buffers = this.options.buffers
    if (!this.pages.has(event.pageId) || buffers.get(event.pageId) === undefined) return
    switch (event.type) {
      case 'committed': {
        // Chromium keeps the zoom per origin: a new origin may bring its own.
        this.readZoom()
        // The count is the page's: a new document starts at none.
        const page = this.pages.get(event.pageId)
        if (page !== undefined && this.options.blocker !== undefined) {
          page.blocked = 0
          buffers.update(event.pageId, { blocked: 0 })
        }
        break
      }
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
