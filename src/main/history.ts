import type { DatabaseSync } from 'node:sqlite'
import type { PageEvent } from '../shared/buffers'
import type { PaletteCandidate } from '../shared/palette'
import type { UrlEntry, UrlStore } from './url-sources'

/**
 * The history (#125): every committed top-frame navigation of a page buffer,
 * one row each in the profile's database (store.ts), with its URL, its
 * title, its time, the buffer it happened in and the visit it came from, so
 * the tree of where the user went is reconstructible from the rows alone.
 *
 * `recordHistory` reads a window's page stream (#119): a `committed` event
 * is a visit, the `title-changed` events after it name that visit. A page in
 * the `ephemeral` partition is never recorded: its events are dropped
 * before a row exists. Nothing of a page beyond its URL and title is
 * stored.
 *
 * The history is a `UrlStore`, so open-url lists it (#124), most recent
 * first; `open-from-history` reads over it alone and `show-history` shows
 * it in a buffer.
 */

/** One visit: a row of the history table. */
export interface Visit {
  readonly id: number
  readonly url: string
  readonly title: string
  /** Milliseconds since the epoch. */
  readonly visitedAt: number
  /** The page buffer the visit happened in, by its id in that run. */
  readonly buffer: string
  /** The visit in the same buffer this one came from, or null for the first. */
  readonly parent: number | null
}

/** The URLs a list or a palette shows at most. */
export const MAX_HISTORY = 500

/** A title longer than this is cut, as the buffer list cuts it. */
const MAX_TITLE = 200

interface VisitRow {
  readonly id: number
  readonly url: string
  readonly title: string
  readonly visited_at: number
  readonly buffer: string
  readonly parent: number | null
}

export class History implements UrlStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => number = Date.now,
  ) {}

  /** Records a visit and answers its id. */
  record(url: string, buffer: string, parent: number | null = null): number {
    const result = this.db
      .prepare('INSERT INTO history (url, visited_at, buffer, parent) VALUES (?, ?, ?, ?)')
      .run(url, this.now(), buffer, parent)
    return Number(result.lastInsertRowid)
  }

  /** Names a visit with the title its page gave. */
  retitle(id: number, title: string): void {
    this.db
      .prepare('UPDATE history SET title = ? WHERE id = ?')
      .run(title.replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE), id)
  }

  /** The visits, most recent first. */
  visits(limit: number = MAX_HISTORY): readonly Visit[] {
    const rows = this.db
      .prepare(
        'SELECT id, url, title, visited_at, buffer, parent FROM history ORDER BY id DESC LIMIT ?',
      )
      .all(limit) as unknown as VisitRow[]
    return rows.map((row) => ({
      id: row.id,
      url: row.url,
      title: row.title,
      visitedAt: row.visited_at,
      buffer: row.buffer,
      parent: row.parent,
    }))
  }

  /** Each URL once, its last visit first, under the title of that visit. */
  entries(): readonly UrlEntry[] {
    // SQLite takes the bare columns of a MAX() aggregate from the row that has the max.
    const rows = this.db
      .prepare(
        'SELECT url, title, MAX(id) AS last FROM history GROUP BY url ORDER BY last DESC LIMIT ?',
      )
      .all(MAX_HISTORY) as unknown as { url: string; title: string }[]
    return rows.map((row) =>
      row.title.length > 0 ? { url: row.url, title: row.title } : { url: row.url },
    )
  }
}

/** What `recordHistory` reads of the page buffers. */
export interface HistorySource {
  onPageEvent(listener: (event: PageEvent) => void): () => void
  /** The partition of a page buffer, or undefined when it holds no page any more. */
  partitionOf(id: string): 'persistent' | 'ephemeral' | undefined
}

/**
 * Feeds one window's page stream into `history`: a committed top-frame
 * navigation of a persistent page is a visit, child of the last visit of
 * the same buffer; a title names the last visit. Answers the unsubscribe.
 */
export function recordHistory(pages: HistorySource, history: History): () => void {
  const last = new Map<string, number>()
  return pages.onPageEvent((event) => {
    // Never a row for the ephemeral partition (#125, Do not touch), nor for a page gone.
    if (pages.partitionOf(event.pageId) !== 'persistent') {
      last.delete(event.pageId)
      return
    }
    if (event.type === 'committed') {
      if (!isWebUrl(event.url)) return
      last.set(
        event.pageId,
        history.record(event.url, event.pageId, last.get(event.pageId) ?? null),
      )
    } else if (event.type === 'title-changed') {
      const visit = last.get(event.pageId)
      if (visit !== undefined) history.retitle(visit, event.title)
    }
  })
}

/** The palette's candidates for `open-from-history`: one per URL, its last visit first. */
export function historyCandidates(history: UrlStore): readonly PaletteCandidate[] {
  return history.entries().map((entry) => ({
    id: entry.url,
    label: entry.title === undefined ? entry.url : `${entry.title}  ${entry.url}`,
    doc: `History: ${entry.url}`,
  }))
}

/** The text `show-history` shows: one line per visit, most recent first. */
export function historyText(visits: readonly Visit[]): string {
  if (visits.length === 0) return 'History\n\nNo page visited yet.\n'
  const lines = visits.map((visit) => {
    const title = visit.title.length > 0 ? `${visit.title}  ` : ''
    return `${formatTime(visit.visitedAt)}  ${title}${visit.url}`
  })
  return `History, most recent first\n\n${lines.join('\n')}\n`
}

/** A visit's time as the history lists it, local time to the minute. */
export function formatTime(ms: number): string {
  const at = new Date(ms)
  const two = (value: number): string => String(value).padStart(2, '0')
  return `${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())} ${two(at.getHours())}:${two(at.getMinutes())}`
}

function isWebUrl(url: string): boolean {
  return url.startsWith('https://') || url.startsWith('http://')
}
