import type { WebContents } from 'electron'

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
 */
export function navigationAllowed(kind: ContentsKind, url: string): boolean {
  const scheme = schemeOf(url)
  if (scheme === null) return false
  return kind === 'internal' ? scheme === INTERNAL_SCHEME : PAGE_SCHEMES.includes(scheme)
}

interface Policy {
  kind: ContentsKind
  host: NavigationHost
}

const policies = new WeakMap<WebContents, Policy>()

/** The log never carries the URL: a path or a query can hold a secret. */
function refuse(what: string, policy: Policy, url: string, contents: WebContents): void {
  const scheme = schemeOf(url) ?? 'an unparseable URL'
  console.warn(
    `navigation: blocked ${what} to ${scheme} from ${policy.kind} contents ${contents.id}`,
  )
}

/**
 * Installs the guards on `contents` as `kind`, or, when they are already
 * installed, records the new kind and host for the guards to read.
 */
export function applyNavigationPolicy(
  contents: WebContents,
  kind: ContentsKind,
  host: NavigationHost = {},
): void {
  const existing = policies.get(contents)
  if (existing !== undefined) {
    existing.kind = kind
    existing.host = host
    return
  }
  const policy: Policy = { kind, host }
  policies.set(contents, policy)

  contents.on('will-navigate', (event, url) => {
    if (navigationAllowed(policy.kind, url)) return
    refuse('navigation', policy, url, contents)
    event.preventDefault()
  })

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
    console.warn(`navigation: blocked webview in ${policy.kind} contents ${contents.id}`)
    event.preventDefault()
  })
}
