import type { WebPreferences } from 'electron'

/**
 * Hardened defaults for every WebContents the app creates (SECURITY.org, T1).
 * Frozen so nothing can relax a field at runtime. #47 adds the startup
 * assertion over all WebContents and the Electron fuses configuration.
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
