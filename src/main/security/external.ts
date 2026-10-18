import { shell, type WebContents } from 'electron'
import type { AgentNoticeEvent } from '../agent/events'
import { originOf, type NoticeListener } from './permissions'

/**
 * External protocols prompt, never auto-launch (#51, SECURITY.org T2).
 *
 * `open()` is the one door to `shell.openExternal` in the app. It takes a
 * URL and the origin asking for it, refuses any scheme not on
 * `LAUNCHABLE_SCHEMES` without a word to the user, asks the user about the
 * rest through the prompt buffer, and launches only on a yes. The list is
 * `http:`, `https:`, `mailto:` and `tel:`: the two the web is made of, for
 * the day a command hands a page to the system browser, and the two
 * handlers the issue names. A custom scheme (`zoommtg:`, `slack:`, the
 * handler of whatever is installed) is refused in version 1 with a notice
 * that says so; widening the list is one constant, reviewed.
 *
 * `watch()` is how a page reaches the door. A navigation to an external
 * scheme is already stopped by the navigation policy (#48), which keeps a
 * page on `http:` and `https:`; this listener runs beside it on the same
 * event, recognizes the schemes that are a handler's rather than a page's,
 * and asks. Subframes, redirects and `window.open` have no path here: the
 * navigation policy and the permission policy (#49, which denies the
 * `openExternal` permission Chromium asks for) refuse them outright.
 */

/** What `open()` may hand to the system, each after a yes. */
export const LAUNCHABLE_SCHEMES: readonly string[] = Object.freeze([
  'http:',
  'https:',
  'mailto:',
  'tel:',
])

/**
 * Schemes a page or the app handles itself. A navigation to one of these is
 * the navigation policy's business (T1, T3), not a handler's.
 */
const PAGE_SCHEMES: ReadonlySet<string> = new Set([
  'http:',
  'https:',
  'nemesis:',
  'file:',
  'javascript:',
  'data:',
  'blob:',
  'about:',
  'chrome:',
  'chrome-error:',
  'chrome-extension:',
  'devtools:',
  'filesystem:',
  'ws:',
  'wss:',
])

/** Longer URLs are cut in the prompt: the user reads the scheme and the start, not a payload. */
const MAX_SHOWN_URL = 120

// eslint-disable-next-line no-control-regex
const UNPRINTABLE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g

export interface ExternalRequest {
  readonly url: string
  readonly scheme: string
  /** The page asking, or null when none did. */
  readonly origin: string | null
}

export type ExternalConfirm = (request: ExternalRequest) => Promise<boolean>

/** The minimum of a WebContents the watcher needs. */
export type NavigationSurface = Pick<WebContents, 'on' | 'getURL'>

export interface ExternalPolicyOptions {
  readonly confirm: ExternalConfirm
  /** `shell.openExternal` unless a test says otherwise. */
  readonly launch?: ((url: string) => Promise<void>) | undefined
}

function schemeOf(url: string): string | null {
  try {
    return new URL(url).protocol
  } catch {
    return null
  }
}

/** True for a URL that is a handler's to open: parseable, and not a scheme a page or the app handles. */
export function isExternalProtocol(url: string): boolean {
  const scheme = schemeOf(url)
  return scheme !== null && !PAGE_SCHEMES.has(scheme)
}

/** The URL as the prompt shows it: printable, and no longer than a line. */
export function displayUrl(url: string): string {
  const clean = url.replace(UNPRINTABLE, '')
  return clean.length > MAX_SHOWN_URL ? `${clean.slice(0, MAX_SHOWN_URL)}...` : clean
}

/** The question, as the prompt buffer shows it. */
export function describeExternal(request: ExternalRequest): string {
  return `Open ${displayUrl(request.url)} with the system handler? Asked by ${siteOf(request.origin)}`
}

function siteOf(origin: string | null): string {
  return origin ?? 'an unknown origin'
}

export class ExternalPolicy {
  private readonly confirm: ExternalConfirm
  private readonly launch: (url: string) => Promise<void>
  private readonly listeners = new Set<NoticeListener>()
  private readonly watched = new WeakSet<NavigationSurface>()
  private readonly opened: string[] = []

  constructor(options: ExternalPolicyOptions) {
    this.confirm = options.confirm
    this.launch = options.launch ?? ((url) => shell.openExternal(url))
  }

  /** Every URL handed to the system so far, in order. The security spec reads it; it is never written anywhere. */
  get launched(): readonly string[] {
    return this.opened
  }

  on(listener: NoticeListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** A page's navigations to a handler's scheme become questions. Installed once per WebContents. */
  watch(contents: NavigationSurface): void {
    if (this.watched.has(contents)) return
    this.watched.add(contents)
    contents.on('will-navigate', (_event, url) => {
      if (!isExternalProtocol(url)) return
      void this.open(url, originOf(contents.getURL()))
    })
  }

  /**
   * The one way out. Resolves true when the system was handed the URL,
   * which happens only for a launchable scheme and only after a yes.
   */
  async open(url: string, origin: string | null): Promise<boolean> {
    const scheme = schemeOf(url)
    if (scheme === null || !LAUNCHABLE_SCHEMES.includes(scheme)) {
      const named = scheme ?? 'an unparseable'
      console.warn(`external: refused ${named} link from ${siteOf(origin)}`)
      this.notify(
        `Refused ${named} link from ${siteOf(origin)}: only ${LAUNCHABLE_SCHEMES.join(', ')} links open, after a yes (SECURITY.org, T2)`,
      )
      return false
    }
    let yes = false
    try {
      yes = await this.confirm({ url, scheme, origin })
    } catch (error) {
      console.error('external: the confirmation failed:', error)
    }
    if (!yes) {
      this.notify(
        `Refused ${scheme} link from ${siteOf(origin)}: nothing was opened (SECURITY.org, T2)`,
      )
      return false
    }
    this.opened.push(url)
    try {
      await this.launch(url)
    } catch (error) {
      console.error(`external: the system could not open a ${scheme} link:`, error)
      this.notify(`The system could not open the ${scheme} link from ${siteOf(origin)}`)
      return false
    }
    this.notify(`Opened a ${scheme} link from ${siteOf(origin)} with the system handler`)
    return true
  }

  private notify(text: string): void {
    const event: AgentNoticeEvent = { type: 'notice', text }
    for (const listener of this.listeners) listener(event)
  }
}
