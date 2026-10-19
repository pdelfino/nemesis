import type { BufferList } from '../../shared/buffers'

/**
 * The network feed of each page buffer (#29, ADR 0008's
 * `nemesis://page/{page}/network`): the last NETWORK_RING requests a page's
 * WebContents completed, heard on its session's `webRequest.onCompleted` in
 * main, kept in memory, never on disk, and dropped with the buffer when it
 * is killed.
 *
 * A record is the method, the origin, the path, the status and the size the
 * response announced. No header and no body is kept (ADR 0008: headers hold
 * cookies, bodies hold what the user typed); the size is read from the one
 * `Content-Length` header as a number, and the header itself goes no
 * further. The path and query are the page's choice, so what reaches an
 * agent goes through `wrapUntrusted`, by the MCP page tier.
 */

/** The most requests one page keeps; an older one leaves as a newer one comes. */
export const NETWORK_RING = 500

/** The longest path, query included, one record keeps. */
export const MAX_NETWORK_PATH = 2000

export interface NetworkEntry {
  /** When main heard it complete, in milliseconds since the epoch. */
  readonly at: number
  readonly method: string
  /** The request's scheme, host and port, `null` for an opaque URL. */
  readonly origin: string
  /** Page content: the path and query, cut to MAX_NETWORK_PATH. */
  readonly path: string
  readonly status: number
  /** The response's `Content-Length`, null when it announced none. */
  readonly bytes: number | null
}

/** What `onCompleted` reports that the feed reads; the headers are read for their length alone. */
export interface CompletedRequest {
  readonly webContentsId?: number | undefined
  readonly method: string
  readonly url: string
  readonly statusCode: number
  readonly responseHeaders?: Readonly<Record<string, readonly string[]>> | undefined
}

/** The surface of a Session the feed installs on; a fake satisfies it in the unit tests. */
export interface CompletedSurface {
  readonly webRequest: {
    onCompleted(listener: (details: CompletedRequest) => void): void
  }
}

/**
 * Takes `onCompleted` on each page session, once for the app, and hands
 * every completed request to whoever listens: each window keeps the ones of
 * its own page buffers. Electron gives each `webRequest` event one listener
 * per session, so nothing else may take `onCompleted` there.
 */
export class CompletedRequests {
  private readonly listeners = new Set<(details: CompletedRequest) => void>()

  install(session: CompletedSurface): void {
    session.webRequest.onCompleted((details) => {
      for (const listener of [...this.listeners]) listener(details)
    })
  }

  on(listener: (details: CompletedRequest) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
}

/** The announced size, from `Content-Length` in whatever case it came, or null. */
function announcedBytes(headers: CompletedRequest['responseHeaders']): number | null {
  if (headers === undefined) return null
  for (const [name, values] of Object.entries(headers)) {
    if (name.toLowerCase() !== 'content-length') continue
    const bytes = Number(values[0])
    return Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : null
  }
  return null
}

/** A record of one completed request, with no header and no body; null for a URL that does not parse. */
export function networkEntry(details: CompletedRequest, at: number): NetworkEntry | null {
  let url: URL
  try {
    url = new URL(details.url)
  } catch {
    return null
  }
  return {
    at,
    method: details.method.slice(0, 16),
    origin: url.origin,
    path: `${url.pathname}${url.search}`.slice(0, MAX_NETWORK_PATH),
    status: details.statusCode,
    bytes: announcedBytes(details.responseHeaders),
  }
}

export class NetworkLog {
  private readonly rings = new Map<string, NetworkEntry[]>()
  private readonly listeners = new Set<(pageId: string) => void>()

  constructor(
    buffers: { subscribe(listener: (list: BufferList) => void): unknown },
    private readonly now: () => number = Date.now,
  ) {
    buffers.subscribe((list) => {
      const alive = new Set(list.buffers.map((buffer) => buffer.id))
      for (const id of [...this.rings.keys()]) if (!alive.has(id)) this.rings.delete(id)
    })
  }

  /** One completed request of a page buffer. */
  record(pageId: string, details: CompletedRequest): void {
    const entry = networkEntry(details, this.now())
    if (entry === null) return
    let ring = this.rings.get(pageId)
    if (ring === undefined) {
      ring = []
      this.rings.set(pageId, ring)
    }
    ring.push(entry)
    if (ring.length > NETWORK_RING) ring.splice(0, ring.length - NETWORK_RING)
    for (const listener of [...this.listeners]) listener(pageId)
  }

  /** Every entry a page holds, oldest first. */
  read(pageId: string): readonly NetworkEntry[] {
    return [...(this.rings.get(pageId) ?? [])]
  }

  /** Hears the page of every request recorded. */
  on(listener: (pageId: string) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
}
