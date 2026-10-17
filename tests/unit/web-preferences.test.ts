import { describe, expect, it } from 'vitest'
import {
  HARDENED_WEB_PREFERENCES,
  internalPagePreferences,
} from '../../src/main/security/web-preferences'

describe('hardened web preferences (SECURITY.org T1)', () => {
  it('keeps pages out of Node and isolates contexts', () => {
    expect(HARDENED_WEB_PREFERENCES.sandbox).toBe(true)
    expect(HARDENED_WEB_PREFERENCES.contextIsolation).toBe(true)
    expect(HARDENED_WEB_PREFERENCES.nodeIntegration).toBe(false)
    expect(HARDENED_WEB_PREFERENCES.nodeIntegrationInWorker).toBe(false)
    expect(HARDENED_WEB_PREFERENCES.nodeIntegrationInSubFrames).toBe(false)
    expect(HARDENED_WEB_PREFERENCES.webSecurity).toBe(true)
    expect(HARDENED_WEB_PREFERENCES.allowRunningInsecureContent).toBe(false)
    expect(HARDENED_WEB_PREFERENCES.webviewTag).toBe(false)
    expect(HARDENED_WEB_PREFERENCES.navigateOnDragDrop).toBe(false)
  })

  it('is frozen so nothing can relax it at runtime', () => {
    expect(Object.isFrozen(HARDENED_WEB_PREFERENCES)).toBe(true)
  })

  it('adds only the preload for internal pages', () => {
    const prefs = internalPagePreferences('/tmp/preload.js')
    expect(prefs.preload).toBe('/tmp/preload.js')
    expect(prefs.sandbox).toBe(true)
    expect(prefs.contextIsolation).toBe(true)
  })
})
