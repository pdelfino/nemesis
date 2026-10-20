import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_NOTIFY_TOGGLES,
  defaultSettings,
  loadSettings,
  parseSettings,
  serializeSettings,
  SettingsError,
} from '../../src/main/settings'

const defaults = defaultSettings('/Users/someone/Documents')

describe('the settings schema', () => {
  it('defaults to a sessions folder under Documents, the CLI model, the cockpit keyscheme and the system appearance', () => {
    expect(defaults).toEqual({
      sessionsDir: '/Users/someone/Documents/nemesis/sessions',
      model: null,
      keyscheme: 'cockpit',
      theme: 'system',
      verify: null,
      searchEngines: [{ keyword: 'ddg', name: 'DuckDuckGo', url: 'https://duckduckgo.com/?q=%s' }],
      stopGateRetries: 3,
      fanOutMax: 5,
      notify: null,
      blockerUpdates: 'weekly',
      restore: true,
      hints: { alphabet: 'asdfghjkl', maxLength: 3 },
    })
  })

  it('fills absent keys from the defaults and keeps the ones given', () => {
    expect(parseSettings({}, defaults)).toEqual(defaults)
    expect(parseSettings({ model: 'claude-opus-5-5' }, defaults)).toEqual({
      ...defaults,
      model: 'claude-opus-5-5',
    })
    expect(parseSettings({ sessionsDir: '/tmp/s', model: null }, defaults).sessionsDir).toBe(
      '/tmp/s',
    )
    expect(parseSettings({ theme: 'dark' }, defaults)).toEqual({ ...defaults, theme: 'dark' })
    expect(parseSettings({ theme: 'light' }, defaults).theme).toBe('light')
    // The check the verify key runs when no issue names one (#81), as typed in a terminal.
    expect(parseSettings({ verify: 'npm test' }, defaults)).toEqual({
      ...defaults,
      verify: 'npm test',
    })
    expect(parseSettings({ verify: null }, defaults).verify).toBeNull()
    // The search engines open-url offers (#124).
    const engines = [{ keyword: 'fx', name: 'Fixture', url: 'http://127.0.0.1:1/?q=%s' }]
    expect(parseSettings({ searchEngines: engines }, defaults).searchEngines).toEqual(engines)
    // How many red checks the stop gate sends back before the turn ends (#113).
    expect(parseSettings({ stopGateRetries: 0 }, defaults).stopGateRetries).toBe(0)
    expect(parseSettings({ stopGateRetries: 5 }, defaults).stopGateRetries).toBe(5)
    expect(parseSettings({ fanOutMax: 30 }, defaults).fanOutMax).toBe(30)
    expect(parseSettings({ blockerUpdates: 'off' }, defaults).blockerUpdates).toBe('off')
    expect(parseSettings({ restore: false }, defaults).restore).toBe(false)
  })

  it('reads the notify object, an absent toggle at its default, and keeps null for no key (#114)', () => {
    // No key: null, so the environment variables still decide for one release.
    expect(parseSettings({}, defaults).notify).toBeNull()
    expect(parseSettings({ notify: null }, defaults).notify).toBeNull()
    expect(parseSettings({ notify: {} }, defaults).notify).toEqual(DEFAULT_NOTIFY_TOGGLES)
    expect(parseSettings({ notify: { finished: false, sound: true } }, defaults).notify).toEqual({
      finished: false,
      finishedOnlyWhenUnfocused: true,
      needsYou: true,
      error: true,
      sound: true,
    })
    expect(
      parseSettings(
        {
          notify: {
            finished: true,
            finishedOnlyWhenUnfocused: false,
            needsYou: false,
            error: false,
            sound: false,
          },
        },
        defaults,
      ).notify,
    ).toEqual({
      finished: true,
      finishedOnlyWhenUnfocused: false,
      needsYou: false,
      error: false,
      sound: false,
    })
  })

  it('rejects a notify object it cannot use, and never takes a Telegram key', () => {
    expect(() => parseSettings({ notify: true }, defaults)).toThrow(/"notify" is not an object/)
    expect(() => parseSettings({ notify: [] }, defaults)).toThrow(/"notify" is not an object/)
    expect(() => parseSettings({ notify: { finished: 'on' } }, defaults)).toThrow(
      /"notify.finished" is not true or false/,
    )
    expect(() => parseSettings({ notify: { needYou: true } }, defaults)).toThrow(
      /Unknown setting "notify.needYou"/,
    )
    // The token is a secret: it keeps its environment variable, never a key here.
    expect(() => parseSettings({ notify: { telegramToken: 'x' } }, defaults)).toThrow(
      /Unknown setting "notify.telegramToken"/,
    )
  })

  it('expands a leading ~ in the sessions folder', () => {
    expect(parseSettings({ sessionsDir: '~/notes/sessions' }, defaults).sessionsDir).toBe(
      join(homedir(), 'notes/sessions'),
    )
    expect(parseSettings({ sessionsDir: '~' }, defaults).sessionsDir).toBe(homedir())
  })

  it('rejects what it cannot use, naming the key', () => {
    expect(() => parseSettings(null, defaults)).toThrow(SettingsError)
    expect(() => parseSettings([], defaults)).toThrow(/not an object/)
    expect(() => parseSettings({ sessionDir: '/tmp' }, defaults)).toThrow(
      /Unknown setting "sessionDir"/,
    )
    expect(() => parseSettings({ sessionsDir: 'relative/path' }, defaults)).toThrow(/absolute/)
    expect(() => parseSettings({ sessionsDir: '' }, defaults)).toThrow(/"sessionsDir"/)
    expect(() => parseSettings({ sessionsDir: 7 }, defaults)).toThrow(/"sessionsDir"/)
    expect(() => parseSettings({ model: '' }, defaults)).toThrow(/"model"/)
    expect(() => parseSettings({ model: 3 }, defaults)).toThrow(/"model"/)
    expect(() => parseSettings({ keyscheme: 'vim' }, defaults)).toThrow(/"keyscheme"/)
    expect(() => parseSettings({ theme: 'auto' }, defaults)).toThrow(
      /"theme" is not one of system, light, dark/,
    )
    expect(() => parseSettings({ theme: 'Dark' }, defaults)).toThrow(/"theme"/)
    expect(() => parseSettings({ theme: true }, defaults)).toThrow(/"theme"/)
    expect(() => parseSettings({ verify: '' }, defaults)).toThrow(/"verify" is not a command/)
    expect(() => parseSettings({ verify: ['npm', 'test'] }, defaults)).toThrow(/"verify"/)
    expect(() => parseSettings({ searchEngines: [] }, defaults)).toThrow(/"searchEngines"/)
    expect(() => parseSettings({ stopGateRetries: -1 }, defaults)).toThrow(/"stopGateRetries"/)
    expect(() => parseSettings({ stopGateRetries: 1.5 }, defaults)).toThrow(/"stopGateRetries"/)
    expect(() => parseSettings({ stopGateRetries: 21 }, defaults)).toThrow(/"stopGateRetries"/)
    expect(() => parseSettings({ stopGateRetries: '3' }, defaults)).toThrow(/"stopGateRetries"/)
    expect(() => parseSettings({ fanOutMax: 0 }, defaults)).toThrow(/"fanOutMax"/)
    expect(() => parseSettings({ fanOutMax: 31 }, defaults)).toThrow(/"fanOutMax"/)
    expect(() => parseSettings({ fanOutMax: 2.5 }, defaults)).toThrow(/"fanOutMax"/)
    expect(() => parseSettings({ blockerUpdates: 'hourly' }, defaults)).toThrow(/"blockerUpdates"/)
    expect(() => parseSettings({ blockerUpdates: false }, defaults)).toThrow(/"blockerUpdates"/)
    expect(() => parseSettings({ restore: 'no' }, defaults)).toThrow(/"restore"/)
  })

  it('serializes the defaults with the home folder as ~', () => {
    const home = defaultSettings(join(homedir(), 'Documents'))
    expect(serializeSettings(home)).toBe(
      '{\n  "sessionsDir": "~/Documents/nemesis/sessions",\n  "model": null,\n  "keyscheme": "cockpit",\n  "theme": "system",\n  "verify": null,\n  "searchEngines": [\n    {\n      "keyword": "ddg",\n      "name": "DuckDuckGo",\n      "url": "https://duckduckgo.com/?q=%s"\n    }\n  ],\n  "stopGateRetries": 3,\n  "blockerUpdates": "weekly",\n  "restore": true,\n  "hints": {\n    "alphabet": "asdfghjkl",\n    "maxLength": 3\n  }\n}\n',
    )
    expect(JSON.parse(serializeSettings({ ...defaults, theme: 'dark' }))).toMatchObject({
      theme: 'dark',
    })
    expect(JSON.parse(serializeSettings(defaults))).toMatchObject({
      sessionsDir: '/Users/someone/Documents/nemesis/sessions',
    })
    // A notify object is written when there is one, and read back the same.
    const notify = { ...DEFAULT_NOTIFY_TOGGLES, sound: true }
    expect(
      parseSettings(JSON.parse(serializeSettings({ ...defaults, notify })), defaults).notify,
    ).toEqual(notify)
  })
})

describe('the settings file', () => {
  let dir: string
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  /** A path inside a profile folder that does not exist yet. */
  function settingsPath(): string {
    dir = mkdtempSync(join(tmpdir(), 'nemesis-settings-'))
    return join(dir, 'profile', 'settings.json')
  }

  function write(file: string, text: string): void {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, text)
  }

  it('is created with the defaults when absent, and read back unchanged', () => {
    const file = settingsPath()
    expect(loadSettings(file, defaults)).toEqual(defaults)
    expect(existsSync(file)).toBe(true)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
      sessionsDir: '/Users/someone/Documents/nemesis/sessions',
      model: null,
      keyscheme: 'cockpit',
      theme: 'system',
      verify: null,
      searchEngines: [{ keyword: 'ddg', name: 'DuckDuckGo', url: 'https://duckduckgo.com/?q=%s' }],
      stopGateRetries: 3,
      blockerUpdates: 'weekly',
      restore: true,
      hints: { alphabet: 'asdfghjkl', maxLength: 3 },
    })
    expect(loadSettings(file, defaults)).toEqual(defaults)
  })

  it('reads a partial file over the defaults', () => {
    const file = settingsPath()
    write(file, '{ "sessionsDir": "/tmp/elsewhere" }\n')
    expect(loadSettings(file, defaults)).toEqual({ ...defaults, sessionsDir: '/tmp/elsewhere' })
  })

  it('names the file and the problem when it cannot be used, and leaves it alone', () => {
    const file = settingsPath()
    write(file, '{ not json')
    expect(() => loadSettings(file, defaults)).toThrow(/settings\.json is not valid JSON/)
    write(file, '{ "keyscheme": "vim" }')
    expect(() => loadSettings(file, defaults)).toThrow(/settings\.json: Setting "keyscheme"/)
    expect(readFileSync(file, 'utf8')).toBe('{ "keyscheme": "vim" }')
  })
})
