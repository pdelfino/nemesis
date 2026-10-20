import { describe, expect, it } from 'vitest'
import type { WebPreferences } from 'electron'
import type { AgentEvent } from '../../src/main/agent/events'
import { BufferRegistry } from '../../src/main/buffers'
import { HookRegistry } from '../../src/main/hooks'
import {
  installSwipe,
  nextZoomLevel,
  PAGE_PRELOAD,
  PageBuffers,
  parsePageBounds,
  pressFromInput,
  zoomPercent,
  type PageContents,
  type PageInput,
  type PageView,
  type RedirectDetails,
  keyStroke,
} from '../../src/main/page-buffer'
import type { KeyPress } from '../../src/shared/keys'
import type { BlockedPage, PageBlocker } from '../../src/main/pages/blocker'
import { HARDENED_WEB_PREFERENCES } from '../../src/main/security/web-preferences'
import type { PageBounds, PageEvent } from '../../src/shared/buffers'

/**
 * The page buffers (#119) on fakes for the view, the contents and the
 * window's content view: the baseline is applied before the first load, a
 * refused URL is a notice and never a throw, the buffer list follows the
 * committed URL and the title, one page view shows at a time, and destroy
 * leaves no listener behind. The live run is tests/e2e/page.spec.ts.
 */

type Listener = (...args: never[]) => void

class FakeContents implements PageContents {
  static next = 1
  readonly id = FakeContents.next++
  readonly listeners = new Map<string, Set<Listener>>()
  readonly loads: string[] = []
  url = ''
  closed = false
  reloads = 0
  failNextLoad: Error | null = null
  readonly entries: string[] = []
  index = -1
  readonly navigationHistory = {
    canGoBack: () => this.index > 0,
    canGoForward: () => this.index < this.entries.length - 1,
    goBack: () => {
      this.index -= 1
      this.log.push(`back ${this.entries[this.index]}`)
    },
    goForward: () => {
      this.index += 1
      this.log.push(`forward ${this.entries[this.index]}`)
    },
    getActiveIndex: () => this.index,
    getEntryAtIndex: (index: number) => {
      const url = this.entries[index]
      return url === undefined ? null : { url }
    },
  }

  constructor(private readonly log: string[]) {}

  on(event: string, listener: Listener): this {
    let set = this.listeners.get(event)
    if (set === undefined) {
      set = new Set()
      this.listeners.set(event, set)
    }
    set.add(listener)
    return this
  }

  off(event: string, listener: Listener): this {
    this.listeners.get(event)?.delete(listener)
    return this
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) {
      ;(listener as (...values: unknown[]) => void)(...args)
    }
  }

  listenerCount(): number {
    return [...this.listeners.values()].reduce((sum, set) => sum + set.size, 0)
  }

  loadURL(url: string): Promise<void> {
    this.log.push(`load ${url}`)
    this.loads.push(url)
    const failure = this.failNextLoad
    this.failNextLoad = null
    if (failure !== null) return Promise.reject(failure)
    this.url = url
    return Promise.resolve()
  }

  reload(): void {
    this.reloads += 1
  }

  getURL(): string {
    return this.url
  }

  isDestroyed(): boolean {
    return this.closed
  }

  close(): void {
    this.closed = true
  }

  zoomLevel = 0
  readonly found: string[] = []
  readonly sent: string[] = []

  focus(): void {
    this.log.push(`focus page ${this.id}`)
  }

  getZoomLevel(): number {
    return this.zoomLevel
  }

  setZoomLevel(level: number): void {
    this.zoomLevel = level
  }

  findInPage(text: string): number {
    this.found.push(text)
    return this.found.length
  }

  stopFindInPage(action: string): void {
    this.found.push(`stop ${action}`)
  }

  copy(): void {
    this.log.push(`copy ${this.id}`)
  }

  selectAll(): void {
    this.sent.push('selectAll')
  }

  insertText(text: string): Promise<void> {
    this.sent.push(`insertText ${text}`)
    return Promise.resolve()
  }

  sendInputEvent(
    event:
      | { readonly type: string; readonly keyCode: string }
      | { readonly type: string; readonly x: number; readonly y: number },
  ): void {
    this.sent.push(
      'keyCode' in event ? `${event.type} ${event.keyCode}` : `${event.type} ${event.x},${event.y}`,
    )
  }

  /** Types a key down in the page; true when the cockpit took it. */
  type(input: Partial<PageInput> & { readonly key: string }): boolean {
    let prevented = false
    this.emit(
      'before-input-event',
      { preventDefault: () => (prevented = true) },
      {
        type: 'keyDown',
        code: '',
        shift: false,
        control: false,
        alt: false,
        meta: false,
        ...input,
      },
    )
    return prevented
  }
}

class FakeView implements PageView {
  readonly webContents: FakeContents
  bounds: PageBounds | null = null

  constructor(
    readonly webPreferences: WebPreferences,
    log: string[],
  ) {
    this.webContents = new FakeContents(log)
  }

  setBounds(bounds: PageBounds): void {
    this.bounds = bounds
  }
}

interface Rig {
  readonly buffers: BufferRegistry
  readonly pages: PageBuffers<FakeView>
  readonly views: FakeView[]
  readonly attached: Set<FakeView>
  readonly log: string[]
  readonly notices: string[]
  readonly events: PageEvent[]
}

function rig(
  keys?: (press: KeyPress, modes: readonly string[]) => boolean,
  blocker?: PageBlocker,
  console?: (pageId: string, level: string, message: string) => void,
  defaultModes?: () => readonly string[],
  hooks?: HookRegistry,
): Rig {
  const buffers = new BufferRegistry()
  buffers.create({ kind: 'transcript', title: 'Transcript', elementId: 'transcript' })
  const views: FakeView[] = []
  const attached = new Set<FakeView>()
  const log: string[] = []
  const pages = new PageBuffers<FakeView>({
    buffers,
    createView: (webPreferences) => {
      const view = new FakeView(webPreferences, log)
      views.push(view)
      return view
    },
    host: {
      addChildView: (view) => attached.add(view),
      removeChildView: (view) => attached.delete(view),
      focusCockpit: () => log.push('focus cockpit'),
    },
    policies: {
      navigation: (contents) => log.push(`navigation ${contents.id}`),
      transport: (contents) => log.push(`transport ${contents.id}`),
      permissions: (contents) => log.push(`permissions ${contents.id}`),
    },
    ...(keys === undefined ? {} : { keys }),
    ...(blocker === undefined ? {} : { blocker }),
    ...(console === undefined ? {} : { console }),
    ...(defaultModes === undefined ? {} : { defaultModes }),
    ...(hooks === undefined ? {} : { hooks }),
  })
  const notices: string[] = []
  pages.on((event: AgentEvent) => {
    if (event.type === 'notice') notices.push(event.text)
  })
  const events: PageEvent[] = []
  pages.onPageEvent((event) => events.push(event))
  return { buffers, pages, views, attached, log, notices, events }
}

/** The one view a rig built, failing loudly when there is none. */
function only(views: readonly FakeView[]): FakeView {
  const [view] = views
  if (view === undefined || views.length !== 1)
    throw new Error(`expected one view, got ${views.length}`)
  return view
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe('creating a page buffer (#119)', () => {
  it('builds the view hardened, with the page door preload only, in persist:default', () => {
    const { pages, views } = rig()
    const buffer = pages.createPage()
    expect(buffer).toMatchObject({ kind: 'page', title: 'Page', elementId: 'page' })
    const prefs = only(views).webPreferences
    expect(prefs).toEqual({
      ...HARDENED_WEB_PREFERENCES,
      partition: 'persist:default',
      preload: PAGE_PRELOAD,
    })
    // ADR 0009's preload, never the cockpit's bridge (#130).
    expect(prefs.preload).toMatch(/preload[\\/]page\.js$/)
  })

  it('uses the ephemeral partition on request', () => {
    const { pages, views } = rig()
    pages.createPage({ partition: 'ephemeral' })
    expect(only(views).webPreferences.partition).toBe('ephemeral')
  })

  it('answers the partition of each page, as the history asks it (#125)', () => {
    const { pages } = rig()
    const kept = pages.createPage()
    const forgotten = pages.createPage({ partition: 'ephemeral' })
    expect(pages.partitionOf(kept.id)).toBe('persistent')
    expect(pages.partitionOf(forgotten.id)).toBe('ephemeral')
    pages.destroyPage(kept.id)
    expect(pages.partitionOf(kept.id)).toBeUndefined()
  })

  it("answers the current page's committed URL and title for bookmark-page (#125)", () => {
    const { pages, buffers, views } = rig()
    expect(() => pages.currentPage()).toThrow('The current buffer is not a page')
    const buffer = pages.createPage()
    buffers.switchTo(buffer.id)
    expect(() => pages.currentPage()).toThrow('has not loaded a URL yet')
    only(views).webContents.emit('did-navigate', {}, 'https://example.test/')
    only(views).webContents.emit('page-title-updated', {}, 'Example')
    expect(pages.currentPage()).toEqual({
      url: 'https://example.test/',
      title: 'Example',
      partition: 'persistent',
    })
  })

  it('applies the navigation, transport and permission policies before the first load', async () => {
    const { pages, views, log } = rig()
    pages.createPage({ url: 'https://example.test/' })
    await flush()
    const id = only(views).webContents.id
    expect(log).toEqual([
      `navigation ${id}`,
      `transport ${id}`,
      `permissions ${id}`,
      'load https://example.test/',
    ])
  })
})

describe('loading, and what is refused (#119, SECURITY.org T3)', () => {
  it('refuses a URL the page policy refuses with a notice, never a throw, and loads nothing', async () => {
    const { pages, views, notices } = rig()
    const buffer = pages.createPage()
    for (const url of [
      'file:///etc/passwd',
      'javascript:alert(1)',
      'nemesis://app/',
      'not a url',
    ]) {
      await expect(pages.load(buffer.id, url)).resolves.toBe('refused')
    }
    expect(only(views).webContents.loads).toEqual([])
    expect(notices).toHaveLength(4)
    expect(notices[0]).toBe(
      'Not opened: file: is not a page URL; a page buffer opens http: and https: only (SECURITY.org, T3)',
    )
    // The notice names the scheme, never the URL.
    for (const notice of notices) expect(notice).not.toContain('passwd')
  })

  it('upgrades plain http off loopback before loading, and keeps loopback http', async () => {
    const { pages, views } = rig()
    const buffer = pages.createPage()
    await pages.load(buffer.id, 'http://example.test/a?b=1')
    await pages.load(buffer.id, 'http://127.0.0.1:8080/')
    await pages.load(buffer.id, 'http://localhost:3000/x')
    expect(only(views).webContents.loads).toEqual([
      'https://example.test/a?b=1',
      'http://127.0.0.1:8080/',
      'http://localhost:3000/x',
    ])
  })

  it("answers Chromium's reason when a load fails, and null when it commits", async () => {
    const { pages, views } = rig()
    const buffer = pages.createPage()
    only(views).webContents.failNextLoad = new Error('ERR_CERT_AUTHORITY_INVALID (-202)')
    await expect(pages.load(buffer.id, 'https://example.test/')).resolves.toContain(
      'ERR_CERT_AUTHORITY_INVALID',
    )
    await expect(pages.load(buffer.id, 'https://example.test/')).resolves.toBeNull()
  })

  it('opens what open-url reads as a current page buffer, and nothing for a refused URL', async () => {
    const { pages, buffers, views, notices } = rig()
    await pages.open('javascript:alert(1)')
    expect(views).toHaveLength(0)
    expect(buffers.list().map((buffer) => buffer.kind)).toEqual(['transcript'])
    expect(notices).toHaveLength(1)

    await pages.open('https://example.test/docs')
    expect(buffers.current?.kind).toBe('page')
    expect(only(views).webContents.loads).toEqual(['https://example.test/docs'])
  })

  it('reuses the current page buffer, and opens a new one when asked (#124)', async () => {
    const { pages, buffers, views } = rig()
    await pages.open('https://example.test/one')
    await pages.open('https://example.test/two')
    expect(views).toHaveLength(1)
    expect(only(views).webContents.loads).toEqual([
      'https://example.test/one',
      'https://example.test/two',
    ])
    await pages.open('https://example.test/three', true)
    expect(views).toHaveLength(2)
    expect(buffers.list().filter((buffer) => buffer.kind === 'page')).toHaveLength(2)
    expect(buffers.current?.id).toBe(pages.list().at(-1)?.id)
  })

  it('reloads, goes back and goes forward through the same checks', async () => {
    const { pages, views, log, notices } = rig()
    await pages.open('https://example.test/one')
    const contents = only(views).webContents
    contents.entries.push('https://example.test/one', 'https://example.test/two')
    contents.index = 1
    contents.url = 'https://example.test/two'

    pages.reload()
    expect(contents.reloads).toBe(1)
    pages.back()
    expect(log.at(-1)).toBe('back https://example.test/one')
    pages.back()
    expect(notices.at(-1)).toBe('No page to go back to')
    pages.forward()
    expect(log.at(-1)).toBe('forward https://example.test/two')

    // An entry the policy would refuse is refused on the way back too.
    contents.entries.push('file:///etc/hosts')
    pages.forward()
    expect(notices.at(-1)).toMatch(/^Not opened: file: is not a page URL/)
    expect(log.at(-1)).toBe('forward https://example.test/two')
  })

  it('steps any page by id and says how, as the MCP page tier reads it (#139)', async () => {
    const { pages, buffers, views, log, events } = rig()
    await pages.open('https://example.test/one')
    const page = pages.list()[0]?.id ?? ''
    const contents = only(views).webContents
    contents.entries.push('https://example.test/one', 'javascript:alert(1)')
    contents.index = 0
    // The page need not be current: the agent moves it while the point is elsewhere.
    await pages.open('https://example.test/elsewhere', true)
    expect(buffers.current?.id).not.toBe(page)
    expect(pages.step(page, -1)).toBe('none')
    expect(pages.step(page, 1)).toBe('refused')
    contents.entries[1] = 'https://example.test/two'
    expect(pages.step(page, 1)).toBe('moved')
    expect(log.at(-1)).toBe('forward https://example.test/two')
    expect(() => pages.step('b99', 1)).toThrow(/No page buffer/)
    // The end of a load, failed or not, is a `stopped` event.
    contents.emit('did-stop-loading')
    expect(events.at(-1)).toEqual({ type: 'stopped', pageId: page })
  })

  it('throws a command error only when the current buffer holds no page', () => {
    const { pages } = rig()
    expect(() => pages.reload()).toThrow(/not a page/)
    expect(() => pages.back()).toThrow(/not a page/)
  })
})

describe('a trackpad swipe (#31)', () => {
  /** A window that holds its `swipe` listeners, as BrowserWindow would. */
  function fakeWindow(): {
    on(event: 'swipe', listener: (event: unknown, direction: string) => void): void
    swipe(direction: string): void
  } {
    const listeners: ((event: unknown, direction: string) => void)[] = []
    return {
      on: (_event, listener) => listeners.push(listener),
      swipe: (direction) => {
        for (const listener of listeners) listener({}, direction)
      },
    }
  }

  it('goes back on left and forward on right, through the same checks as the keys', async () => {
    const { pages, views, log, notices } = rig()
    const window = fakeWindow()
    installSwipe(window, pages)
    await pages.open('https://example.test/one')
    const contents = only(views).webContents
    contents.entries.push('https://example.test/one', 'https://example.test/two')
    contents.index = 1
    contents.url = 'https://example.test/two'

    window.swipe('left')
    expect(log.at(-1)).toBe('back https://example.test/one')
    window.swipe('left')
    expect(notices.at(-1)).toBe('No page to go back to')
    window.swipe('right')
    expect(log.at(-1)).toBe('forward https://example.test/two')
    // Up and down are not history.
    window.swipe('up')
    window.swipe('down')
    expect(log.at(-1)).toBe('forward https://example.test/two')

    // An entry the policy would refuse is refused on a swipe too.
    contents.entries.push('file:///etc/hosts')
    window.swipe('right')
    expect(notices.at(-1)).toMatch(/^Not opened: file: is not a page URL/)
    expect(log.at(-1)).toBe('forward https://example.test/two')
  })

  it('does nothing, and throws nothing, on a buffer that holds no page', async () => {
    const { buffers, pages, views, log, notices } = rig()
    const window = fakeWindow()
    installSwipe(window, pages)
    expect(() => window.swipe('left')).not.toThrow()
    await pages.open('https://example.test/one')
    const contents = only(views).webContents
    contents.entries.push('https://example.test/one', 'https://example.test/two')
    contents.index = 1
    const transcript = buffers.list().find((buffer) => buffer.kind === 'transcript')
    if (transcript === undefined) throw new Error('no transcript buffer')
    buffers.switchTo(transcript.id)
    const before = [...log]
    expect(() => window.swipe('left')).not.toThrow()
    expect(() => window.swipe('right')).not.toThrow()
    expect(log).toEqual(before)
    expect(contents.index).toBe(1)
    expect(notices).toEqual([])
  })
})

describe('the event stream of a page (#119, #53)', () => {
  it('reads the committed top-frame URL and the title into the buffer list', () => {
    const { pages, buffers, views, events } = rig()
    const buffer = pages.createPage()
    const contents = only(views).webContents

    contents.emit('did-start-loading')
    contents.emit('did-redirect-navigation', {
      url: 'https://example.test/landed',
      isMainFrame: true,
    } satisfies RedirectDetails)
    // A redirect has not committed: the buffer shows nothing yet.
    expect(buffers.get(buffer.id)?.url).toBeUndefined()
    contents.emit('did-navigate', {}, 'https://example.test/landed')
    expect(buffers.get(buffer.id)).toMatchObject({
      url: 'https://example.test/landed',
      title: 'example.test',
    })
    contents.emit('page-title-updated', {}, '  Example\n  Domain ')
    contents.emit('did-finish-load')
    // A subframe never moves the top-frame URL.
    contents.emit('did-navigate-in-page', {}, 'https://ads.test/#frame', false)
    contents.emit('did-navigate-in-page', {}, 'https://example.test/landed#part', true)
    expect(buffers.get(buffer.id)).toMatchObject({
      url: 'https://example.test/landed#part',
      title: 'Example Domain',
    })

    expect(events.map((event) => event.type)).toEqual([
      'loading-started',
      'redirect',
      'committed',
      'url-changed',
      'title-changed',
      'finished',
      'url-changed',
    ])
    expect(events.every((event) => event.pageId === buffer.id)).toBe(true)
  })

  it('drops what is not a URL and bounds a title', () => {
    const { pages, buffers, views, events } = rig()
    const buffer = pages.createPage()
    const contents = only(views).webContents
    contents.emit('did-navigate', {}, 'not a url')
    contents.emit('did-navigate', {}, `https://example.test/${'a'.repeat(9000)}`)
    contents.emit('page-title-updated', {}, 7)
    expect(events).toEqual([])
    contents.emit('page-title-updated', {}, 'T'.repeat(1000))
    expect(buffers.get(buffer.id)?.title).toHaveLength(200)
  })

  it('makes a failed top-frame load an event and a notice, and ignores an aborted one', () => {
    const { pages, views, events, notices } = rig()
    pages.createPage()
    const contents = only(views).webContents
    contents.emit('did-fail-load', {}, -3, 'ERR_ABORTED', 'https://example.test/', true)
    contents.emit('did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', 'https://sub.test/', false)
    contents.emit(
      'did-fail-load',
      {},
      -105,
      'ERR_NAME_NOT_RESOLVED',
      'https://nowhere.test/x',
      true,
    )
    expect(events).toEqual([
      {
        type: 'failed',
        pageId: expect.any(String),
        url: 'https://nowhere.test/x',
        code: -105,
        reason: 'ERR_NAME_NOT_RESOLVED',
      },
    ])
    expect(notices).toEqual(['Could not load nowhere.test: ERR_NAME_NOT_RESOLVED'])
  })
})

describe('showing and hiding (#119)', () => {
  it('attaches the current page at the reported bounds, one page at a time', () => {
    const { pages, buffers, views, attached } = rig()
    const one = pages.createPage()
    const two = pages.createPage()
    const [first, second] = views
    if (first === undefined || second === undefined) throw new Error('two views')
    // No page is current, and no rectangle yet: nothing shows.
    expect(attached.size).toBe(0)

    buffers.switchTo(one.id)
    expect(attached.size).toBe(0)
    const bounds = { x: 0, y: 40, width: 1200, height: 600 }
    pages.setBounds(bounds)
    expect([...attached]).toEqual([first])
    expect(first.bounds).toEqual(bounds)

    buffers.switchTo(two.id)
    expect([...attached]).toEqual([second])
    expect(second.bounds).toEqual(bounds)

    // A buffer that is not a page hides every page; its state stays.
    buffers.switchToNext()
    expect(buffers.current?.kind).toBe('transcript')
    expect(attached.size).toBe(0)
    expect(first.webContents.closed).toBe(false)

    // The palette's null hides the current page too.
    buffers.switchTo(one.id)
    expect([...attached]).toEqual([first])
    pages.setBounds(null)
    expect(attached.size).toBe(0)
  })
})

describe('a restored page (#127)', () => {
  it('lists its URL and title at once and loads only when first shown, once', () => {
    const { pages, buffers, views } = rig()
    const one = pages.restorePage({ url: 'https://example.com/a', title: 'Example A' })
    const two = pages.restorePage({ url: 'https://example.com/b', title: 'Example B' })
    const [first, second] = views
    if (first === undefined || second === undefined) throw new Error('two views')
    expect(buffers.get(one.id)).toMatchObject({ url: 'https://example.com/a', title: 'Example A' })
    expect(pages.partitionOf(two.id)).toBe('persistent')
    expect(first.webContents.loads).toEqual([])
    expect(second.webContents.loads).toEqual([])

    buffers.switchTo(two.id)
    pages.setBounds({ x: 0, y: 40, width: 1200, height: 600 })
    expect(second.webContents.loads).toEqual(['https://example.com/b'])
    expect(first.webContents.loads).toEqual([])

    // Shown again, it does not load again.
    buffers.switchTo(one.id)
    buffers.switchTo(two.id)
    expect(first.webContents.loads).toEqual(['https://example.com/a'])
    expect(second.webContents.loads).toEqual(['https://example.com/b'])
  })
})

describe('focus follows the shown page (#120)', () => {
  it('gives the keyboard to a page when it shows and back to the cockpit when none shows', () => {
    const { pages, buffers, views, log } = rig()
    const one = pages.createPage()
    const two = pages.createPage()
    const [first, second] = views
    if (first === undefined || second === undefined) throw new Error('two views')
    const focus = (): string[] => log.filter((line) => line.startsWith('focus'))

    // Not shown: nothing moves.
    buffers.switchTo(one.id)
    expect(focus()).toEqual([])
    pages.setBounds({ x: 0, y: 0, width: 10, height: 10 })
    expect(focus()).toEqual([`focus page ${first.webContents.id}`])
    // A commit, a title, a resize: the page keeps the keyboard, nothing is refocused.
    first.webContents.emit('did-navigate', {}, 'https://example.test/')
    pages.setBounds({ x: 0, y: 0, width: 20, height: 20 })
    expect(focus()).toHaveLength(1)

    // A switch to another page focuses that page.
    buffers.switchTo(two.id)
    expect(focus().at(-1)).toBe(`focus page ${second.webContents.id}`)
    // The palette takes the keyboard while open, and gives it back.
    pages.setBounds(null)
    expect(focus().at(-1)).toBe('focus cockpit')
    pages.setBounds({ x: 0, y: 0, width: 20, height: 20 })
    expect(focus().at(-1)).toBe(`focus page ${second.webContents.id}`)
    // A switch away from every page gives it to the cockpit.
    buffers.switchTo(buffers.list()[0]?.id ?? '')
    expect(buffers.current?.kind).toBe('transcript')
    expect(focus().at(-1)).toBe('focus cockpit')
    expect(focus()).toHaveLength(5)
  })
})

describe('keys typed in a page (#120)', () => {
  it('asks the cockpit with the page buffer type and the modes, and consumes only what it takes', () => {
    const asked: { press: KeyPress; modes: readonly string[] }[] = []
    const { pages, views } = rig((press, modes) => {
      asked.push({ press, modes })
      return press.ctrlKey
    })
    pages.createPage()
    const contents = only(views).webContents
    expect(contents.type({ key: 'v', code: 'KeyV', control: true })).toBe(true)
    expect(contents.type({ key: 'a', code: 'KeyA' })).toBe(false)
    expect(asked.map(({ press }) => press.bufferType)).toEqual(['page', 'page'])
    expect(asked[0]?.modes).toEqual(['document'])
  })

  it('leaves a key up, a composing key and every key without a keymap to the page', () => {
    const asked: KeyPress[] = []
    const { pages, views } = rig((press) => {
      asked.push(press)
      return true
    })
    pages.createPage()
    const contents = only(views).webContents
    expect(contents.type({ key: 'v', type: 'keyUp', control: true })).toBe(false)
    expect(contents.type({ key: 'v', isComposing: true })).toBe(false)
    expect(asked).toEqual([])

    const bare = rig()
    bare.pages.createPage()
    expect(only(bare.views).webContents.type({ key: 'v', control: true })).toBe(false)
  })

  it('asks the cockpit with the modes of the buffer list, passthrough first when it is on', () => {
    const asked: (readonly string[])[] = []
    const { pages, buffers, views } = rig((_press, modes) => {
      asked.push(modes)
      return false
    })
    const buffer = pages.createPage()
    buffers.switchTo(buffer.id)
    expect(buffers.get(buffer.id)?.modes).toEqual(['document'])
    buffers.update(buffer.id, { modes: ['passthrough', 'document'] })
    only(views).webContents.type({ key: 'x' })
    expect(asked.at(-1)).toEqual(['passthrough', 'document'])
    buffers.update(buffer.id, { modes: ['document'] })
    only(views).webContents.type({ key: 'x' })
    expect(asked.at(-1)).toEqual(['document'])
  })

  it('reads a key the way the renderer reports one', () => {
    expect(
      pressFromInput({
        type: 'keyDown',
        key: '√',
        code: 'KeyV',
        shift: false,
        control: false,
        alt: true,
        meta: false,
      }),
    ).toEqual({
      key: '√',
      code: 'KeyV',
      ctrlKey: false,
      altKey: true,
      shiftKey: false,
      metaKey: false,
      bufferType: 'page',
    })
    const base = {
      type: 'keyDown',
      code: '',
      shift: false,
      control: false,
      alt: false,
      meta: false,
    }
    expect(pressFromInput({ ...base, key: '' })).toBeNull()
    expect(pressFromInput({ ...base, key: 'x'.repeat(33) })).toBeNull()
  })
})

describe("the acting tools' input (#140)", () => {
  it('hovers, drags and presses keys as synthesized input, at the page zoom, refusing an unknown key', () => {
    const { pages, views } = rig()
    const buffer = pages.createPage()
    const contents = only(views).webContents
    contents.zoomLevel = Math.log(2) / Math.log(1.2)
    pages.hoverAt(buffer.id, 5, 10)
    pages.dragBetween(buffer.id, { x: 0, y: 0 }, { x: 8, y: 16 })
    pages.pressKey(buffer.id, 'Enter')
    pages.pressKey(buffer.id, 'a')
    pages.pressKey(buffer.id, 'ArrowDown')
    expect(() => pages.pressKey(buffer.id, 'Control+a')).toThrow('Not a key')
    expect(contents.sent).toEqual([
      'mouseMove 10,20',
      'mouseMove 0,0',
      'mouseDown 0,0',
      ...[1, 2, 3, 4, 5, 6, 7, 8].map((step) => `mouseMove ${2 * step},${4 * step}`),
      'mouseUp 16,32',
      'keyDown Enter',
      'char \r',
      'keyUp Enter',
      'keyDown a',
      'char a',
      'keyUp a',
      'keyDown Down',
      'keyUp Down',
    ])
    expect(keyStroke('Tab')).toEqual({ keyCode: 'Tab' })
    expect(keyStroke('\u0007')).toBeNull()
  })
})

describe('document mode on a page (#120)', () => {
  it('scrolls by synthesized keys, finds, copies, and refuses without a current page', () => {
    const { pages, buffers, views, log } = rig()
    const buffer = pages.createPage()
    const contents = only(views).webContents
    expect(() => pages.scroll('page-down')).toThrow('The current buffer is not a page')
    buffers.switchTo(buffer.id)

    pages.scroll('page-down')
    pages.scroll('top')
    expect(contents.sent).toEqual([
      'keyDown PageDown',
      'keyUp PageDown',
      'keyDown Home',
      'keyUp Home',
    ])

    pages.find('needle')
    pages.find('needle')
    pages.find('other')
    pages.find('')
    expect(contents.found).toEqual([
      'stop clearSelection',
      'needle',
      'needle',
      'stop clearSelection',
      'other',
      'stop clearSelection',
    ])

    pages.copy()
    expect(log).toContain(`copy ${contents.id}`)
  })

  it("zooms in Chromium's steps, per origin, into every page's buffer", () => {
    const { pages, buffers, views } = rig()
    const one = pages.createPage()
    const two = pages.createPage()
    const [first, second] = views
    if (first === undefined || second === undefined) throw new Error('two views')
    expect(buffers.get(one.id)?.zoom).toBe(100)
    buffers.switchTo(one.id)

    // Chromium shares the level across the origin; the other page is read again.
    second.webContents.getZoomLevel = () => first.webContents.zoomLevel
    pages.zoom(1)
    expect(buffers.get(one.id)?.zoom).toBe(110)
    expect(buffers.get(two.id)?.zoom).toBe(110)
    pages.zoom(1)
    expect(buffers.get(one.id)?.zoom).toBe(125)
    pages.zoom(-1)
    expect(buffers.get(one.id)?.zoom).toBe(110)
    expect(buffers.get(two.id)?.zoom).toBe(110)
  })

  it('walks the zoom steps and stops at their ends', () => {
    expect(zoomPercent(0)).toBe(100)
    expect(zoomPercent(nextZoomLevel(0, 1))).toBe(110)
    expect(zoomPercent(nextZoomLevel(0, -1))).toBe(90)
    expect(zoomPercent(nextZoomLevel(Math.log(5) / Math.log(1.2), 1))).toBe(500)
    expect(zoomPercent(nextZoomLevel(Math.log(0.25) / Math.log(1.2), -1))).toBe(25)
    // A level between steps goes to the next step past it.
    expect(zoomPercent(nextZoomLevel(0.1, 1))).toBe(110)
  })
})

describe('destroying a page buffer (#119)', () => {
  it('closes the contents, removes the view and every listener on kill-buffer', () => {
    const { pages, buffers, views, attached } = rig()
    const buffer = pages.createPage()
    buffers.switchTo(buffer.id)
    pages.setBounds({ x: 0, y: 0, width: 10, height: 10 })
    const view = only(views)
    expect(view.webContents.listenerCount()).toBeGreaterThan(0)

    buffers.kill(buffer.id)
    expect(view.webContents.closed).toBe(true)
    expect(view.webContents.listenerCount()).toBe(0)
    expect(attached.size).toBe(0)
    expect(pages.list()).toEqual([])
  })

  it("hands the page's console messages to main's sink, and stops on kill (#138)", () => {
    const heard: string[] = []
    const { pages, buffers, views } = rig(undefined, undefined, (pageId, level, message) =>
      heard.push(`${pageId} ${level} ${message}`),
    )
    const buffer = pages.createPage()
    const view = only(views)
    view.webContents.emit('console-message', { level: 'error', message: 'Uncaught boom' })
    view.webContents.emit('console-message', { level: 'info' })
    expect(heard).toEqual([`${buffer.id} error Uncaught boom`])
    buffers.kill(buffer.id)
    view.webContents.emit('console-message', { level: 'info', message: 'after the kill' })
    expect(heard).toHaveLength(1)
    expect(view.webContents.listenerCount()).toBe(0)
  })

  it('takes the buffer out of the list when destroyed directly, and every page when the window goes', () => {
    const { pages, buffers, views } = rig()
    const one = pages.createPage()
    pages.createPage()
    pages.destroyPage(one.id)
    expect(buffers.get(one.id)).toBeUndefined()
    pages.destroyAll()
    expect(buffers.list().map((buffer) => buffer.kind)).toEqual(['transcript'])
    expect(
      views.every((view) => view.webContents.closed && view.webContents.listenerCount() === 0),
    ).toBe(true)
  })
})

/** A blocker that records what the page buffers ask of it. */
class FakeBlocker implements PageBlocker {
  readonly pages = new Map<number, { page: BlockedPage; on: boolean }>()
  starts = 0
  start(): void {
    this.starts += 1
  }
  attach(contentsId: number, page: BlockedPage): void {
    this.pages.set(contentsId, { page, on: true })
  }
  enable(contentsId: number, on: boolean): void {
    const one = this.pages.get(contentsId)
    if (one !== undefined) one.on = on
  }
  detach(contentsId: number): void {
    this.pages.delete(contentsId)
  }
}

describe('blocker mode on a page (#126)', () => {
  it('attaches every page with the mode on, starts the schedule, and detaches on destroy', () => {
    const blocker = new FakeBlocker()
    const { pages, buffers, views } = rig(undefined, blocker)
    expect(blocker.starts).toBe(0)
    const buffer = pages.createPage()
    const contents = only(views).webContents
    expect(blocker.starts).toBe(1)
    expect(blocker.pages.get(contents.id)?.on).toBe(true)
    expect(buffers.get(buffer.id)).toMatchObject({ blocker: true, blocked: 0 })
    pages.destroyPage(buffer.id)
    expect(blocker.pages.has(contents.id)).toBe(false)
  })

  it('counts what was blocked until the page commits a new URL', () => {
    const blocker = new FakeBlocker()
    const { pages, buffers, views } = rig(undefined, blocker)
    const buffer = pages.createPage()
    const contents = only(views).webContents
    const attached = blocker.pages.get(contents.id)
    attached?.page.blocked()
    attached?.page.blocked()
    expect(buffers.get(buffer.id)?.blocked).toBe(2)
    contents.emit('did-navigate', {}, 'https://news.example/')
    expect(buffers.get(buffer.id)?.blocked).toBe(0)
    contents.url = 'https://news.example/'
    expect(attached?.page.url()).toBe('https://news.example/')
  })

  it('follows the blocker mode in the buffer list, for that page only', () => {
    const blocker = new FakeBlocker()
    const { pages, buffers, views } = rig(undefined, blocker)
    const one = pages.createPage()
    const two = pages.createPage()
    expect(buffers.get(one.id)?.modes).toEqual(['blocker', 'document'])
    buffers.update(one.id, { modes: ['document'] })
    const [first, second] = views
    expect(blocker.pages.get(first?.webContents.id ?? -1)?.on).toBe(false)
    expect(blocker.pages.get(second?.webContents.id ?? -1)?.on).toBe(true)
    expect(buffers.get(one.id)?.blocker).toBe(false)
    expect(buffers.get(two.id)?.blocker).toBe(true)
    buffers.update(one.id, { modes: ['blocker', 'document'] })
    expect(blocker.pages.get(first?.webContents.id ?? -1)?.on).toBe(true)
    expect(buffers.get(one.id)?.blocker).toBe(true)
  })

  it('starts a page in the default modes of the config, document last, blocker only with a blocker', () => {
    const blocker = new FakeBlocker()
    const withNone = rig(undefined, blocker, undefined, () => [])
    const bare = withNone.pages.createPage()
    expect(withNone.buffers.get(bare.id)?.modes).toEqual(['document'])
    expect(blocker.pages.get(only(withNone.views).webContents.id)?.on).toBe(false)
    expect(withNone.buffers.get(bare.id)?.blocker).toBe(false)
    const again = rig(undefined, undefined, undefined, () => ['passthrough', 'blocker'])
    const page = again.pages.createPage()
    expect(again.buffers.get(page.id)?.modes).toEqual(['passthrough', 'document'])
  })

  it('has no blocker fields in a window without a blocker', () => {
    const { pages, buffers } = rig()
    const buffer = pages.createPage()
    expect(buffers.get(buffer.id)?.blocker).toBeUndefined()
  })
})

describe('the bounds the renderer reports (#119, #53)', () => {
  it('takes null or four finite numbers, rounded, and nothing else', () => {
    expect(parsePageBounds(null)).toBeNull()
    expect(parsePageBounds({ x: 0.4, y: 40.6, width: 1200, height: 600.2 })).toEqual({
      x: 0,
      y: 41,
      width: 1200,
      height: 600,
    })
    expect(() => parsePageBounds(undefined)).toThrow()
    expect(() => parsePageBounds('0,0,10,10')).toThrow()
    expect(() => parsePageBounds({ x: 0, y: 0, width: Number.NaN, height: 1 })).toThrow(/width/)
    expect(() => parsePageBounds({ x: -1, y: 0, width: 1, height: 1 })).toThrow(/x/)
    expect(() => parsePageBounds({ x: 0, y: 0, width: 1e9, height: 1 })).toThrow(/width/)
  })
})

describe('before-load on a page buffer (#179)', () => {
  function dispatching(): { rig: Rig; seen: string[] } {
    const hooks = new HookRegistry(() => {})
    const seen: string[] = []
    hooks.on(
      'before-load',
      {
        name: 'old-reddit',
        doc: 'Rewrites reddit, blocks the tracker.',
        run: (event) => {
          seen.push(`${event.from} ${event.url}`)
          if (event.url.startsWith('https://www.reddit.com/')) {
            return { rewrite: event.url.replace('://www.', '://old.') }
          }
          if (event.url.includes('tracker')) return { veto: true, reason: 'tracker' }
          return undefined
        },
      },
      'config',
    )
    return { rig: rig(undefined, undefined, undefined, undefined, hooks), seen }
  }

  function navigate(contents: FakeContents, url: string, isSameDocument = false): boolean {
    let prevented = false
    contents.emit(
      'will-navigate',
      { preventDefault: () => (prevented = true), isSameDocument },
      url,
    )
    return prevented
  }

  it('rewrites a link the page follows and loads the target; leaves any other navigation to the page', async () => {
    const { rig: r, seen } = dispatching()
    r.pages.createPage()
    const contents = only(r.views).webContents
    expect(navigate(contents, 'https://www.reddit.com/r/emacs')).toBe(true)
    await flush()
    expect(contents.loads).toEqual(['https://old.reddit.com/r/emacs'])
    // No change: the page's navigation goes on, a form's body included.
    expect(navigate(contents, 'https://example.test/form')).toBe(false)
    expect(navigate(contents, 'https://tracker.test/')).toBe(true)
    // A same-document move and a scheme the page policy refuses are not dispatched.
    expect(navigate(contents, 'https://www.reddit.com/#top', true)).toBe(false)
    expect(navigate(contents, 'mailto:someone@example.test')).toBe(false)
    await flush()
    expect(contents.loads).toEqual(['https://old.reddit.com/r/emacs'])
    expect(seen).toEqual([
      'page https://www.reddit.com/r/emacs',
      'page https://example.test/form',
      'page https://tracker.test/',
    ])
  })

  it('dispatches open and openNew before a buffer is made, and a block makes none', async () => {
    const { rig: r, seen } = dispatching()
    await r.pages.openNew('https://tracker.test/', true)
    expect(r.views).toHaveLength(0)
    await r.pages.open('https://www.reddit.com/')
    expect(only(r.views).webContents.loads).toEqual(['https://old.reddit.com/'])
    expect(seen).toEqual(['cockpit https://tracker.test/', 'cockpit https://www.reddit.com/'])
  })

  it('does not dispatch a reload or a history step again', () => {
    const { rig: r, seen } = dispatching()
    const buffer = r.pages.createPage()
    r.buffers.switchTo(buffer.id)
    const contents = only(r.views).webContents
    contents.url = 'https://www.reddit.com/'
    r.pages.reload()
    expect(contents.reloads).toBe(1)
    expect(seen).toEqual([])
  })
})
