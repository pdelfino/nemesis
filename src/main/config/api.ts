import type { Command } from '../commands/registry'
import { CommandError, defineCommand } from '../commands/registry'
import type { Keymap } from '../commands/keymap'
import { defineKeymap, KeymapError, normalizeChord } from '../commands/keymap'
import type { NotifyToggles, Settings } from '../settings'
import { DEFAULT_NOTIFY_TOGGLES, NOTIFY_KEYS, parseSettings, SettingsError } from '../settings'

/**
 * The surface the config file sees (#71, ADR 0006): one object, `nemesis`,
 * and nothing else in scope. Every member records what the file asks for in
 * a staging area, validated as it is called, so a bad name fails on the
 * file's own line; nothing reaches the live registry, keymaps or settings
 * until the loader commits the whole load.
 *
 * The object reaches the command registry's shapes, the keymap builder, the
 * settings rules, a read of the buffer list, `commands.run` and `notice`, and
 * nothing of src/main/agent/, src/main/security/ or src/preload/. The file is
 * trusted code all the same: node:vm is not a security boundary.
 */

/** The one keymap layer a config defines in version 1, above the global map. */
export const USER_KEYMAP = 'user'

export class ConfigError extends Error {
  override readonly name = 'ConfigError'
  /** Where in the file the thing this error names was asked for, when known. */
  readonly site: CallSite | null

  constructor(message: string, site: CallSite | null = null) {
    super(message)
    this.site = site
  }
}

/** A line and a column in the config file, 1-based. */
export interface CallSite {
  readonly line: number
  readonly column: number
}

/** The first frame of `stack` that is in `file`, or null when none is. */
export function siteIn(stack: string, file: string): CallSite | null {
  const escaped = file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(`${escaped}:(\\d+):(\\d+)`).exec(stack)
  if (match === null) return null
  return { line: Number(match[1]), column: Number(match[2]) }
}

/** What a binding asked for, and where, so an unknown command is reported on its line. */
export interface StagedBinding {
  readonly chord: string
  readonly command: string
  readonly site: CallSite | null
}

/**
 * One load's requests. `reserved` is the names the file may not take: the
 * cockpit's commands, which stay whatever the file does.
 */
export class ConfigStaging {
  readonly commands = new Map<string, Command>()
  readonly bindings = new Map<string, StagedBinding>()
  readonly overrides = new Map<keyof Settings, Settings[keyof Settings]>()
  /** The user layer as built so far, so a conflict between two chords fails on the call that made it. */
  keymap: Keymap | null = null
  /** Set when the file's body has run: a definition from a command body later would be lost. */
  sealed = false

  constructor(
    readonly file: string,
    readonly base: Settings,
    readonly reserved: ReadonlySet<string>,
  ) {}

  /** The settings this load ends with: the file's overrides on the data file's values. */
  settings(): Settings {
    return { ...this.base, ...Object.fromEntries(this.overrides) }
  }

  site(): CallSite | null {
    return siteIn(new Error().stack ?? '', this.file)
  }

  open(member: string): void {
    if (this.sealed) {
      throw new ConfigError(
        `nemesis.${member} runs while the config loads; edit the file and run reload-config`,
      )
    }
  }
}

/** What the API reads from the running cockpit. */
export interface ConfigApiEnv {
  readonly buffers: () => readonly { id: string; kind: string; title: string }[]
  readonly run: (name: string) => Promise<void>
  readonly notice: (text: string) => void
}

export interface ConfigApi {
  defineCommand(spec: unknown): void
  defineKeymap(name: unknown, spec: unknown): void
  bindKey(chord: unknown, command: unknown): void
  readonly settings: {
    set(key: unknown, value: unknown): void
    get(key: unknown): unknown
  }
  readonly buffers: { list(): { id: string; kind: string; title: string }[] }
  readonly commands: { run(name: unknown): Promise<void> }
  notice(text: unknown): void
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const SETTING_KEYS: readonly (keyof Settings)[] = [
  'sessionsDir',
  'model',
  'keyscheme',
  'theme',
  'verify',
  'searchEngines',
  'stopGateRetries',
  'notify',
  'blockerUpdates',
  'restore',
]

/** `notify.finished` and the like: one toggle of the `notify` object (#114), or null. */
function notifyKey(key: unknown): keyof NotifyToggles | null {
  if (typeof key !== 'string' || !key.startsWith('notify.')) return null
  const toggle = key.slice('notify.'.length)
  if (!(NOTIFY_KEYS as readonly string[]).includes(toggle)) {
    throw new SettingsError(`Unknown setting "${key}"`)
  }
  return toggle as keyof NotifyToggles
}

function settingKey(key: unknown): keyof Settings {
  if (typeof key !== 'string' || !(SETTING_KEYS as readonly string[]).includes(key)) {
    throw new SettingsError(`Unknown setting "${String(key)}"`)
  }
  return key as keyof Settings
}

function bind(staging: ConfigStaging, chord: unknown, command: unknown): void {
  if (typeof chord !== 'string') throw new KeymapError(`A chord is a string, not ${typeof chord}`)
  if (typeof command !== 'string') {
    throw new KeymapError(`The command bound to ${chord} is a name, not ${typeof command}`)
  }
  const canonical = normalizeChord(chord)
  const existing = staging.bindings.get(canonical)
  if (existing !== undefined) {
    throw new KeymapError(
      `Keymap "${USER_KEYMAP}": ${canonical} is already bound to ${existing.command}, cannot bind ${command}`,
    )
  }
  const spec = Object.fromEntries(
    [...staging.bindings.values(), { chord: canonical, command }].map((entry) => [
      entry.chord,
      entry.command,
    ]),
  )
  // Built whole on every call, so a prefix conflict throws on this line.
  staging.keymap = defineKeymap(USER_KEYMAP, spec)
  staging.bindings.set(canonical, { chord: canonical, command, site: staging.site() })
}

/** The `nemesis` object of one load, frozen, every member recording into `staging`. */
export function createConfigApi(staging: ConfigStaging, env: ConfigApiEnv): ConfigApi {
  const api: ConfigApi = {
    defineCommand(spec) {
      staging.open('defineCommand')
      if (!isRecord(spec)) throw new CommandError('defineCommand takes { name, doc, run }')
      const { name, doc, run } = spec
      if (typeof name !== 'string') throw new CommandError('A command name is a string')
      if (typeof doc !== 'string') throw new CommandError(`Command "${name}" needs a doc line`)
      if (typeof run !== 'function') throw new CommandError(`Command "${name}" needs a run()`)
      if (staging.reserved.has(name)) {
        throw new CommandError(
          `Command "${name}" is the cockpit's; a config command takes a new name and rebinds the keys`,
        )
      }
      if (staging.commands.has(name)) {
        throw new CommandError(`Command "${name}" is already defined in this file`)
      }
      const body = run as (context: unknown) => unknown
      staging.commands.set(
        name,
        defineCommand({
          name,
          doc,
          run: async (context) => {
            await body.call(undefined, { ...context })
          },
        }),
      )
    },
    defineKeymap(name, spec) {
      staging.open('defineKeymap')
      if (name !== USER_KEYMAP) {
        throw new KeymapError(
          `A config defines the "${USER_KEYMAP}" keymap only, not "${String(name)}"`,
        )
      }
      if (!isRecord(spec)) throw new KeymapError('A keymap is an object of chord to command name')
      for (const [chord, command] of Object.entries(spec)) bind(staging, chord, command)
    },
    bindKey(chord, command) {
      staging.open('bindKey')
      bind(staging, chord, command)
    },
    settings: {
      set(key, value) {
        staging.open('settings.set')
        const toggle = notifyKey(key)
        if (toggle !== null) {
          // One toggle over the object in force, the file's or the defaults.
          const notify = {
            ...(staging.settings().notify ?? DEFAULT_NOTIFY_TOGGLES),
            [toggle]: value,
          }
          staging.overrides.set('notify', parseSettings({ notify }, staging.base).notify)
          return
        }
        const name = settingKey(key)
        // The same rules as settings.json, one key at a time.
        staging.overrides.set(name, parseSettings({ [name]: value }, staging.base)[name])
      },
      get(key) {
        const toggle = notifyKey(key)
        if (toggle !== null) return staging.settings().notify?.[toggle] ?? null
        return staging.settings()[settingKey(key)]
      },
    },
    buffers: {
      list: () => env.buffers().map(({ id, kind, title }) => ({ id, kind, title })),
    },
    commands: {
      run: (name) => {
        if (typeof name !== 'string') {
          return Promise.reject(new CommandError('commands.run takes a command name'))
        }
        return env.run(name)
      },
    },
    notice(text) {
      env.notice(String(text))
    },
  }
  Object.freeze(api.settings)
  Object.freeze(api.buffers)
  Object.freeze(api.commands)
  return Object.freeze(api)
}
