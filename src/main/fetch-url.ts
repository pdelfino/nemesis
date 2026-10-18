import type { AgentEvent, AgentEventListener } from './agent/events'
import { CommandError } from './commands/registry'

/**
 * A URL into the prompt as text (#83): the guide's "give URLs" without the
 * agent fetching anything itself. `fetch-url` reads a URL, the main process
 * fetches it with Node's `fetch`, and the text lands in the prompt wrapped
 * by src/main/agent/boundary.ts as untrusted content from its origin.
 *
 * The fetch is traffic the user asked for by command and goes nowhere else,
 * so it is narrow on purpose: `https:` only, ten seconds, two hundred
 * kilobytes, text content types only, no cookies (Node's fetch has no jar
 * and none is given), and a redirect is followed only within the origin
 * asked for. HTML is reduced to its text: scripts, styles and comments are
 * dropped, tags become breaks or spaces, the common entities are decoded.
 * The notice says what was fetched and how many characters came out of it.
 *
 * Plain data, no Electron: the unit tests drive it with a fake fetch.
 */

export const FETCH_TIMEOUT_MS = 10_000
export const FETCH_LIMIT_BYTES = 200_000
/** Redirects followed within the origin before giving up. */
const MAX_REDIRECTS = 5

/** What a fetch came to: the text of the page and where it came from. */
export interface FetchedPage {
  /** The URL that answered, after any redirect within the origin. */
  readonly url: string
  /** Scheme and host, the name the wrapper heads the block with. */
  readonly origin: string
  readonly text: string
}

/** The slice of `fetch` the fetcher uses, so a test can hand in its own. */
export type FetchImpl = (url: string, init: RequestInit) => Promise<Response>

/** The URL as typed, or a CommandError that says what was expected. */
export function parseFetchUrl(text: string): URL {
  let url: URL
  try {
    url = new URL(text.trim())
  } catch {
    throw new CommandError(`Not a URL: ${text.trim()}`)
  }
  if (url.protocol !== 'https:') {
    throw new CommandError(`Only https: URLs are fetched, not ${url.protocol}`)
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw new CommandError('A URL with credentials in it is not fetched')
  }
  return url
}

/** Text content types only: a PDF or an image is not text for the prompt. */
export function isTextType(contentType: string | null): boolean {
  if (contentType === null) return false
  const type = contentType.split(';')[0]?.trim().toLowerCase() ?? ''
  return type.startsWith('text/')
}

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
}

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, entity: string) => {
    const lower = entity.toLowerCase()
    if (lower.startsWith('#x')) return String.fromCodePoint(Number.parseInt(lower.slice(2), 16))
    if (lower.startsWith('#')) return String.fromCodePoint(Number.parseInt(lower.slice(1), 10))
    return NAMED_ENTITIES[lower] ?? whole
  })
}

/** Tags that end a line of text when they open or close. */
const BLOCK_TAGS =
  'p|div|h[1-6]|li|ul|ol|dl|dt|dd|tr|td|th|table|thead|tbody|section|article|header|footer|nav|aside|main|blockquote|pre|hr|figure|figcaption|form|fieldset|address'

/** The text of an HTML page: what a reader would see, one block per line. */
export function htmlToText(html: string): string {
  const stripped = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|template|svg|head)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(new RegExp(`</?(?:${BLOCK_TAGS})\\b[^>]*>`, 'gi'), '\n')
    .replace(/<[^>]+>/g, ' ')
  return decodeEntities(stripped)
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export interface UrlFetcherOptions {
  /** Injected by the tests; production uses Node's fetch. */
  readonly fetch?: FetchImpl | undefined
  readonly timeoutMs?: number | undefined
  readonly limitBytes?: number | undefined
}

export class UrlFetcher {
  private readonly fetchImpl: FetchImpl
  private readonly timeoutMs: number
  private readonly limitBytes: number
  private readonly listeners = new Set<AgentEventListener>()

  constructor(options: UrlFetcherOptions = {}) {
    this.fetchImpl = options.fetch ?? ((url, init) => fetch(url, init))
    this.timeoutMs = options.timeoutMs ?? FETCH_TIMEOUT_MS
    this.limitBytes = options.limitBytes ?? FETCH_LIMIT_BYTES
  }

  /** The session bridge subscribes: the notice is shown and recorded like any event. */
  on(listener: AgentEventListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** Fetches the page as text, within the limits above. Rejects with a message safe to show. */
  async fetchText(text: string): Promise<FetchedPage> {
    const asked = parseFetchUrl(text)
    let url = asked
    for (let hop = 0; ; hop += 1) {
      const response = await this.fetchImpl(url.href, {
        method: 'GET',
        redirect: 'manual',
        credentials: 'omit',
        headers: { accept: 'text/html, text/plain;q=0.9, text/*;q=0.8' },
        signal: AbortSignal.timeout(this.timeoutMs),
      })
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel().catch(() => undefined)
        const location = response.headers.get('location')
        if (location === null) throw new CommandError(`${url.host} redirected nowhere`)
        const next = new URL(location, url)
        if (next.origin !== asked.origin || next.protocol !== 'https:') {
          throw new CommandError(`${url.host} redirects to ${next.origin}; not followed`)
        }
        if (hop >= MAX_REDIRECTS) throw new CommandError(`${url.host} redirects too many times`)
        url = next
        continue
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined)
        throw new CommandError(`${url.host} answered ${response.status}`)
      }
      const contentType = response.headers.get('content-type')
      if (!isTextType(contentType)) {
        await response.body?.cancel().catch(() => undefined)
        throw new CommandError(
          `${url.host} answered with ${contentType ?? 'no content type'}, not text`,
        )
      }
      const body = await this.readLimited(response)
      const page = (contentType ?? '').toLowerCase().startsWith('text/html')
        ? htmlToText(body)
        : body.replace(/\r\n?/g, '\n').trim()
      this.notify(
        `Fetched ${url.href}: ${page.length} characters of text, in the prompt as untrusted content from ${url.origin}.`,
      )
      return { url: url.href, origin: url.origin, text: page }
    }
  }

  /** The body up to the limit, decoded as UTF-8; the rest is never read. */
  private async readLimited(response: Response): Promise<string> {
    const stream = response.body
    if (stream === null) return ''
    const decoder = new TextDecoder('utf-8')
    const reader = stream.getReader()
    let text = ''
    let read = 0
    try {
      while (read < this.limitBytes) {
        const { value, done } = await reader.read()
        if (done) break
        const room = this.limitBytes - read
        const chunk = value.byteLength > room ? value.subarray(0, room) : value
        read += chunk.byteLength
        text += decoder.decode(chunk, { stream: true })
      }
    } finally {
      await reader.cancel().catch(() => undefined)
    }
    return text + decoder.decode()
  }

  private notify(text: string): void {
    const event: AgentEvent = { type: 'notice', text }
    for (const listener of [...this.listeners]) listener(event)
  }
}
