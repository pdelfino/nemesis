import type { WebPreferences } from 'electron'

/**
 * Hardened defaults for every WebContents the app creates (SECURITY.org, T1).
 * Frozen so nothing can relax a field at runtime.
 *
 * Setting them is half the control; the other half is reading them back from
 * the live WebContents, which is what `weakWebPreferences` below and the
 * startup walk in assert-web-preferences.ts do (#47).
 */
export const HARDENED_WEB_PREFERENCES = Object.freeze({
  sandbox: true,
  contextIsolation: true,
  nodeIntegration: false,
  nodeIntegrationInWorker: false,
  nodeIntegrationInSubFrames: false,
  webSecurity: true,
  allowRunningInsecureContent: false,
  experimentalFeatures: false,
  enableBlinkFeatures: '',
  navigateOnDragDrop: false,
  webviewTag: false,
  plugins: false,
  spellcheck: true,
  defaultEncoding: 'UTF-8',
} satisfies WebPreferences)

/** Preferences for an internal page: hardened defaults plus the minimal preload bridge. */
export function internalPagePreferences(preloadPath: string): WebPreferences {
  return { ...HARDENED_WEB_PREFERENCES, preload: preloadPath }
}

/**
 * The fields Chromium reports back through `webContents.getLastWebPreferences()`,
 * and therefore the fields a runtime check can speak about. The rest of
 * HARDENED_WEB_PREFERENCES is write-only as far as Electron 44 is concerned
 * (`navigateOnDragDrop`, `spellcheck`, `plugins`, `defaultEncoding`, `preload`
 * are never read back), so the frozen object's own unit test covers those.
 */
export const ENFORCED_PREFERENCE_KEYS = [
  'sandbox',
  'contextIsolation',
  'nodeIntegration',
  'nodeIntegrationInWorker',
  'nodeIntegrationInSubFrames',
  'webSecurity',
  'allowRunningInsecureContent',
  'experimentalFeatures',
  'enableBlinkFeatures',
  'webviewTag',
] as const satisfies readonly (keyof typeof HARDENED_WEB_PREFERENCES)[]

export type EnforcedPreferenceKey = (typeof ENFORCED_PREFERENCE_KEYS)[number]

/** One field of one WebContents that does not match the hardened policy. */
export interface WeakPreference {
  readonly key: EnforcedPreferenceKey
  readonly expected: boolean | string
  readonly actual: unknown
}

/**
 * Compares preferences read from a live WebContents against the policy, and
 * returns every field that is weaker. An empty array means hardened.
 *
 * Fails closed on purpose: `null` preferences, or a key Chromium no longer
 * reports, both count as violations. An Electron bump that renames or stops
 * reporting a field then fails loudly at startup and in the security specs,
 * which is the moment a human is already reading the diff.
 */
export function weakWebPreferences(prefs: WebPreferences | null): readonly WeakPreference[] {
  const actual: Record<string, unknown> = prefs === null ? {} : { ...prefs }
  const weak: WeakPreference[] = []
  for (const key of ENFORCED_PREFERENCE_KEYS) {
    const expected = HARDENED_WEB_PREFERENCES[key]
    if (actual[key] !== expected) weak.push({ key, expected, actual: actual[key] })
  }
  return weak
}

/** One line per weak field, for a startup failure message or a spec report. */
export function describeWeakPreferences(weak: readonly WeakPreference[]): string {
  return weak
    .map(
      (one) =>
        `${one.key}: expected ${JSON.stringify(one.expected)}, got ${JSON.stringify(one.actual)}`,
    )
    .join('; ')
}
