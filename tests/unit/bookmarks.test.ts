import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { rankCandidates } from '../../src/shared/palette'
import {
  bookmarkCandidates,
  Bookmarks,
  bookmarksOrg,
  bookmarksText,
  orgTags,
  parseTags,
} from '../../src/main/bookmarks'
import { openStore, STORE_FILE } from '../../src/main/store'

describe('parseTags', () => {
  it('reads words split on spaces, commas or colons, lowercased, each once', () => {
    expect(parseTags('Rust, docs :rust:#Ref')).toEqual(['rust', 'docs', 'ref'])
    expect(parseTags('   ')).toEqual([])
  })

  it('refuses a word an Org tag cannot carry', () => {
    expect(() => parseTags('a-b')).toThrow(/not a tag/)
    expect(() => parseTags('ok [x]')).toThrow(TypeError)
  })

  it('writes tags as Org does', () => {
    expect(orgTags(['a', 'b'])).toBe(':a:b:')
    expect(orgTags([])).toBe('')
  })
})

describe('bookmarks', () => {
  let dir: string
  let db: DatabaseSync
  let clock: number
  let bookmarks: Bookmarks

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nemesis-bookmarks-'))
    db = openStore(join(dir, STORE_FILE))
    clock = Date.UTC(2026, 9, 19, 12)
    bookmarks = new Bookmarks(db, () => (clock += 60_000))
  })

  afterEach(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('keeps a page with its tags, newest first, and replaces it when kept again', () => {
    bookmarks.add('https://a.test/', 'Page A', ['rust'])
    bookmarks.add('https://b.test/', 'Page B', ['docs', 'rust'])
    bookmarks.add('https://a.test/', 'Page A, again', ['ref'])
    expect(bookmarks.list().map((one) => [one.url, one.title, one.tags])).toEqual([
      ['https://b.test/', 'Page B', ['docs', 'rust']],
      ['https://a.test/', 'Page A, again', ['ref']],
    ])
    expect(bookmarks.tags()).toEqual(['docs', 'ref', 'rust'])
    expect(bookmarks.tagged('RUST').map((one) => one.url)).toEqual(['https://b.test/'])
    expect(bookmarks.entries()).toEqual([
      { url: 'https://b.test/', title: 'Page B' },
      { url: 'https://a.test/', title: 'Page A, again' },
    ])
  })

  it('is found in the palette by a tag or by a word of its title', () => {
    bookmarks.add('https://a.test/', 'Alpha', ['zebra'])
    bookmarks.add('https://b.test/', 'Beta', ['docs'])
    const candidates = bookmarkCandidates(bookmarks.list())
    expect(rankCandidates(':zebra:', candidates).map((one) => one.id)).toEqual(['https://a.test/'])
    expect(rankCandidates('Beta', candidates)[0]?.id).toBe('https://b.test/')
  })

  it('exports to an Org file, one heading per bookmark with its tags', () => {
    bookmarks.add('https://a.test/?q=[x]', 'A [draft]', ['rust', 'docs'])
    bookmarks.add('https://b.test/', '', [])
    const path = bookmarks.exportOrg(join(dir, 'sessions', 'bookmarks.org'))
    const text = readFileSync(path, 'utf8')
    expect(text).toBe(bookmarksOrg(bookmarks.list()))
    expect(text.startsWith('#+title: Nemesis bookmarks\n')).toBe(true)
    expect(text).toContain('* [[https://b.test/][https://b.test/]]\n')
    expect(text).toContain('* [[https://a.test/?q=%5Bx%5D][A (draft)]] :rust:docs:\n')
  })

  it('shows the bookmarks in a buffer', () => {
    expect(bookmarksText([])).toContain('No bookmark yet')
    bookmarks.add('https://a.test/', 'Alpha', ['zebra'])
    expect(bookmarksText(bookmarks.list())).toContain('Alpha  https://a.test/  :zebra:')
  })
})
