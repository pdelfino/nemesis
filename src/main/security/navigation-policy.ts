import type { WebContents } from 'electron'
import { originOf } from './permissions'
import { warnLimited } from './warn-limited'

/**
 * Where a WebContents may go and what it may spawn (#48, SECURITY.org T1 and T3).
 *
 * One function, `applyNavigationPolicy`, installs four guards on a
 * WebContents: `will-navigate` and `will-redirect` keep a page buffer on
 * `http:` and `https:` and an internal page on the internal scheme;
 * `setWindowOpenHandler` denies every window and hands an allowed URL to the
 * buffer manager instead; `will-attach-webview` always prevents. The fifth
 * guard the issue names, `navigateOnDragDrop` off, is a creation-time
 * preference and lives in HARDENED_WEB_PREFERENCES (#47).
 *
 * The guards read the kind at event time, not at install time, so the app can
 * apply the strict page policy to every WebContents the moment it exists
 * (`web-contents-created` in src/main/index.ts) and the creation site of an
 * internal page can correct the kind afterwards. A second call never installs
 * a second set of listeners.
 */

/** An internal page carries the preload bridge; a page buffer holds the web. */
export type ContentsKind = 'internal' | 'page'

/**
 * The privileged scheme internal pages are served from once #50 lands. The
 * cockpit loads from file:// until then, and file: is never a navigation
 * target, so an internal page cannot navigate at all today, which is what the
 * interim guard this module replaces did.
 */
export const INTERNAL_SCHEME = 'nemesis:'

/** The schemes a page buffer may navigate to or be redirected to (T3). */
export const PAGE_SCHEMES: readonly string[] = Object.freeze(['http:', 'https:'])

/** What the policy asks of the buffer manager when a page wants a window. */
export interface NavigationHost {
  /**
   * Opens `url` as a controlled buffer in place of the window the page asked
   * for. Only an allowed page URL ever reaches it. Absent until the page
   * buffer exists (M4, #73): a denied window with nothing in its place.
   */
  readonly openPage?: (url: string, opener: WebContents) => void
}

/** The scheme of a URL, or null when the string is not a URL at all. */
function schemeOf(url: string): string | null {
  try {
    return new URL(url).protocol
  } catch {
    return null
  }
}

/**
 * The decision, on its own so the unit tests can run it on strings. An
 * unparseable URL is refused for either kind.
 *
 * `allowedOrigins` is the development exception (#96): in a development run
 * the cockpit is loaded from the Vite server, and Vite's full page reload is
 * a navigation of that page to its own `http:` origin, which the internal
 * rule would refuse. Internal contents accept a URL whose origin is listed,
 * in addition to the internal scheme; a page buffer never reads the list.
 */
export function navigationAllowed(
  kind: ContentsKind,
  url: string,
  allowedOrigins: readonly string[] = [],
): boolean {
  const scheme = schemeOf(url)
  if (scheme === null) return false
  if (kind === 'page') return PAGE_SCHEMES.includes(scheme)
  if (scheme === INTERNAL_SCHEME) return true
  const origin = originOf(url)
  return origin !== null && allowedOrigins.includes(origin)
}

interface Policy {
  kind: ContentsKind
  host: NavigationHost
  allowedOrigins: readonly string[]
}

const policies = new WeakMap<WebContents, Policy>()

/** The log never carries the URL: a path or a query can hold a secret. Bounded per scheme (#100). */
function refuse(what: string, policy: Policy, url: string, contents: WebContents): void {
  const scheme = schemeOf(url) ?? 'an unparseable URL'
  warnLimited(
    `navigation ${scheme}`,
    `navigation: blocked ${what} to ${scheme} from ${policy.kind} contents ${contents.id}`,
  )
}

/**
 * Installs the guards on `contents` as `kind`, or, when they are already
 * installed, records the new kind, host and origins for the guards to read.
 * `allowedOrigins` is read for internal contents only (#96): the dev server
 * origin in a development run, nothing in a packaged one.
 */
export function applyNavigationPolicy(
  contents: WebContents,
  kind: ContentsKind,
  host: NavigationHost = {},
  allowedOrigins: readonly string[] = [],
): void {
  const existing = policies.get(contents)
  if (existing !== undefined) {
    existing.kind = kind
    existing.host = host
    existing.allowedOrigins = allowedOrigins
    return
  }
  const policy: Policy = { kind, host, allowedOrigins }
  policies.set(contents, policy)

  contents.on('will-navigate', (event, url) => {
    if (navigationAllowed(policy.kind, url, policy.allowedOrigins)) return
    refuse('navigation', policy, url, contents)
    event.preventDefault()
  })

  // A redirect reads no origin list: the development exception covers the
  // page reload Vite issues through will-navigate and nothing else (#96).
  contents.on('will-redirect', (event, url) => {
    if (navigationAllowed(policy.kind, url)) return
    refuse('redirect', policy, url, contents)
    event.preventDefault()
  })

  // Every window is denied. A URL a page buffer could hold goes to the buffer
  // manager, which decides whether a controlled buffer opens; a bare
  // BrowserWindow with the page's choice of features never does.
  contents.setWindowOpenHandler(({ url }) => {
    if (navigationAllowed('page', url)) {
      policy.host.openPage?.(url, contents)
    } else {
      refuse('window', policy, url, contents)
    }
    return { action: 'deny' }
  })

  // webviewTag is off in HARDENED_WEB_PREFERENCES, so no page should get this
  // far; a WebContents that somehow did is stopped here as well (T1).
  contents.on('will-attach-webview', (event) => {
    warnLimited(
      'navigation webview',
      `navigation: blocked webview in ${policy.kind} contents ${contents.id}`,
    )
    event.preventDefault()
  })
}
