import type { Command } from '../commands/registry'
import { CommandError, defineCommand } from '../commands/registry'
import type { Keymap } from '../commands/keymap'
import { defineKeymap, KeymapError, normalizeChord } from '../commands/keymap'
import type { HookHandler, HookPoint, HookResult } from '../hooks'
import { checkHandler, checkPointAndName, HOOK_POINTS, HookError } from '../hooks'
import type { Mode, ModeHook } from '../commands/modes'
import { defineMode, ModeError, togglerName } from '../commands/modes'
import type { NotifyToggles, Settings } from '../settings'
import { MAX_CONTEXT_LABEL } from '../pages/context-menu'
import type { UserPage } from '../pages/user-pages'
import { isUserPageName, MAX_USER_PAGE_TITLE } from '../../shared/user-pages'
import { DEFAULT_NOTIFY_TOGGLES, NOTIFY_KEYS, parseSettings, SettingsError } from '../settings'

/**
 * The surface the config file sees (#71, ADR 0006): one object, `nemesis`,
 * and nothing else in scope. Every member records what the file asks for in
 * a staging area, validated as it is called, so a bad name fails on the
 * file's own line; nothing reaches the live registry, keymaps or settings
 * until the loader commits the whole load.
 *
 * The object reaches the command registry's shapes, the keymap builder, the
 * settings rules, the hook points (#165), URL dispatch over `before-load`
 * (#179), the mode definition (#166), the page context menu (#180), the
 * config's own pages (#181), a read
 * of the buffer list,
 * `commands.run` and `notice`, and
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

/** A hook handler the file registers, and where, so a clash at commit is reported on its line. */
export interface StagedHook {
  readonly point: HookPoint
  readonly handler: HookHandler<HookPoint>
  readonly site: CallSite | null
}

/** A mode the file defines, and where, so an unknown command in its keymap is reported on its line. */
export interface StagedMode {
  readonly mode: Mode
  readonly site: CallSite | null
}

/** What a binding asked for, and where, so an unknown command is reported on its line. */
export interface StagedBinding {
  readonly chord: string
  readonly command: string
  readonly site: CallSite | null
}

/** A context-menu entry the file adds, and where, so an unknown command is reported on its line. */
export interface StagedContextMenuEntry {
  readonly label: string
  readonly command: string
  readonly site: CallSite | null
}

/** A page the file defines, and where. */
export interface StagedPage {
  readonly page: UserPage
  readonly site: CallSite | null
}

/** The command that opens a config page (#181). */
export function pageCommandName(name: string): string {
  return `page-${name}`
}

/**
 * One load's requests. `reserved` is the names the file may not take: the
 * cockpit's commands, which stay whatever the file does.
 */
export class ConfigStaging {
  readonly commands = new Map<string, Command>()
  readonly bindings = new Map<string, StagedBinding>()
  readonly overrides = new Map<keyof Settings, Settings[keyof Settings]>()
  /** Hook handlers by `point name`, in the order the file registered them (#165). */
  readonly hooks = new Map<string, StagedHook>()
  /** Handlers of another source the file removes with `off`, applied at commit. */
  readonly removals: { readonly point: HookPoint; readonly name: string }[] = []
  /** Modes by name, in the order the file defined them (#166). */
  readonly modes = new Map<string, StagedMode>()
  /** Page context-menu entries by label, in the order the file added them (#180). */
  readonly contextMenu = new Map<string, StagedContextMenuEntry>()
  /** The file's pages by name, in the order the file defined them (#181). */
  readonly pages = new Map<string, StagedPage>()
  /** The user layer as built so far, so a conflict between two chords fails on the call that made it. */
  keymap: Keymap | null = null
  /** Set when the file's body has run: a definition from a command body later would be lost. */
  sealed = false

  constructor(
    readonly file: string,
    readonly base: Settings,
    readonly reserved: ReadonlySet<string>,
    /** The mode names the file may not take: the cockpit's and the page buffer's. */
    readonly reservedModes: ReadonlySet<string> = new Set(),
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
  /** Turns a mode on or off in the focused window's current buffer, for a config mode's toggle (#166). */
  readonly toggleMode?: (name: string) => Promise<void>
  /** Opens a config page in a new page buffer of the focused window, for `page-<name>` (#181). */
  readonly openPage?: (name: string) => Promise<void>
}

export interface ConfigApi {
  defineCommand(spec: unknown): void
  defineKeymap(name: unknown, spec: unknown): void
  bindKey(chord: unknown, command: unknown): void
  /** A handler at a hook point (ADR 0005), with the source `config`. */
  on(point: unknown, spec: unknown): void
  /** Removes a handler by point and name. */
  off(point: unknown, name: unknown): void
  /**
   * A URL rule (#179): a `before-load` handler that rewrites or blocks the
   * page loads whose URL `match` matches. The answer still goes through the
   * page policy.
   */
  dispatchUrl(spec: unknown): void
  /** A mode (ADR 0004): a keymap layer, hooks and settings, with `toggle-<name>` unless `toggler` is false. */
  defineMode(spec: unknown): void
  /**
   * An entry of the page context menu (#180) that runs `command`; the command
   * reads the link and the selection under the pointer from `context.atPoint`.
   */
  addContextMenuCommand(label: unknown, command: unknown): void
  /**
   * A page at `nemesis://app/user/<name>` (#181): `render(params)` returns its
   * HTML, which runs no script; a `<button data-command="...">` on it runs a
   * registered command. `page-<name>` opens it.
   */
  definePage(name: unknown, spec: unknown): void
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
  'fanOutMax',
  'notify',
  'blockerUpdates',
  'restore',
  'hints',
  'pageModes',
]

/** `{ [key]: value }` when the value is there, `{}` when it is not, for an optional spec field. */
function optional<K extends string, V>(key: K, value: V | undefined): Partial<Record<K, V>> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>)
}

function stringField(spec: Record<string, unknown>, key: string, mode: string): string {
  const value = spec[key]
  if (typeof value !== 'string') throw new ModeError(`Mode "${mode}" needs a ${key} line`)
  return value
}

function booleanField(
  spec: Record<string, unknown>,
  key: string,
  mode: string,
): boolean | undefined {
  const value = spec[key]
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') throw new ModeError(`Mode "${mode}": ${key} is true or false`)
  return value
}

function recordField(
  spec: Record<string, unknown>,
  key: string,
  mode: string,
): Record<string, unknown> | undefined {
  const value = spec[key]
  if (value === undefined) return undefined
  if (!isRecord(value)) throw new ModeError(`Mode "${mode}": ${key} is an object`)
  return { ...value }
}

function keymapField(
  spec: Record<string, unknown>,
  mode: string,
): Record<string, string> | undefined {
  const value = recordField(spec, 'keymap', mode)
  if (value === undefined) return undefined
  for (const [chord, command] of Object.entries(value)) {
    if (typeof command !== 'string') {
      throw new KeymapError(
        `Mode "${mode}": the command bound to ${chord} is a name, not ${typeof command}`,
      )
    }
  }
  return value as Record<string, string>
}

/** The file's hooks of a mode, checked as `on` checks them and wrapped as `on` wraps them. */
function modeHooks(spec: Record<string, unknown>, mode: string): readonly ModeHook[] | undefined {
  const value = spec['hooks']
  if (value === undefined) return undefined
  if (!Array.isArray(value))
    throw new ModeError(`Mode "${mode}": hooks is a list of { point, name, doc, run }`)
  return value.map((hook: unknown): ModeHook => {
    if (!isRecord(hook)) throw new ModeError(`Mode "${mode}": a hook is { point, name, doc, run }`)
    const { point, name, doc, run } = hook
    checkHandler(point, name, doc, run)
    return {
      point: point as HookPoint,
      handler: fileHandler(point as HookPoint, name as string, doc as string, run),
    }
  })
}

/** What a handler of the file returned, as the registry reads it: a veto, a rewrite or nothing. */
function answerOf(result: unknown): HookResult {
  if (!isRecord(result)) return undefined
  if (result['veto'] === true) {
    return { veto: true, reason: String(result['reason'] ?? 'refused by the config') }
  }
  if ('rewrite' in result) return { rewrite: result['rewrite'] as string }
  return undefined
}

/**
 * A handler of the file, frozen; it sees a copy of the payload, as a command
 * body sees a copy of its context. At a synchronous point (`before-load`) the
 * body is called and answered at once, and a promise it returns is handed on
 * for the registry to report.
 */
function fileHandler(
  point: HookPoint,
  name: string,
  doc: string,
  run: unknown,
): HookHandler<HookPoint> {
  const body = run as (event: unknown, signal: AbortSignal) => unknown
  const call = (event: unknown, signal: AbortSignal): unknown =>
    body.call(undefined, { ...(event as object) }, signal)
  return Object.freeze({
    name,
    doc,
    run:
      HOOK_POINTS[point].synchronous === true
        ? (event: unknown, signal: AbortSignal) => {
            const result = call(event, signal)
            return isPromiseLike(result) ? Promise.resolve(result).then(answerOf) : answerOf(result)
          }
        : async (event: unknown, signal: AbortSignal) => answerOf(await call(event, signal)),
  })
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return isRecord(value) && typeof value['then'] === 'function'
}

/** A RegExp of any realm: the config's come from its own vm context. */
function isRegExp(value: unknown): value is RegExp {
  return Object.prototype.toString.call(value) === '[object RegExp]'
}

/** `dispatchUrl`'s spec, checked on the file's line, as a `before-load` handler. */
function urlRule(spec: unknown, staging: ConfigStaging): HookHandler<'before-load'> {
  if (!isRecord(spec)) {
    throw new HookError('dispatchUrl takes { match, rewrite } or { match, block }')
  }
  const { match, rewrite, block } = spec
  if (!isRegExp(match)) throw new HookError('dispatchUrl: match is a regular expression')
  if ((rewrite === undefined) === (block === undefined)) {
    throw new HookError('dispatchUrl takes one of rewrite or block')
  }
  if (rewrite !== undefined && typeof rewrite !== 'function') {
    throw new HookError('dispatchUrl: rewrite is a function from URL to URL')
  }
  if (block !== undefined && typeof block !== 'string' && block !== true) {
    throw new HookError('dispatchUrl: block is true or a reason')
  }
  // A copy without g or y, so a test keeps no lastIndex between loads.
  const pattern = new RegExp(match.source, match.flags.replace(/[gy]/g, ''))
  let name = spec['name']
  if (name === undefined) {
    let n = 1
    while (staging.hooks.has(`before-load dispatch-url-${n}`)) n += 1
    name = `dispatch-url-${n}`
  }
  const doc =
    spec['doc'] ??
    `${rewrite === undefined ? 'Blocks' : 'Rewrites'} page loads matching ${String(pattern)}.`
  const body = rewrite as ((url: string) => unknown) | undefined
  const run = (event: { readonly url: string }): HookResult => {
    if (!pattern.test(event.url)) return undefined
    if (body === undefined) {
      return {
        veto: true,
        reason: typeof block === 'string' ? block : `matches ${String(pattern)}`,
      }
    }
    const target = body.call(undefined, event.url)
    if (typeof target !== 'string') throw new HookError('a rewrite returns a URL string')
    return { rewrite: target }
  }
  checkHandler('before-load', name, doc, run)
  return Object.freeze({ name: name as string, doc: doc as string, run })
}

/** A mode's enable or disable from the file: it sees copies of the buffer and the state. */
function transition(
  spec: Record<string, unknown>,
  key: 'enable' | 'disable',
  mode: string,
): ((buffer: object, state: object) => Promise<void>) | undefined {
  const value = spec[key]
  if (value === undefined) return undefined
  if (typeof value !== 'function') throw new ModeError(`Mode "${mode}": ${key} is a function`)
  const body = value as (buffer: unknown, state: unknown) => unknown
  return async (buffer, state) => {
    await body.call(undefined, { ...buffer }, { ...state })
  }
}

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
    on(point, spec) {
      staging.open('on')
      if (!isRecord(spec)) throw new HookError('on takes a point and { name, doc, run }')
      const { name, doc, run } = spec
      checkHandler(point, name, doc, run)
      const key = `${String(point)} ${String(name)}`
      if (staging.hooks.has(key)) {
        throw new HookError(`Hook "${String(point)}" already has a handler named "${String(name)}"`)
      }
      staging.hooks.set(key, {
        point: point as HookPoint,
        handler: fileHandler(point as HookPoint, name as string, doc as string, run),
        site: staging.site(),
      })
    },
    dispatchUrl(spec) {
      staging.open('dispatchUrl')
      const handler = urlRule(spec, staging)
      const key = `before-load ${handler.name}`
      if (staging.hooks.has(key)) {
        throw new HookError(`Hook "before-load" already has a handler named "${handler.name}"`)
      }
      staging.hooks.set(key, {
        point: 'before-load',
        handler: handler as unknown as HookHandler<HookPoint>,
        site: staging.site(),
      })
    },
    off(point, name) {
      staging.open('off')
      checkPointAndName(point, name)
      // A handler this file registered is simply not registered; any other waits for the commit.
      if (!staging.hooks.delete(`${String(point)} ${String(name)}`)) {
        staging.removals.push({ point: point as HookPoint, name: name as string })
      }
    },
    defineMode(spec) {
      staging.open('defineMode')
      if (!isRecord(spec)) throw new ModeError('defineMode takes { name, doc, keymap?, ... }')
      const name = spec['name']
      if (typeof name !== 'string') throw new ModeError('A mode name is a string')
      if (staging.reservedModes.has(name)) {
        throw new ModeError(`Mode "${name}" is the cockpit's; a config mode takes a new name`)
      }
      if (staging.modes.has(name))
        throw new ModeError(`Mode "${name}" is already defined in this file`)
      const mode = defineMode({
        name,
        doc: stringField(spec, 'doc', name),
        ...optional('keymap', keymapField(spec, name)),
        ...optional('settings', recordField(spec, 'settings', name)),
        ...optional('visible', booleanField(spec, 'visible', name)),
        ...optional('modal', booleanField(spec, 'modal', name)),
        ...optional('toggler', booleanField(spec, 'toggler', name)),
        ...optional('hooks', modeHooks(spec, name)),
        ...optional('enable', transition(spec, 'enable', name)),
        ...optional('disable', transition(spec, 'disable', name)),
      })
      if (mode.toggler !== false) {
        const toggler = togglerName(name)
        if (staging.reserved.has(toggler) || staging.commands.has(toggler)) {
          throw new CommandError(`Command "${toggler}" is already defined; set toggler: false`)
        }
        staging.commands.set(
          toggler,
          defineCommand({
            name: toggler,
            doc: `Turn ${name} mode on or off in the current buffer: ${mode.doc}`,
            run: async () => {
              if (env.toggleMode === undefined)
                throw new CommandError('No window to toggle a mode in')
              await env.toggleMode(name)
            },
          }),
        )
      }
      staging.modes.set(name, { mode, site: staging.site() })
    },
    addContextMenuCommand(label, command) {
      staging.open('addContextMenuCommand')
      if (typeof label !== 'string' || label.trim().length === 0) {
        throw new CommandError('addContextMenuCommand: the label is a non-empty string')
      }
      if (label.length > MAX_CONTEXT_LABEL || /[\r\n]/.test(label)) {
        throw new CommandError(
          `addContextMenuCommand: the label is one line of at most ${MAX_CONTEXT_LABEL} characters`,
        )
      }
      if (typeof command !== 'string') {
        throw new CommandError(`Context-menu entry "${label}": the command is a name`)
      }
      if (staging.contextMenu.has(label)) {
        throw new CommandError(`Context-menu entry "${label}" is already added in this file`)
      }
      staging.contextMenu.set(label, { label, command, site: staging.site() })
    },
    definePage(name, spec) {
      staging.open('definePage')
      if (!isUserPageName(name)) {
        throw new CommandError('definePage: the name is kebab-case, at most 64 characters')
      }
      if (!isRecord(spec))
        throw new CommandError(`Page "${name}": definePage takes { title, render }`)
      const { title, render } = spec
      if (
        typeof title !== 'string' ||
        title.trim().length === 0 ||
        title.length > MAX_USER_PAGE_TITLE ||
        /[\r\n]/.test(title)
      ) {
        throw new CommandError(
          `Page "${name}": the title is one line of at most ${MAX_USER_PAGE_TITLE} characters`,
        )
      }
      if (typeof render !== 'function') {
        throw new CommandError(`Page "${name}": render is a function from params to HTML`)
      }
      if (staging.pages.has(name)) {
        throw new CommandError(`Page "${name}" is already defined in this file`)
      }
      const opener = pageCommandName(name)
      if (staging.reserved.has(opener) || staging.commands.has(opener)) {
        throw new CommandError(`Command "${opener}" is already defined; a page takes a new name`)
      }
      const body = render as (params: unknown) => unknown
      staging.commands.set(
        opener,
        defineCommand({
          name: opener,
          doc: `Open the page ${title}.`,
          run: async () => {
            if (env.openPage === undefined) throw new CommandError('No window to open a page in')
            await env.openPage(name)
          },
        }),
      )
      staging.pages.set(name, {
        page: Object.freeze({
          name,
          title,
          // A copy of the params, as a command body sees a copy of its context.
          render: (params: Readonly<Record<string, string>>) =>
            body.call(undefined, { ...params }) as string,
        }),
        site: staging.site(),
      })
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
