import { describe, expect, it } from 'vitest'
import { navigationAllowed } from '../../src/main/security/navigation-policy'
import {
  DEFAULT_SEARCH_ENGINES,
  DEFAULT_URL_SOURCES,
  EMPTY_STORE,
  normalizeUrl,
  parseSearchEngines,
  resolveUrl,
  searchUrl,
  urlCandidates,
  type SearchEngine,
} from '../../src/main/url-sources'

const ENGINES: readonly SearchEngine[] = [
  ...DEFAULT_SEARCH_ENGINES,
  { keyword: 'gh', name: 'GitHub', url: 'https://github.com/search?q=%s' },
]

describe('normalizeUrl (#124)', () => {
  it('adds https: to a host and keeps a scheme that is there', () => {
    expect(normalizeUrl('  example.test/docs ')).toBe('https://example.test/docs')
    expect(normalizeUrl('https://example.test/a?b=1')).toBe('https://example.test/a?b=1')
    expect(normalizeUrl('localhost:3000/x')).toBe('https://localhost:3000/x')
  })

  it('applies the transport upgrade of #52 to plain http: off loopback, and only there', () => {
    expect(normalizeUrl('http://example.test/a')).toBe('https://example.test/a')
    expect(normalizeUrl('http://127.0.0.1:8080/')).toBe('http://127.0.0.1:8080/')
    expect(normalizeUrl('http://localhost:5173')).toBe('http://localhost:5173')
  })
})

describe('resolveUrl (#124)', () => {
  it('reads "kw query" as a search on the engine of that keyword, the query encoded', () => {
    expect(resolveUrl('ddg cats & dogs', ENGINES)).toBe(
      'https://duckduckgo.com/?q=cats%20%26%20dogs',
    )
    expect(resolveUrl('GH  nemesis', ENGINES)).toBe('https://github.com/search?q=nemesis')
    expect(resolveUrl('gh', ENGINES)).toBe('https://github.com/search?q=')
  })

  it('searches the first engine for a bare word or a phrase', () => {
    expect(resolveUrl('nemesis', ENGINES)).toBe('https://duckduckgo.com/?q=nemesis')
    expect(resolveUrl('electron web contents', ENGINES)).toBe(
      'https://duckduckgo.com/?q=electron%20web%20contents',
    )
  })

  it('opens what looks like an address as one', () => {
    expect(resolveUrl('example.test', ENGINES)).toBe('https://example.test')
    expect(resolveUrl('localhost', ENGINES)).toBe('https://localhost')
    expect(resolveUrl('localhost:3000', ENGINES)).toBe('https://localhost:3000')
    expect(resolveUrl('http://127.0.0.1:4000/page.html', ENGINES)).toBe(
      'http://127.0.0.1:4000/page.html',
    )
    expect(resolveUrl('http://example.test/', ENGINES)).toBe('https://example.test/')
  })

  it('keeps a refused scheme as typed, so the navigation policy refuses it (#48)', () => {
    for (const typed of ['javascript:alert(1)', 'file:///etc/hosts', 'data:text/html,hi']) {
      const url = resolveUrl(typed, ENGINES)
      expect(url).toBe(typed)
      expect(navigationAllowed('page', url)).toBe(false)
    }
    // A search never comes out on a refused scheme.
    expect(navigationAllowed('page', resolveUrl('file', ENGINES))).toBe(true)
  })
})

describe('the searchEngines setting (#124)', () => {
  it('takes engines with a keyword, a name and a URL with %s', () => {
    expect(
      parseSearchEngines([{ keyword: 'fx', name: ' Fixture ', url: 'http://127.0.0.1:1/?q=%s' }]),
    ).toEqual([{ keyword: 'fx', name: 'Fixture', url: 'http://127.0.0.1:1/?q=%s' }])
    expect(searchUrl({ keyword: 'a', name: 'A', url: 'https://a.test/%s/%s' }, 'x y')).toBe(
      'https://a.test/x%20y/x%20y',
    )
  })

  it('rejects what it cannot use', () => {
    expect(() => parseSearchEngines([])).toThrow(/not a list/)
    expect(() => parseSearchEngines('ddg')).toThrow(/not a list/)
    expect(() =>
      parseSearchEngines([{ keyword: 'two words', name: 'X', url: 'https://x.test/?q=%s' }]),
    ).toThrow(/keyword/)
    expect(() =>
      parseSearchEngines([
        { keyword: 'x', name: 'X', url: 'https://x.test/?q=%s' },
        { keyword: 'X', name: 'Y', url: 'https://y.test/?q=%s' },
      ]),
    ).toThrow(/used twice/)
    expect(() => parseSearchEngines([{ keyword: 'x', name: 'X', url: 'https://x.test/' }])).toThrow(
      /%s/,
    )
    expect(() => parseSearchEngines([{ keyword: 'x', name: 'X', url: 'javascript:%s' }])).toThrow(
      /%s/,
    )
    expect(() =>
      parseSearchEngines([{ keyword: 'x', name: '', url: 'https://x.test/?q=%s' }]),
    ).toThrow(/name/)
    expect(() =>
      parseSearchEngines([{ keyword: 'x', name: 'X', url: 'https://x.test/?q=%s', extra: 1 }]),
    ).toThrow(/unknown key "extra"/)
  })
})

describe('urlCandidates (#124)', () => {
  it('lists bookmarks, then history, then the engines, each URL once', () => {
    const candidates = urlCandidates({
      bookmarks: { entries: () => [{ url: 'https://a.test/', title: 'A' }] },
      history: {
        entries: () => [{ url: 'https://b.test/' }, { url: 'https://a.test/', title: 'again' }],
      },
      engines: () => ENGINES,
    })
    expect(candidates.map((candidate) => candidate.id)).toEqual([
      'https://a.test/',
      'https://b.test/',
      'ddg',
      'gh',
    ])
    expect(candidates[0]).toMatchObject({
      label: 'https://a.test/',
      detail: 'A',
      doc: 'Bookmark: A',
    })
    expect(candidates[1]?.doc).toBe('History')
    expect(candidates[2]).toMatchObject({ label: 'ddg', detail: 'DuckDuckGo' })
  })

  it('has only the default engine until the stores of #125 land', () => {
    expect(EMPTY_STORE.entries()).toEqual([])
    expect(urlCandidates(DEFAULT_URL_SOURCES).map((candidate) => candidate.id)).toEqual(['ddg'])
  })
})
