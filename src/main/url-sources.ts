import type { PaletteCandidate } from '../shared/palette'
import { upgradeOf } from './security/transport'

/**
 * What `open-url` reads over (#124), the way Nyxt's `set-url` does: one
 * palette over the bookmarks, the history, the search engines and the text
 * typed, in that order.
 *
 * - The bookmarks and the history are stores behind `UrlStore`; until M4.7
 *   (#125) fills them they are `EMPTY_STORE`, so the read does not wait.
 * - The search engines are a setting (`searchEngines`), DuckDuckGo on `ddg`
 *   by default. `kw query` searches the engine named `kw`; a bare word, with
 *   no dot, no scheme and no port, searches the first engine.
 * - The text typed is the last source: the palette's free text, read as a
 *   URL by `resolveUrl`.
 *
 * Every answer goes through `resolveUrl` once: a search becomes the engine's
 * URL, a host gets `https:`, and plain `http:` off loopback takes the
 * upgrade of #52. Whether the result may open is the navigation policy's to
 * say, in the page buffers (#48); nothing here turns a refused scheme into
 * an allowed one.
 */

/** One search engine of the setting: `%s` in `url` takes the query, encoded. */
export interface SearchEngine {
  readonly keyword: string
  readonly name: string
  readonly url: string
}

/** One URL a store lists, with the title it was saved under, if any. */
export interface UrlEntry {
  readonly url: string
  readonly title?: string
}

/** The bookmarks or the history (M4.7): the entries in the order the palette shows them. */
export interface UrlStore {
  entries(): readonly UrlEntry[]
}

/** A store with nothing in it, until #125 lands the real ones. */
export const EMPTY_STORE: UrlStore = { entries: () => [] }

/** What `open-url` reads over: the two stores and the engines, read at use time. */
export interface UrlSources {
  readonly bookmarks: UrlStore
  /** Most recent first: the store's order is the palette's. */
  readonly history: UrlStore
  engines(): readonly SearchEngine[]
}

export const DEFAULT_SEARCH_ENGINES: readonly SearchEngine[] = [
  { keyword: 'ddg', name: 'DuckDuckGo', url: 'https://duckduckgo.com/?q=%s' },
]

export const DEFAULT_URL_SOURCES: UrlSources = {
  bookmarks: EMPTY_STORE,
  history: EMPTY_STORE,
  engines: () => DEFAULT_SEARCH_ENGINES,
}

/** The placeholder an engine's URL carries for the query. */
const QUERY_SLOT = '%s'
/** A keyword is one word a user types before the query. */
const KEYWORD = /^[a-z0-9][a-z0-9_-]{0,31}$/i
/** The candidates of one store the palette lists at most. */
const MAX_ENTRIES = 500

/**
 * The `searchEngines` setting, checked by hand like the rest of settings.json:
 * a non-empty list of `{ keyword, name, url }`, each keyword one word and
 * used once, each URL an `http:` or `https:` URL with `%s` where the query
 * goes. The
 * first engine is the one a bare word searches. Throws a TypeError naming
 * what is wrong; settings.ts words it as a SettingsError.
 */
export function parseSearchEngines(value: unknown): readonly SearchEngine[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError('is not a list of search engines')
  }
  const seen = new Set<string>()
  return value.map((raw: unknown, index) => {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new TypeError(`entry ${index} is not an object`)
    }
    const entry = raw as Record<string, unknown>
    for (const key of Object.keys(entry)) {
      if (!['keyword', 'name', 'url'].includes(key)) {
        throw new TypeError(`entry ${index} has an unknown key "${key}"`)
      }
    }
    const { keyword, name, url } = entry
    if (typeof keyword !== 'string' || !KEYWORD.test(keyword)) {
      throw new TypeError(`entry ${index} has no keyword of one word`)
    }
    if (seen.has(keyword.toLowerCase())) {
      throw new TypeError(`keyword "${keyword}" is used twice`)
    }
    seen.add(keyword.toLowerCase())
    if (typeof name !== 'string' || name.trim().length === 0) {
      throw new TypeError(`entry ${index} has no name`)
    }
    if (typeof url !== 'string' || !url.includes(QUERY_SLOT) || !isWebUrl(url)) {
      throw new TypeError(`entry ${index} has no http: or https: URL with %s for the query`)
    }
    return { keyword, name: name.trim(), url }
  })
}

/** The engine's URL for `query`, encoded into the `%s` slot. */
export function searchUrl(engine: SearchEngine, query: string): string {
  return engine.url.split(QUERY_SLOT).join(encodeURIComponent(query))
}

/**
 * The URL text typed at `open-url` names, normalized once:
 *
 * - `kw query`, with `kw` an engine's keyword, is that engine's search;
 * - a bare word (no dot, no scheme, no port, not `localhost`) or text with
 *   a space in it is a search on the first engine;
 * - text with a scheme keeps it, and plain `http:` takes the transport
 *   upgrade when it applies (#52);
 * - anything else is a host, opened on `https:`.
 *
 * A scheme the page policy refuses (`file:`, `javascript:`) is kept as
 * typed, so the policy sees it and refuses it.
 */
export function resolveUrl(text: string, engines: readonly SearchEngine[]): string {
  const trimmed = text.trim()
  const space = trimmed.search(/\s/)
  if (space > 0) {
    const keyword = trimmed.slice(0, space).toLowerCase()
    const engine = engines.find((one) => one.keyword.toLowerCase() === keyword)
    if (engine !== undefined) return searchUrl(engine, trimmed.slice(space).trim())
  }
  const alone = engines.find((one) => one.keyword.toLowerCase() === trimmed.toLowerCase())
  if (alone !== undefined) return searchUrl(alone, '')
  const fallback = engines[0]
  if (fallback !== undefined && isSearch(trimmed)) return searchUrl(fallback, trimmed)
  return normalizeUrl(trimmed)
}

/** A typed URL with its scheme: `https:` added to a host, the upgrade of #52 applied. */
export function normalizeUrl(text: string): string {
  const trimmed = text.trim()
  const url = hasScheme(trimmed) ? trimmed : `https://${trimmed}`
  return upgradeOf(url) ?? url
}

/**
 * The palette's candidates for `open-url`, in the order of #124: bookmarks,
 * history (each URL once, a bookmark's first), then the search engines. The
 * text typed is the read's free text, after them all.
 */
export function urlCandidates(sources: UrlSources): readonly PaletteCandidate[] {
  const seen = new Set<string>()
  const fromStore = (store: UrlStore, kind: string): PaletteCandidate[] =>
    store
      .entries()
      .slice(0, MAX_ENTRIES)
      .flatMap((entry) => {
        if (typeof entry.url !== 'string' || entry.url.length === 0 || seen.has(entry.url)) {
          return []
        }
        seen.add(entry.url)
        const title = entry.title?.trim() ?? ''
        return [
          {
            id: entry.url,
            label: entry.url,
            doc: title.length > 0 ? `${kind}: ${title}` : kind,
            ...(title.length > 0 ? { detail: title } : {}),
          },
        ]
      })
  return [
    ...fromStore(sources.bookmarks, 'Bookmark'),
    ...fromStore(sources.history, 'History'),
    ...sources.engines().map((engine, index) => ({
      id: engine.keyword,
      label: engine.keyword,
      detail: engine.name,
      doc: `Type "${engine.keyword} query" to search ${engine.name}${index === 0 ? ', the engine a bare word searches' : ''}.`,
    })),
  ]
}

/** Text with a scheme of its own; `localhost:3000` is a host and a port, not a scheme. */
function hasScheme(text: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(text) && !/^[a-z0-9.-]+:\d+(?:[/?#]|$)/i.test(text)
}

/** Whether typed text is a search rather than an address. */
function isSearch(text: string): boolean {
  if (text.length === 0) return false
  if (/\s/.test(text)) return !hasScheme(text)
  if (hasScheme(text)) return false
  const host = text.split(/[/?#]/, 1)[0] ?? ''
  if (/:\d+$/.test(host)) return false
  return !host.includes('.') && host.toLowerCase() !== 'localhost'
}

function isWebUrl(text: string): boolean {
  try {
    const { protocol } = new URL(text.replace(QUERY_SLOT, 'q'))
    return protocol === 'https:' || protocol === 'http:'
  } catch {
    return false
  }
}
