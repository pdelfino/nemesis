import { describe, expect, it } from 'vitest'
import {
  INTERNAL_SCHEME,
  navigationAllowed,
  PAGE_SCHEMES,
} from '../../src/main/security/navigation-policy'

/**
 * The decision behind will-navigate, will-redirect and the window-open
 * handler (#48, SECURITY.org T1 and T3), on strings. The live guards are
 * exercised by the security specs; this is the table they implement.
 */
describe('navigationAllowed (SECURITY.org T1, T3)', () => {
  it('keeps a page buffer on http and https', () => {
    expect(navigationAllowed('page', 'https://example.test/path?q=1')).toBe(true)
    expect(navigationAllowed('page', 'http://127.0.0.1:8080/node-probe.html')).toBe(true)
    expect(PAGE_SCHEMES).toEqual(['http:', 'https:'])
  })

  it('refuses file, javascript and data for a page buffer', () => {
    expect(navigationAllowed('page', 'file:///etc/hosts')).toBe(false)
    expect(navigationAllowed('page', 'javascript:alert(1)')).toBe(false)
    expect(navigationAllowed('page', 'data:text/html,<h1>x</h1>')).toBe(false)
    expect(navigationAllowed('page', 'blob:https://example.test/uuid')).toBe(false)
    expect(navigationAllowed('page', 'about:blank')).toBe(false)
    expect(navigationAllowed('page', `${INTERNAL_SCHEME}//app/index.html`)).toBe(false)
  })

  it('keeps an internal page on the internal scheme and nowhere else', () => {
    expect(INTERNAL_SCHEME).toBe('nemesis:')
    expect(navigationAllowed('internal', 'nemesis://app/index.html')).toBe(true)
    expect(navigationAllowed('internal', 'https://example.test/')).toBe(false)
    expect(navigationAllowed('internal', 'http://localhost:5173/')).toBe(false)
    expect(navigationAllowed('internal', 'file:///etc/hosts')).toBe(false)
    expect(navigationAllowed('internal', 'javascript:void 0')).toBe(false)
    expect(navigationAllowed('internal', 'data:text/html,x')).toBe(false)
  })

  it('refuses what is not a URL, for either kind', () => {
    for (const kind of ['page', 'internal'] as const) {
      expect(navigationAllowed(kind, '')).toBe(false)
      expect(navigationAllowed(kind, 'not a url')).toBe(false)
      expect(navigationAllowed(kind, '//example.test/')).toBe(false)
    }
  })

  it('is case-insensitive on the scheme, as the URL parser is', () => {
    expect(navigationAllowed('page', 'HTTPS://example.test/')).toBe(true)
    expect(navigationAllowed('page', 'FILE:///etc/hosts')).toBe(false)
    expect(navigationAllowed('page', 'JavaScript:alert(1)')).toBe(false)
  })
})
