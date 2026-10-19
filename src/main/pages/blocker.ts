import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { FiltersEngine, Request } from '@ghostery/adblocker'
import type { AgentEvent, AgentEventListener } from '../agent/events'
import type { BlockerUpdates } from '../settings'

/**
 * Blocker mode (#126, SECURITY.org T7, study 03 "M4 needs" 3): a request
 * handler on each page partition, in the main process, that cancels a
 * request to a listed host before it leaves. The page is never asked and
 * never told: no script, no preload, no cosmetic filtering (that waits for
 * ADR 0009, #121); a cancelled request is a network error to it, like a host
 * that does not resolve.
 *
 * Two lists:
 * - The system hosts file, read once at startup: every name mapped to an
 *   unroutable or loopback address (`0.0.0.0`, `::`, `127.0.0.1`, `::1`) is
 *   blocked, the loopback names themselves excepted, so the `/etc/hosts`
 *   blocklist applies inside the app as it does outside, top-level loads
 *   included. Exact names only, as the resolver reads them.
 * - The Ghostery engine (`@ghostery/adblocker`, network filters only) over
 *   EasyList and EasyPrivacy, kept serialized in the profile. It is read from
 *   disk at startup and downloaded again on the schedule of the
 *   `blockerUpdates` setting, the first time once a page buffer opens: never
 *   at launch, so the no-network spec stays true. With the setting `off`,
 *   nothing is downloaded and the copy on disk, if any, is kept. Top-level
 *   loads are the user's and pass the engine, as in every browser.
 *
 * Electron gives `onBeforeRequest` to one listener per session, so the
 * handler is installed on each partition once and decides per page: a page
 * buffer attaches its WebContents with blocker mode on, `toggle-blocker`
 * turns it off and on, and a request from a page whose mode is off passes
 * untouched. A request no page buffer owns (a service worker's) gets the
 * lists. The test request log of #54 observes through `install`, so the one
 * listener stays this module's.
 *
 * The module holds no Electron value: the sessions, the fetch and the clock
 * come in through `BlockerOptions`, so the unit tests drive it on fakes.
 */

/** The lists the engine is built from: EasyList and EasyPrivacy, from their own site. */
export const BLOCKER_LISTS: readonly string[] = [
  'https://easylist.to/easylist/easylist.txt',
  'https://easylist.to/easylist/easyprivacy.txt',
]

/** Where the engine is kept, under the blocker's folder in the profile. */
export const ENGINE_FILE = 'engine.bin'

/** The system's hosts file. */
export const SYSTEM_HOSTS = '/etc/hosts'

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

/** How long a copy of the lists is good for, per setting. */
const UPDATE_EVERY: Readonly<Record<Exclude<BlockerUpdates, 'off'>, number>> = {
  daily: DAY,
  weekly: 7 * DAY,
  monthly: 30 * DAY,
}

/** The schedule wakes up this often to see whether the lists are due. */
const CHECK_EVERY = HOUR
/** After a failed download, the next try waits this long. */
const RETRY_AFTER = DAY
/** A list longer than this is not EasyList. */
const MAX_LIST = 32 * 1024 * 1024
/** A hosts file longer than this is not read. */
const MAX_HOSTS = 64 * 1024 * 1024

/** The addresses a hosts entry points at to block a name. */
const SINKS = new Set(['0.0.0.0', '0', '::', '::0', '127.0.0.1', '::1'])
/** The names every hosts file maps to loopback on purpose. */
const LOOPBACK_NAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'local',
  'broadcasthost',
  'ip6-localhost',
  'ip6-loopback',
  '0.0.0.0',
])

/** The engine reads network filters only: no cosmetic, HTML or CSP filtering reaches a page. */
const ENGINE_CONFIG = {
  loadNetworkFilters: true,
  loadCosmeticFilters: false,
  loadGenericCosmeticsFilters: false,
  loadExtendedSelectors: false,
  loadCSPFilters: false,
  enableHtmlFiltering: false,
  enableMutationObserver: false,
} as const

/** What the handler reads of a request: the part of Electron's details it needs. */
export interface BlockerRequest {
  readonly id: number
  readonly url: string
  readonly resourceType?: string
  readonly referrer?: string
  readonly webContentsId?: number
}

/** What the handler answers: cancelled, or let through. */
export interface BlockerResponse {
  readonly cancel?: boolean
}

export type BlockerListener = (
  details: BlockerRequest,
  callback: (response: BlockerResponse) => void,
) => void

/** The minimum of a Session the handler installs on; a fake satisfies it in the unit tests. */
export interface BlockerSession {
  readonly webRequest: { onBeforeRequest(listener: BlockerListener): void }
}

/** A page buffer as the blocker sees it: its URL, for third-party rules, and its count. */
export interface BlockedPage {
  url(): string
  blocked(): void
}

/** What the page buffers ask of the blocker; page-buffer.ts holds no more than this. */
export interface PageBlocker {
  /** Starts the update schedule; the first page buffer calls it, so launch fetches nothing. */
  start(): void
  /** A page buffer's WebContents, in blocker mode from now on. */
  attach(contentsId: number, page: BlockedPage): void
  /** Blocker mode on or off for one page. */
  enable(contentsId: number, on: boolean): void
  detach(contentsId: number): void
}

/** What a list download reads of a response; Electron's `net.fetch` gives more. */
export interface ListResponse {
  readonly ok: boolean
  readonly status: number
  text(): Promise<string>
}

export interface BlockerOptions {
  /** The blocker's folder in the profile, where the engine is kept. */
  readonly dir: string
  /** The hosts file to read at startup, or null for none. */
  readonly hostsFile: string | null
  /** The setting, read at every check so a config reload is the next check's. */
  readonly updates: () => BlockerUpdates
  /** How the lists are downloaded, or null when this run downloads nothing. */
  readonly fetch: ((url: string) => Promise<ListResponse>) | null
  /** Under test only: a filter list on disk the engine is parsed from instead of the profile's. */
  readonly seedList?: string | undefined
  readonly now?: () => number
}

/**
 * The names a hosts file blocks: every name on a line whose address is one
 * of the sinks, lowercased, without a trailing dot, the loopback names
 * excepted. Comments and malformed lines are skipped.
 */
export function parseHosts(text: string): Set<string> {
  const names = new Set<string>()
  for (const line of text.split(/\r?\n/)) {
    const [address, ...rest] = line.replace(/#.*/, '').trim().split(/\s+/)
    if (address === undefined || !SINKS.has(address)) continue
    for (const raw of rest) {
      const name = raw.toLowerCase().replace(/\.$/, '')
      if (name.length === 0 || name.length > 253 || LOOPBACK_NAMES.has(name)) continue
      names.add(name)
    }
  }
  return names
}

/** A filter list parsed into the engine, network filters only. */
export function parseEngine(lists: string): FiltersEngine {
  return FiltersEngine.parse(lists, ENGINE_CONFIG)
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

interface Attached {
  readonly page: BlockedPage
  on: boolean
}

export class Blocker implements PageBlocker {
  private readonly now: () => number
  private readonly pages = new Map<number, Attached>()
  private readonly notices = new Set<AgentEventListener>()
  private hosts = new Set<string>()
  private engine: FiltersEngine | null = null
  /** When the engine on disk was written, or null for none. */
  private updatedAt: number | null = null
  /** No download before this, after a failed one. */
  private retryAt = 0
  private updating: Promise<void> | null = null
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(private readonly options: BlockerOptions) {
    this.now = options.now ?? Date.now
  }

  /** The cockpit's notices: a list download that landed or failed. */
  on(listener: AgentEventListener): () => void {
    this.notices.add(listener)
    return () => {
      this.notices.delete(listener)
    }
  }

  /** Reads the hosts file and the engine on disk. Touches no network. */
  load(): void {
    const { hostsFile, seedList, dir } = this.options
    if (hostsFile !== null) {
      try {
        if (existsSync(hostsFile) && statSync(hostsFile).size <= MAX_HOSTS) {
          this.hosts = parseHosts(readFileSync(hostsFile, 'utf8'))
        }
      } catch (error) {
        console.error(`Blocker: the hosts file was not read: ${describe(error)}`)
      }
    }
    if (seedList !== undefined) {
      this.engine = parseEngine(readFileSync(seedList, 'utf8'))
      return
    }
    const file = join(dir, ENGINE_FILE)
    if (!existsSync(file)) return
    try {
      this.engine = FiltersEngine.deserialize(new Uint8Array(readFileSync(file)))
      this.updatedAt = statSync(file).mtimeMs
    } catch (error) {
      // A copy from another engine version, or a torn one: the next update replaces it.
      console.error(`Blocker: the lists on disk were not read: ${describe(error)}`)
    }
  }

  /** How many names the hosts file blocks. */
  get hostCount(): number {
    return this.hosts.size
  }

  /** True once the engine has lists, from disk or a download. */
  get hasLists(): boolean {
    return this.engine !== null
  }

  /**
   * Takes `onBeforeRequest` on one session. Answers a surface on which an
   * observer, the test request log of #54, sees every request first.
   */
  install(session: BlockerSession): BlockerSession {
    const observers: BlockerListener[] = []
    session.webRequest.onBeforeRequest((details, callback) => {
      for (const observer of observers) observer(details, () => {})
      callback(this.decide(details) ? { cancel: true } : {})
    })
    return {
      webRequest: {
        onBeforeRequest: (listener) => {
          observers.push(listener)
        },
      },
    }
  }

  attach(contentsId: number, page: BlockedPage): void {
    this.pages.set(contentsId, { page, on: true })
  }

  enable(contentsId: number, on: boolean): void {
    const attached = this.pages.get(contentsId)
    if (attached !== undefined) attached.on = on
  }

  detach(contentsId: number): void {
    this.pages.delete(contentsId)
  }

  /** True when the request is cancelled; the page that made it counts one more. */
  decide(details: BlockerRequest): boolean {
    const attached =
      details.webContentsId === undefined ? undefined : this.pages.get(details.webContentsId)
    if (attached !== undefined && !attached.on) return false
    if (!this.listed(details, attached?.page)) return false
    attached?.page.blocked()
    return true
  }

  start(): void {
    if (this.timer !== null || this.options.fetch === null) return
    this.timer = setInterval(() => void this.check(), CHECK_EVERY)
    // The schedule never keeps the app alive.
    this.timer.unref?.()
    void this.check()
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer)
    this.timer = null
  }

  /** Downloads the lists when the setting says they are due. */
  check(): Promise<void> {
    const setting = this.options.updates()
    if (setting === 'off' || this.options.fetch === null) return Promise.resolve()
    const now = this.now()
    const fresh = this.updatedAt !== null && now - this.updatedAt < UPDATE_EVERY[setting]
    if (fresh || now < this.retryAt) return Promise.resolve()
    return this.update()
  }

  /** Downloads EasyList and EasyPrivacy, builds the engine and keeps it on disk. */
  update(): Promise<void> {
    this.updating ??= this.download().finally(() => {
      this.updating = null
    })
    return this.updating
  }

  private async download(): Promise<void> {
    const fetch = this.options.fetch
    if (fetch === null) return
    try {
      const lists = await Promise.all(
        BLOCKER_LISTS.map(async (url) => {
          const response = await fetch(url)
          if (!response.ok) throw new Error(`${new URL(url).pathname} answered ${response.status}`)
          const text = await response.text()
          if (text.length > MAX_LIST) throw new Error(`${new URL(url).pathname} is too long`)
          return text
        }),
      )
      const engine = parseEngine(lists.join('\n'))
      const { dir } = this.options
      mkdirSync(dir, { recursive: true })
      const file = join(dir, ENGINE_FILE)
      // Written aside and renamed, so a crash leaves the old copy whole.
      writeFileSync(`${file}.tmp`, engine.serialize())
      renameSync(`${file}.tmp`, file)
      this.engine = engine
      this.updatedAt = this.now()
      this.notify('Blocker lists updated: EasyList and EasyPrivacy')
    } catch (error) {
      this.retryAt = this.now() + RETRY_AFTER
      this.notify(`Blocker lists not updated: ${describe(error)}; the next try is in a day`)
    }
  }

  private listed(details: BlockerRequest, page: BlockedPage | undefined): boolean {
    let url: URL
    try {
      url = new URL(details.url)
    } catch {
      return false
    }
    if (!/^(https?|wss?):$/.test(url.protocol)) return false
    if (this.hosts.has(url.hostname.toLowerCase())) return true
    const type = details.resourceType ?? 'other'
    if (this.engine === null || type === 'mainFrame') return false
    const request = Request.fromRawDetails({
      requestId: String(details.id),
      url: details.url,
      sourceUrl: details.referrer || page?.url() || '',
      type: type as Request['type'],
      ...(details.webContentsId === undefined ? {} : { tabId: details.webContentsId }),
    })
    return this.engine.match(request).match
  }

  private notify(text: string): void {
    const event: AgentEvent = { type: 'notice', text }
    for (const listener of this.notices) listener(event)
  }
}
