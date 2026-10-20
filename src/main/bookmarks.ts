import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { PaletteCandidate } from '../shared/palette'
import { parseBookmarksHtml } from './bookmarks-html'
import { formatTime } from './history'
import type { UrlEntry, UrlStore } from './url-sources'

/**
 * The bookmarks (#125): a page kept with its title and tags, one row per URL
 * in the profile's database (store.ts). `bookmark-page` (`C-x r m`, Emacs's
 * bookmark-set) stores the current page with the tags read in the palette;
 * bookmarking a URL again replaces its title and tags.
 *
 * The bookmarks are a `UrlStore`, so open-url lists them first (#124);
 * `open-bookmark` reads over them alone, labeled with their title and their
 * tags so a tag or a word of the title filters them; `show-bookmarks` shows
 * them in a buffer; `export-bookmarks` writes them as an Org file in the
 * sessions folder.
 *
 * A tag is one word of letters, digits and `_`, the characters an Org tag
 * takes, so the export is valid Org with the tags as the headings' tags.
 */

export interface Bookmark {
  readonly url: string
  readonly title: string
  readonly tags: readonly string[]
  /** Milliseconds since the epoch. */
  readonly createdAt: number
}

/** The export's file name in the sessions folder. */
export const BOOKMARKS_EXPORT = 'bookmarks.org'

/** The largest bookmark file import-bookmarks-from-html reads. */
const MAX_IMPORT_BYTES = 20 * 1024 * 1024

/** An Org tag: letters, digits and `_`. */
const TAG = /^[\p{L}\p{N}_]{1,40}$/u
/** The tags one bookmark carries at most. */
const MAX_TAGS = 20
const MAX_TITLE = 200

interface BookmarkRow {
  readonly url: string
  readonly title: string
  readonly tags: string
  readonly created_at: number
}

/**
 * The tags of the text typed at bookmark-page: words split on spaces, commas
 * or colons (`:a:b:` is Org's own spelling), a leading `#` dropped,
 * lowercased, each once. Throws a TypeError naming a word that is no tag.
 */
export function parseTags(text: string): readonly string[] {
  const tags: string[] = []
  for (const word of text.split(/[\s,:]+/)) {
    const tag = word.replace(/^#/, '').toLowerCase()
    if (tag.length === 0) continue
    if (!TAG.test(tag)) {
      throw new TypeError(`"${word.slice(0, 40)}" is not a tag: letters, digits and _ only`)
    }
    if (!tags.includes(tag)) tags.push(tag)
  }
  if (tags.length > MAX_TAGS) throw new TypeError(`More than ${MAX_TAGS} tags`)
  return tags
}

/** Tags as Org writes them after a heading: `:a:b:`, or nothing. */
export function orgTags(tags: readonly string[]): string {
  return tags.length === 0 ? '' : `:${tags.join(':')}:`
}

/** What an import did: links added, links skipped because they were already bookmarked. */
export interface ImportReport {
  readonly added: number
  readonly skipped: number
}

export class Bookmarks implements UrlStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => number = Date.now,
  ) {}

  /** Keeps `url` under `title` and `tags`, replacing an earlier bookmark of it. */
  add(url: string, title: string, tags: readonly string[]): Bookmark {
    const bookmark: Bookmark = {
      url,
      title: title.replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE),
      tags: [...tags],
      createdAt: this.now(),
    }
    this.db
      .prepare(
        `INSERT INTO bookmarks (url, title, tags, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(url) DO UPDATE SET title = excluded.title, tags = excluded.tags`,
      )
      .run(bookmark.url, bookmark.title, bookmark.tags.join(' '), bookmark.createdAt)
    return bookmark
  }

  /** The bookmark of `url`, or undefined. */
  get(url: string): Bookmark | undefined {
    return this.list().find((bookmark) => bookmark.url === url)
  }

  /** Replaces the title and tags of the bookmark of `url`, keeping its URL and date; false when there is none. */
  edit(url: string, title: string, tags: readonly string[]): boolean {
    const result = this.db
      .prepare('UPDATE bookmarks SET title = ?, tags = ? WHERE url = ?')
      .run(title.replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE), tags.join(' '), url)
    return Number(result.changes) > 0
  }

  /** Deletes the bookmarks of `urls`, and answers how many were there. */
  remove(urls: readonly string[]): number {
    const statement = this.db.prepare('DELETE FROM bookmarks WHERE url = ?')
    let removed = 0
    for (const url of urls) removed += Number(statement.run(url).changes)
    return removed
  }

  /**
   * Adds the links of a Netscape bookmark file (#175), folders as tags; a URL
   * already bookmarked is left as it is. Answers the counts.
   */
  importHtml(path: string): ImportReport {
    if (statSync(path).size > MAX_IMPORT_BYTES) throw new Error('That file is over 20 MB')
    const known = new Set(this.list().map((bookmark) => bookmark.url))
    let added = 0
    let skipped = 0
    for (const entry of parseBookmarksHtml(readFileSync(path, 'utf8'))) {
      if (known.has(entry.url)) {
        skipped += 1
        continue
      }
      known.add(entry.url)
      this.add(entry.url, entry.title, entry.tags.slice(0, MAX_TAGS))
      added += 1
    }
    return { added, skipped }
  }

  /** Every bookmark, the newest first. */
  list(): readonly Bookmark[] {
    const rows = this.db
      .prepare(
        'SELECT url, title, tags, created_at FROM bookmarks ORDER BY created_at DESC, rowid DESC',
      )
      .all() as unknown as BookmarkRow[]
    return rows.map((row) => ({
      url: row.url,
      title: row.title,
      tags: row.tags.length === 0 ? [] : row.tags.split(' '),
      createdAt: row.created_at,
    }))
  }

  /** The bookmarks carrying `tag`. */
  tagged(tag: string): readonly Bookmark[] {
    const wanted = tag.toLowerCase()
    return this.list().filter((bookmark) => bookmark.tags.includes(wanted))
  }

  /** Every tag in use, sorted. */
  tags(): readonly string[] {
    return [...new Set(this.list().flatMap((bookmark) => bookmark.tags))].sort()
  }

  entries(): readonly UrlEntry[] {
    return this.list().map((bookmark) =>
      bookmark.title.length > 0
        ? { url: bookmark.url, title: bookmark.title }
        : { url: bookmark.url },
    )
  }

  /** Writes every bookmark to `path` as Org, and answers the path. */
  exportOrg(path: string): string {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, bookmarksOrg(this.list()), { mode: 0o600 })
    return path
  }
}

/** The palette's candidates for `open-bookmark`: title, URL and tags in the label the query filters. */
export function bookmarkCandidates(bookmarks: readonly Bookmark[]): readonly PaletteCandidate[] {
  return bookmarks.map((bookmark) => {
    const tags = orgTags(bookmark.tags)
    return {
      id: bookmark.url,
      label: [bookmark.title, bookmark.url, tags].filter((part) => part.length > 0).join('  '),
      doc: `Bookmark: ${bookmark.url}`,
    }
  })
}

/** The palette's candidates for the tags bookmark-page reads: the tags in use. */
export function tagCandidates(tags: readonly string[]): readonly PaletteCandidate[] {
  return tags.map((tag) => ({
    id: tag,
    label: tag,
    doc: 'A tag in use; type several separated by spaces.',
  }))
}

/** The text `show-bookmarks` shows: one line per bookmark, the newest first. */
export function bookmarksText(bookmarks: readonly Bookmark[]): string {
  if (bookmarks.length === 0) return 'Bookmarks\n\nNo bookmark yet: C-x r m in a page keeps it.\n'
  const lines = bookmarks.map((bookmark) => {
    const parts = [bookmark.title, bookmark.url, orgTags(bookmark.tags)]
    return parts.filter((part) => part.length > 0).join('  ')
  })
  return `Bookmarks, newest first\n\n${lines.join('\n')}\n`
}

/** The bookmarks as an Org file: one heading per bookmark, a link with the tags. */
export function bookmarksOrg(bookmarks: readonly Bookmark[]): string {
  const headings = bookmarks.map((bookmark) => {
    // A bracket would close the link early: the URL takes it encoded, the title as a parenthesis.
    const url = bookmark.url.replace(/\[/g, '%5B').replace(/\]/g, '%5D')
    const title = (bookmark.title.length > 0 ? bookmark.title : bookmark.url)
      .replace(/\[/g, '(')
      .replace(/\]/g, ')')
    const tags = orgTags(bookmark.tags)
    return [
      `* [[${url}][${title}]]${tags.length > 0 ? ` ${tags}` : ''}`,
      `  [${formatTime(bookmark.createdAt)}]`,
    ].join('\n')
  })
  return ['#+title: Nemesis bookmarks', '', ...headings, ''].join('\n')
}
