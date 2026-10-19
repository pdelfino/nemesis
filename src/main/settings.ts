import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, sep } from 'node:path'

/**
 * The app's settings, a JSON file in the user config dir (#64). Everything
 * plain text includes the configuration: the file is created with its
 * defaults on the first run, so there is something to open in Emacs and edit,
 * and it is validated by hand on every start, the way parseBufferSpec reads
 * an IPC payload: shape only, no schema dependency.
 *
 * Nothing here touches Electron. The main process computes the path and the
 * defaults from `app.getPath` and hands them in, so the unit tests run this
 * against a temporary folder.
 */
export interface Settings {
  /** Where sessions are kept, one folder per session. Always absolute. */
  readonly sessionsDir: string
  /** The model a new session asks for. `null` leaves the choice to the CLI. */
  readonly model: string | null
  /** The keyscheme the keymaps are built from. `cockpit` is the only one so far. */
  readonly keyscheme: string
  /**
   * The appearance: `system` follows the OS, `light` and `dark` pin it. The
   * main process hands the value to `nativeTheme.themeSource`, so the renderer
   * sees it as `prefers-color-scheme` and never reads the settings (#33).
   */
  readonly theme: Theme
  /**
   * The check the `verify` key runs when no attached issue names one (#81),
   * as typed in a terminal: `npm test`, `make check`. `null` leaves it to
   * the default, `npm run gate`.
   */
  readonly verify: string | null
  /**
   * How many times the stop gate (#113) sends a red check back to the
   * session as the next prompt before the turn ends for the user anyway.
   */
  readonly stopGateRetries: number
}

export type Theme = 'system' | 'light' | 'dark'

export const SETTINGS_FILE = 'settings.json'

/** The keyschemes the cockpit knows. A name outside this list is a typo, not a choice. */
const KEYSCHEMES: readonly string[] = ['cockpit']

const THEMES: readonly Theme[] = ['system', 'light', 'dark']

const KNOWN_KEYS: readonly string[] = [
  'sessionsDir',
  'model',
  'keyscheme',
  'theme',
  'verify',
  'stopGateRetries',
]

/** The most retries a gate may be set to: past this a red check wants a person, not another turn. */
export const MAX_STOP_GATE_RETRIES = 20

export class SettingsError extends Error {
  override readonly name = 'SettingsError'
}

/** The defaults, given the user's documents folder as Electron reports it. */
export function defaultSettings(documentsDir: string): Settings {
  return {
    sessionsDir: join(documentsDir, 'nemesis', 'sessions'),
    model: null,
    keyscheme: 'cockpit',
    theme: 'system',
    verify: null,
    stopGateRetries: 3,
  }
}

/**
 * Validates a parsed settings file against the defaults. A key that is absent
 * takes its default; a key that is present must have the right shape; a key
 * nobody knows is rejected, because a misspelled setting that is silently
 * ignored is worse than one that fails loudly.
 */
export function parseSettings(payload: unknown, defaults: Settings): Settings {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new SettingsError('Settings are not an object')
  }
  const value = payload as Record<string, unknown>
  for (const key of Object.keys(value)) {
    if (!KNOWN_KEYS.includes(key)) throw new SettingsError(`Unknown setting "${key}"`)
  }

  const sessionsDir = value['sessionsDir'] ?? defaults.sessionsDir
  if (typeof sessionsDir !== 'string' || sessionsDir.trim().length === 0) {
    throw new SettingsError('Setting "sessionsDir" is not a path')
  }
  const expanded = expandHome(sessionsDir)
  if (!isAbsolute(expanded)) {
    throw new SettingsError('Setting "sessionsDir" must be absolute or start with "~"')
  }

  const model = value['model'] ?? defaults.model
  if (model !== null && (typeof model !== 'string' || model.trim().length === 0)) {
    throw new SettingsError('Setting "model" is not a model name or null')
  }

  const keyscheme = value['keyscheme'] ?? defaults.keyscheme
  if (typeof keyscheme !== 'string' || !KEYSCHEMES.includes(keyscheme)) {
    throw new SettingsError(`Setting "keyscheme" is not one of ${KEYSCHEMES.join(', ')}`)
  }

  const theme = value['theme'] ?? defaults.theme
  if (typeof theme !== 'string' || !isTheme(theme)) {
    throw new SettingsError(`Setting "theme" is not one of ${THEMES.join(', ')}`)
  }

  const verify = value['verify'] ?? defaults.verify
  if (verify !== null && (typeof verify !== 'string' || verify.trim().length === 0)) {
    throw new SettingsError('Setting "verify" is not a command or null')
  }

  const stopGateRetries = value['stopGateRetries'] ?? defaults.stopGateRetries
  if (
    typeof stopGateRetries !== 'number' ||
    !Number.isInteger(stopGateRetries) ||
    stopGateRetries < 0 ||
    stopGateRetries > MAX_STOP_GATE_RETRIES
  ) {
    throw new SettingsError(
      `Setting "stopGateRetries" is not a whole number from 0 to ${MAX_STOP_GATE_RETRIES}`,
    )
  }

  return { sessionsDir: expanded, model, keyscheme, theme, verify, stopGateRetries }
}

/**
 * Reads the settings file, creating it with the defaults when it is absent.
 * Throws a SettingsError when the file exists but cannot be used; the caller
 * decides whether that stops the app or falls back to the defaults.
 */
export function loadSettings(path: string, defaults: Settings): Settings {
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, serializeSettings(defaults), 'utf8')
    return defaults
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new SettingsError(`${path} is not valid JSON: ${describe(error)}`)
  }
  try {
    return parseSettings(parsed, defaults)
  } catch (error) {
    throw new SettingsError(`${path}: ${describe(error)}`)
  }
}

/** The file as written on the first run: the defaults, with the home folder as `~`. */
export function serializeSettings(settings: Settings): string {
  const body = {
    sessionsDir: contractHome(settings.sessionsDir),
    model: settings.model,
    keyscheme: settings.keyscheme,
    theme: settings.theme,
    verify: settings.verify,
    stopGateRetries: settings.stopGateRetries,
  }
  return `${JSON.stringify(body, null, 2)}\n`
}

function isTheme(value: string): value is Theme {
  return (THEMES as readonly string[]).includes(value)
}

function expandHome(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/')) return join(homedir(), path.slice(2))
  return path
}

function contractHome(path: string): string {
  const home = homedir()
  if (path === home) return '~'
  if (path.startsWith(home + sep))
    return `~/${path
      .slice(home.length + 1)
      .split(sep)
      .join('/')}`
  return path
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
