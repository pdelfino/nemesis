import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { PageEvent } from '../../src/shared/buffers'
import {
  History,
  historyCandidates,
  historyText,
  recordHistory,
  type HistorySource,
} from '../../src/main/history'
import { openStore, STORE_FILE } from '../../src/main/store'
import { urlCandidates } from '../../src/main/url-sources'

/** A page stream the test drives, with a partition per page. */
function fakePages(partitions: Record<string, 'persistent' | 'ephemeral'>): HistorySource & {
  emit(event: PageEvent): void
} {
  const listeners = new Set<(event: PageEvent) => void>()
  return {
    onPageEvent: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    partitionOf: (id) => partitions[id],
    emit: (event) => {
      for (const listener of listeners) listener(event)
    },
  }
}

describe('history', () => {
  let dir: string
  let db: DatabaseSync
  let clock: number
  let history: History

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nemesis-history-'))
    db = openStore(join(dir, STORE_FILE))
    clock = 1_000
    history = new History(db, () => (clock += 1_000))
  })

  afterEach(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('records committed navigations of a persistent page as a chain, titled by the page', () => {
    const pages = fakePages({ 'buffer-1': 'persistent' })
    recordHistory(pages, history)
    pages.emit({ type: 'committed', pageId: 'buffer-1', url: 'https://a.test/' })
    pages.emit({ type: 'title-changed', pageId: 'buffer-1', title: 'Page  A' })
    pages.emit({ type: 'committed', pageId: 'buffer-1', url: 'https://b.test/' })
    const [second, first] = history.visits()
    expect(first).toMatchObject({
      url: 'https://a.test/',
      title: 'Page A',
      buffer: 'buffer-1',
      parent: null,
    })
    expect(second).toMatchObject({ url: 'https://b.test/', title: '', parent: first?.id })
    expect(second?.visitedAt).toBeGreaterThan(first?.visitedAt ?? Infinity)
  })

  it('never writes a row for an ephemeral page, nor for anything but a committed web URL', () => {
    const pages = fakePages({ 'buffer-1': 'ephemeral', 'buffer-2': 'persistent' })
    recordHistory(pages, history)
    pages.emit({ type: 'committed', pageId: 'buffer-1', url: 'https://secret.test/' })
    pages.emit({ type: 'title-changed', pageId: 'buffer-1', title: 'Secret' })
    pages.emit({ type: 'url-changed', pageId: 'buffer-2', url: 'https://a.test/#x' })
    pages.emit({ type: 'redirect', pageId: 'buffer-2', url: 'https://a.test/r' })
    pages.emit({ type: 'committed', pageId: 'buffer-2', url: 'data:text/html,x' })
    pages.emit({ type: 'committed', pageId: 'gone', url: 'https://gone.test/' })
    expect(history.visits()).toEqual([])
    expect(db.prepare('SELECT COUNT(*) AS n FROM history').get()).toEqual({ n: 0 })
  })

  it('stops recording once unsubscribed', () => {
    const pages = fakePages({ 'buffer-1': 'persistent' })
    const stop = recordHistory(pages, history)
    stop()
    pages.emit({ type: 'committed', pageId: 'buffer-1', url: 'https://a.test/' })
    expect(history.visits()).toEqual([])
  })

  it('lists each URL once for open-url, its last visit first', () => {
    history.retitle(history.record('https://a.test/', 'buffer-1'), 'A')
    history.record('https://b.test/', 'buffer-1')
    history.retitle(history.record('https://a.test/', 'buffer-2'), 'A again')
    expect(history.entries()).toEqual([
      { url: 'https://a.test/', title: 'A again' },
      { url: 'https://b.test/' },
    ])
    expect(historyCandidates(history).map((one) => one.label)).toEqual([
      'A again  https://a.test/',
      'https://b.test/',
    ])
    const fromOpenUrl = urlCandidates({
      bookmarks: { entries: () => [] },
      history,
      engines: () => [],
    })
    expect(fromOpenUrl.map((one) => one.id)).toEqual(['https://a.test/', 'https://b.test/'])
  })

  it('shows the visits in a buffer, most recent first', () => {
    expect(historyText([])).toContain('No page visited yet')
    history.retitle(history.record('https://a.test/', 'buffer-1'), 'A')
    history.record('https://b.test/', 'buffer-1')
    const text = historyText(history.visits())
    expect(text.indexOf('https://b.test/')).toBeLessThan(text.indexOf('A  https://a.test/'))
  })
})
