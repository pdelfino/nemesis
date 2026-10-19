import { describe, expect, it } from 'vitest'
import type { WebPreferences } from 'electron'
import type { AgentEvent } from '../../src/main/agent/events'
import { BufferRegistry } from '../../src/main/buffers'
import {
  PageBuffers,
  parsePageBounds,
  urlFromInput,
  type PageContents,
  type PageView,
  type RedirectDetails,
} from '../../src/main/page-buffer'
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

function rig(): Rig {
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
  it('builds the view hardened, without a preload, in persist:default', () => {
    const { pages, views } = rig()
    const buffer = pages.createPage()
    expect(buffer).toMatchObject({ kind: 'page', title: 'Page', elementId: 'page' })
    const prefs = only(views).webPreferences
    expect(prefs).toEqual({ ...HARDENED_WEB_PREFERENCES, partition: 'persist:default' })
    expect(prefs).not.toHaveProperty('preload')
  })

  it('uses the ephemeral partition on request', () => {
    const { pages, views } = rig()
    pages.createPage({ partition: 'ephemeral' })
    expect(only(views).webPreferences.partition).toBe('ephemeral')
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

    await pages.open('  example.test/docs ')
    expect(buffers.current?.kind).toBe('page')
    expect(only(views).webContents.loads).toEqual(['https://example.test/docs'])
    expect(urlFromInput('http://localhost:5173')).toBe('http://localhost:5173')
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

  it('throws a command error only when the current buffer holds no page', () => {
    const { pages } = rig()
    expect(() => pages.reload()).toThrow(/not a page/)
    expect(() => pages.back()).toThrow(/not a page/)
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

describe('the keyboard while a page shows (#119, until M4.2)', () => {
  it('goes back to the cockpit when a page is attached and when the shown page commits', () => {
    const { pages, buffers, views, log } = rig()
    const buffer = pages.createPage()
    const contents = only(views).webContents
    // Not shown: a commit takes nothing from the cockpit.
    contents.emit('did-navigate', {}, 'https://example.test/')
    expect(log.filter((line) => line === 'focus cockpit')).toHaveLength(0)
    buffers.switchTo(buffer.id)
    pages.setBounds({ x: 0, y: 0, width: 10, height: 10 })
    expect(log.filter((line) => line === 'focus cockpit')).toHaveLength(1)
    contents.emit('did-navigate', {}, 'https://example.test/next')
    expect(log.filter((line) => line === 'focus cockpit')).toHaveLength(2)
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
