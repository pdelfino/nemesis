import type { WebPreferences } from 'electron'
import { describe, expect, it } from 'vitest'
import {
  describeWeakPreferences,
  ENFORCED_PREFERENCE_KEYS,
  HARDENED_WEB_PREFERENCES,
  internalPagePreferences,
  weakWebPreferences,
} from '../../src/main/security/web-preferences'

/**
 * What Electron 44 reports through getLastWebPreferences() for a hardened
 * window: the enforced fields, plus a couple it reports and the policy does not
 * speak about, so an extra field can never be mistaken for a violation.
 */
function asReported(overrides: WebPreferences = {}): WebPreferences {
  const reported: Record<string, unknown> = {}
  for (const key of ENFORCED_PREFERENCE_KEYS) reported[key] = HARDENED_WEB_PREFERENCES[key]
  return { ...(reported as WebPreferences), javascript: true, disableDialogs: false, ...overrides }
}

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

  it('turns off the engine features a page could reach for', () => {
    expect(HARDENED_WEB_PREFERENCES.experimentalFeatures).toBe(false)
    expect(HARDENED_WEB_PREFERENCES.enableBlinkFeatures).toBe('')
    expect(HARDENED_WEB_PREFERENCES.plugins).toBe(false)
  })

  it('keeps the spellchecker, which costs nothing and the prompt buffer wants', () => {
    expect(HARDENED_WEB_PREFERENCES.spellcheck).toBe(true)
  })

  it('is frozen so nothing can relax it at runtime', () => {
    expect(Object.isFrozen(HARDENED_WEB_PREFERENCES)).toBe(true)
  })

  it('carries no preload, so a page buffer cannot inherit the bridge', () => {
    expect('preload' in HARDENED_WEB_PREFERENCES).toBe(false)
  })

  it('adds only the preload for internal pages', () => {
    const prefs = internalPagePreferences('/tmp/preload.js')
    expect(prefs.preload).toBe('/tmp/preload.js')
    expect(prefs.sandbox).toBe(true)
    expect(prefs.contextIsolation).toBe(true)
  })
})

describe('weakWebPreferences, the runtime half of the control', () => {
  it('passes preferences read back from a hardened WebContents', () => {
    expect(weakWebPreferences(asReported())).toEqual([])
  })

  it('names every field that is weaker than the policy', () => {
    const weak = weakWebPreferences(
      asReported({ sandbox: false, contextIsolation: false, nodeIntegration: true }),
    )
    expect(weak.map((one) => one.key).sort()).toEqual([
      'contextIsolation',
      'nodeIntegration',
      'sandbox',
    ])
    expect(weak.find((one) => one.key === 'sandbox')).toEqual({
      key: 'sandbox',
      expected: true,
      actual: false,
    })
  })

  it('catches a Blink feature switched back on', () => {
    const weak = weakWebPreferences(asReported({ enableBlinkFeatures: 'SharedArrayBuffer' }))
    expect(weak).toEqual([
      { key: 'enableBlinkFeatures', expected: '', actual: 'SharedArrayBuffer' },
    ])
  })

  it('fails closed on null preferences, which say nothing about the WebContents', () => {
    expect(weakWebPreferences(null)).toHaveLength(ENFORCED_PREFERENCE_KEYS.length)
  })

  it('fails closed on a field Chromium stopped reporting', () => {
    const reported = asReported()
    delete reported.sandbox
    expect(weakWebPreferences(reported).map((one) => one.key)).toEqual(['sandbox'])
  })

  it('checks every field the policy and the runtime share', () => {
    for (const key of ENFORCED_PREFERENCE_KEYS) {
      expect(key in HARDENED_WEB_PREFERENCES).toBe(true)
    }
    expect(ENFORCED_PREFERENCE_KEYS).toContain('sandbox')
    expect(ENFORCED_PREFERENCE_KEYS).toContain('contextIsolation')
    expect(ENFORCED_PREFERENCE_KEYS).toContain('nodeIntegration')
  })

  it('describes the violations for a startup failure message', () => {
    const weak = weakWebPreferences(asReported({ webSecurity: false }))
    expect(describeWeakPreferences(weak)).toBe('webSecurity: expected true, got false')
    expect(describeWeakPreferences([])).toBe('')
  })
})
