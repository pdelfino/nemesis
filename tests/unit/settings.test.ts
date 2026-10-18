import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
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
  })

  it('serializes the defaults with the home folder as ~', () => {
    const home = defaultSettings(join(homedir(), 'Documents'))
    expect(serializeSettings(home)).toBe(
      '{\n  "sessionsDir": "~/Documents/nemesis/sessions",\n  "model": null,\n  "keyscheme": "cockpit",\n  "theme": "system"\n}\n',
    )
    expect(JSON.parse(serializeSettings({ ...defaults, theme: 'dark' }))).toMatchObject({
      theme: 'dark',
    })
    expect(JSON.parse(serializeSettings(defaults))).toMatchObject({
      sessionsDir: '/Users/someone/Documents/nemesis/sessions',
    })
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
