import { mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  Blocker,
  BLOCKER_LISTS,
  ENGINE_FILE,
  parseEngine,
  parseHosts,
  type BlockerListener,
  type BlockerOptions,
  type BlockerRequest,
  type ListResponse,
} from '../../src/main/pages/blocker'
import type { BlockerUpdates } from '../../src/main/settings'

/**
 * Blocker mode (#126) on fakes for the session and the fetch: a hosts entry
 * blocks, a toggle stops blocking, the engine reads network filters, and the
 * lists are downloaded on the schedule of the setting, never before the
 * first page buffer starts it. The live run is
 * tests/e2e/security/blocker.spec.ts.
 */

const DAY = 24 * 60 * 60 * 1000

const folders: string[] = []

function folder(): string {
  const dir = mkdtempSync(join(tmpdir(), 'nemesis-blocker-'))
  folders.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of folders.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A session whose one `onBeforeRequest` listener the spec calls by hand. */
class FakeSession {
  listener: BlockerListener | null = null
  readonly webRequest = {
    onBeforeRequest: (listener: BlockerListener): void => {
      this.listener = listener
    },
  }

  /** Sends one request through the listener; true when it was cancelled. */
  request(details: Partial<BlockerRequest> & { readonly url: string }): boolean {
    let cancelled: boolean | undefined
    this.listener?.({ id: 1, resourceType: 'image', ...details }, (response) => {
      cancelled = response.cancel === true
    })
    if (cancelled === undefined) throw new Error('The listener never answered')
    return cancelled
  }
}

interface Rig {
  readonly blocker: Blocker
  readonly session: FakeSession
  readonly fetched: string[]
  readonly notices: string[]
  readonly dir: string
  clock: number
}

function rig(
  options: {
    readonly hosts?: string
    readonly updates?: BlockerUpdates
    readonly lists?: string
    readonly fetch?: BlockerOptions['fetch']
    readonly dir?: string
  } = {},
): Rig {
  const dir = options.dir ?? folder()
  let hostsFile: string | null = null
  if (options.hosts !== undefined) {
    hostsFile = join(dir, 'hosts')
    writeFileSync(hostsFile, options.hosts)
  }
  const fetched: string[] = []
  const lists = options.lists ?? '||tracker.example^\n'
  const fetch =
    options.fetch === undefined
      ? (url: string): Promise<ListResponse> => {
          fetched.push(url)
          return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(lists) })
        }
      : options.fetch
  const notices: string[] = []
  const session = new FakeSession()
  const state: Rig = {
    blocker: new Blocker({
      dir: join(dir, 'blocker'),
      hostsFile,
      updates: () => options.updates ?? 'weekly',
      fetch,
      now: () => state.clock,
    }),
    session,
    fetched,
    notices,
    dir,
    clock: Date.UTC(2026, 9, 19),
  }
  state.blocker.on((event) => {
    if (event.type === 'notice') notices.push(event.text)
  })
  state.blocker.load()
  state.blocker.install(session)
  return state
}

describe('the hosts list', () => {
  it('reads the names a hosts file sends to a sink, never the loopback names', () => {
    const names = parseHosts(
      [
        '# a blocklist',
        '127.0.0.1 localhost',
        '::1 localhost ip6-localhost',
        '255.255.255.255 broadcasthost',
        '0.0.0.0 ads.example.com tracker.example.  # two at once',
        '127.0.0.1\tTelemetry.Example.org',
        ':: pixel.example.net',
        '192.168.1.10 nas.home',
        '0.0.0.0',
      ].join('\n'),
    )
    expect([...names].sort()).toEqual([
      'ads.example.com',
      'pixel.example.net',
      'telemetry.example.org',
      'tracker.example',
    ])
  })

  it('blocks a request to a listed host, and counts it on the page that made it', () => {
    const { blocker, session } = rig({ hosts: '0.0.0.0 tracker.example\n' })
    let count = 0
    blocker.attach(7, { url: () => 'https://news.example/', blocked: () => (count += 1) })
    expect(blocker.hostCount).toBe(1)
    expect(session.request({ url: 'https://tracker.example/pixel.png', webContentsId: 7 })).toBe(
      true,
    )
    // The resolver reads exact names, and so does the list.
    expect(session.request({ url: 'https://sub.tracker.example/p.png', webContentsId: 7 })).toBe(
      false,
    )
    expect(session.request({ url: 'https://news.example/story.png', webContentsId: 7 })).toBe(false)
    // A top-level load to a listed host is refused too, as outside the app.
    expect(
      session.request({
        url: 'https://tracker.example/',
        resourceType: 'mainFrame',
        webContentsId: 7,
      }),
    ).toBe(true)
    expect(count).toBe(2)
  })

  it('stops blocking for a page whose blocker mode is off, and blocks again when it is on', () => {
    const { blocker, session } = rig({ hosts: '0.0.0.0 tracker.example\n' })
    let count = 0
    blocker.attach(7, { url: () => '', blocked: () => (count += 1) })
    blocker.attach(8, { url: () => '', blocked: () => undefined })
    blocker.enable(7, false)
    expect(session.request({ url: 'https://tracker.example/a.png', webContentsId: 7 })).toBe(false)
    // The other page keeps its mode.
    expect(session.request({ url: 'https://tracker.example/a.png', webContentsId: 8 })).toBe(true)
    blocker.enable(7, true)
    expect(session.request({ url: 'https://tracker.example/a.png', webContentsId: 7 })).toBe(true)
    expect(count).toBe(1)
    blocker.detach(7)
    // A request no page owns still gets the lists.
    expect(session.request({ url: 'https://tracker.example/a.png', webContentsId: 7 })).toBe(true)
    expect(session.request({ url: 'https://tracker.example/a.png' })).toBe(true)
  })

  it('lets an observer see every request without taking the listener', () => {
    const { blocker } = rig({ hosts: '0.0.0.0 tracker.example\n' })
    const session = new FakeSession()
    const seen: string[] = []
    blocker.install(session).webRequest.onBeforeRequest((details, callback) => {
      seen.push(details.url)
      callback({})
    })
    expect(session.request({ url: 'https://tracker.example/a.png' })).toBe(true)
    expect(session.request({ url: 'https://news.example/' })).toBe(false)
    expect(seen).toEqual(['https://tracker.example/a.png', 'https://news.example/'])
  })

  it('never blocks the app’s own schemes', () => {
    const { session } = rig({ hosts: '0.0.0.0 app\n' })
    expect(session.request({ url: 'nemesis://app/index.html' })).toBe(false)
    expect(session.request({ url: 'not a url' })).toBe(false)
  })
})

describe('the engine', () => {
  it('reads network filters, and lets the top-level load through', () => {
    const engine = parseEngine('||ads.example^\n/banner-ad.js\n##.ad-box\n')
    const dir = folder()
    writeFileSync(join(dir, 'list.txt'), '||ads.example^\n/banner-ad.js\n##.ad-box\n')
    const blocker = new Blocker({
      dir: join(dir, 'blocker'),
      hostsFile: null,
      updates: () => 'off',
      fetch: null,
      seedList: join(dir, 'list.txt'),
    })
    blocker.load()
    const session = new FakeSession()
    blocker.install(session)
    expect(blocker.hasLists).toBe(true)
    // No cosmetic filter is kept: nothing in this issue reaches into a page.
    expect(engine.getFilters().cosmeticFilters).toEqual([])
    expect(engine.getFilters().networkFilters.length).toBe(2)
    expect(
      session.request({
        url: 'https://ads.example/x.png',
        referrer: 'https://news.example/',
      }),
    ).toBe(true)
    expect(
      session.request({
        url: 'https://news.example/static/banner-ad.js',
        resourceType: 'script',
        referrer: 'https://news.example/',
      }),
    ).toBe(true)
    expect(
      session.request({
        url: 'https://ads.example/',
        resourceType: 'mainFrame',
      }),
    ).toBe(false)
    expect(
      session.request({ url: 'https://news.example/app.js', referrer: 'https://news.example/' }),
    ).toBe(false)
  })
})

describe('the update schedule', () => {
  it('downloads nothing until a page buffer starts it, then EasyList and EasyPrivacy once', async () => {
    const one = rig()
    one.blocker.load()
    expect(one.fetched).toEqual([])
    one.blocker.start()
    await one.blocker.update()
    expect(one.fetched).toEqual([...BLOCKER_LISTS])
    expect(one.notices).toEqual(['Blocker lists updated: EasyList and EasyPrivacy'])
    expect(one.blocker.hasLists).toBe(true)
    expect(
      one.session.request({ url: 'https://tracker.example/a.js', referrer: 'https://x.example/' }),
    ).toBe(true)
    // Fresh lists are not downloaded again before the week is out.
    one.clock += 6 * DAY
    await one.blocker.check()
    expect(one.fetched).toHaveLength(2)
    one.clock += 2 * DAY
    await one.blocker.check()
    expect(one.fetched).toHaveLength(4)
    one.blocker.stop()
  })

  it('keeps the lists on disk, read again at startup with no download', async () => {
    const first = rig()
    await first.blocker.check()
    expect(statSync(join(first.dir, 'blocker', ENGINE_FILE)).size).toBeGreaterThan(0)
    const file = join(first.dir, 'blocker', ENGINE_FILE)
    const written = new Date(first.clock)
    utimesSync(file, written, written)

    const second = rig({ dir: first.dir })
    second.clock = first.clock + DAY
    expect(second.blocker.hasLists).toBe(true)
    await second.blocker.check()
    expect(second.fetched).toEqual([])
    expect(
      second.session.request({
        url: 'https://tracker.example/a.js',
        referrer: 'https://x.example/',
      }),
    ).toBe(true)
  })

  it('downloads nothing when updates are off, or when the run has no fetch', async () => {
    const off = rig({ updates: 'off' })
    off.blocker.start()
    await off.blocker.check()
    expect(off.fetched).toEqual([])
    off.blocker.stop()

    const none = rig({ fetch: null })
    none.blocker.start()
    await none.blocker.check()
    expect(none.notices).toEqual([])
  })

  it('says when a download fails, keeps what it had and waits a day to try again', async () => {
    let calls = 0
    const failing = rig({
      fetch: () => {
        calls += 1
        return Promise.resolve({ ok: false, status: 503, text: () => Promise.resolve('') })
      },
    })
    await failing.blocker.check()
    expect(failing.notices).toEqual([
      'Blocker lists not updated: /easylist/easylist.txt answered 503; the next try is in a day',
    ])
    expect(failing.blocker.hasLists).toBe(false)
    const after = calls
    failing.clock += DAY / 2
    await failing.blocker.check()
    expect(calls).toBe(after)
    failing.clock += DAY
    await failing.blocker.check()
    expect(calls).toBeGreaterThan(after)
  })
})
