import { webContents, type WebContents, type WebPreferences } from 'electron'
import { describeWeakPreferences, weakWebPreferences } from './web-preferences'

/**
 * The startup half of T1 (#47): setting hardened preferences is a promise, and
 * this is the check that the promise held. It walks the live WebContents and
 * throws when one of them runs with anything weaker than the policy in
 * web-preferences.ts, so a creation site that forgot the defaults takes the app
 * down at startup instead of shipping a page with a way out of the renderer.
 */

/**
 * The WebContents types that can hold app or web content, and are therefore
 * ours to configure. Chromium's own surfaces (DevTools arrives as `remote`)
 * are created by the engine with preferences the app never passes.
 */
const CHECKED_TYPES: readonly string[] = ['window', 'browserView', 'webview', 'offscreen']

export class WebPreferencesError extends Error {
  override readonly name = 'WebPreferencesError'
}

/**
 * `getLastWebPreferences()` answers at runtime in Electron 44 but is missing
 * from the published typings, so the single cast that reads it lives here. A
 * build where the method is gone reads as null, which `weakWebPreferences`
 * treats as a violation: the check fails closed rather than passing silently.
 */
interface PreferencesReader {
  getLastWebPreferences?: () => WebPreferences | null
}

function reportedPreferences(contents: WebContents): WebPreferences | null {
  const reader = contents as WebContents & PreferencesReader
  return typeof reader.getLastWebPreferences === 'function' ? reader.getLastWebPreferences() : null
}

/** The origin of a WebContents, never its full URL: a path or a query can carry a secret. */
function originOf(contents: WebContents): string {
  const url = contents.getURL()
  if (url === '') return 'about:blank'
  try {
    // An internal page on file:// has an opaque origin, which prints as the
    // string "null" and says nothing; its scheme is the useful half.
    const parsed = new URL(url)
    return parsed.origin === 'null' ? parsed.protocol : parsed.origin
  } catch {
    return 'unparseable'
  }
}

/**
 * Checks every WebContents that holds app or web content. Call it once the
 * cockpit's first page has loaded: `getLastWebPreferences()` answers for the
 * page that loaded, so it is null before the first commit and a check that ran
 * earlier would fail closed for the wrong reason.
 */
export function assertWebContentsHardened(
  all: readonly WebContents[] = webContents.getAllWebContents(),
): void {
  const offenders: string[] = []
  for (const contents of all) {
    if (!CHECKED_TYPES.includes(contents.getType())) continue
    const weak = weakWebPreferences(reportedPreferences(contents))
    if (weak.length > 0) {
      offenders.push(
        `WebContents ${contents.id} (${contents.getType()}, ${originOf(contents)}) ${describeWeakPreferences(weak)}`,
      )
    }
  }
  if (offenders.length > 0) {
    throw new WebPreferencesError(
      `${offenders.length} WebContents run with weakened preferences (SECURITY.org, T1). Every creation site must use HARDENED_WEB_PREFERENCES: ${offenders.join(' | ')}`,
    )
  }
}
