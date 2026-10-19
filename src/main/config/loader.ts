import { existsSync, readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { join } from 'node:path'
import { createContext, Script } from 'node:vm'
import type { AgentNoticeEvent } from '../agent/events'
import type { Keymap } from '../commands/keymap'
import { defineKeymap } from '../commands/keymap'
import type { Command, CommandRegistry } from '../commands/registry'
import type { Settings } from '../settings'
import type { CallSite, ConfigApiEnv } from './api'
import { ConfigError, ConfigStaging, createConfigApi, siteIn, USER_KEYMAP } from './api'

/**
 * The config file (#71, ADR 0006): `~/.config/nemesis/init.ts`, the user's
 * code the way `init.el` is, read at start and again on `reload-config`.
 *
 * Load is read, strip, evaluate, stage, commit. The file is one erasable
 * TypeScript module: `stripTypeScriptTypes` in strip mode replaces the types
 * with whitespace and moves nothing, so an error's line and column are the
 * line and column in the user's own text. It runs in a node:vm context whose
 * only addition to the standard globals is `nemesis` (src/main/config/api.ts):
 * no `require`, no `process`, no runtime `import`. Everything the file asks
 * for is staged and checked; only a load that ran to its end with every name
 * known is committed, in one step, so a failing reload leaves the previous
 * config live, and the first failing load leaves the cockpit's defaults.
 *
 * The file is trusted code with the app's privileges. node:vm keeps the scope
 * small, it is not a sandbox, and nothing here claims one.
 */

export const CONFIG_FILE = 'init.ts'

/** The safe mode of study 06: start with no config at all. */
export const NO_CONFIG_FLAG = '--no-config'

/** A loop at the top level of the file ends in an error, not a hung cockpit. */
export const CONFIG_TIMEOUT_MS = 2_000

/** Settings read once at start: an override of these waits for a restart. */
const RESTART_SETTINGS: readonly (keyof Settings)[] = ['sessionsDir', 'keyscheme']

export interface ConfigPathOptions {
  readonly home: string
  readonly env: Readonly<Record<string, string | undefined>>
  readonly argv: readonly string[]
}

/**
 * Where the config is, or null when there is none to load: `--no-config`,
 * or a test run without its own folder. Under test the folder named by
 * NEMESIS_CONFIG_DIR stands in for `~/.config/nemesis`, so a spec never
 * loads the developer's own file; the variable is ignored in any other run.
 */
export function configPath(options: ConfigPathOptions): string | null {
  if (options.argv.includes(NO_CONFIG_FLAG)) return null
  if (options.env['NODE_ENV'] === 'test') {
    const dir = options.env['NEMESIS_CONFIG_DIR']
    return dir === undefined || dir.length === 0 ? null : join(dir, CONFIG_FILE)
  }
  return join(options.home, '.config', 'nemesis', CONFIG_FILE)
}

/** A load error as data: the file, where, and the message. Never more than the file's own text. */
export interface ConfigProblem {
  readonly file: string
  readonly line: number | null
  readonly column: number | null
  readonly message: string
}

export interface ConfigCounts {
  readonly commands: number
  readonly bindings: number
  readonly settings: number
}

/** What the environment panel (#86) says about the file. */
export type ConfigStatus =
  | { readonly state: 'skipped' }
  | { readonly state: 'absent'; readonly path: string }
  | {
      readonly state: 'loaded'
      readonly path: string
      readonly at: number
      readonly counts: ConfigCounts
    }
  | { readonly state: 'error'; readonly path: string; readonly problem: ConfigProblem }

/** A load that ran to its end with every name known: ready to commit. */
export interface StagedConfig {
  readonly commands: readonly Command[]
  readonly keymap: Keymap | null
  readonly bindings: number
  readonly settings: Settings
  readonly overridden: readonly (keyof Settings)[]
}

export type StageResult =
  | { readonly ok: true; readonly config: StagedConfig }
  | { readonly ok: false; readonly problem: ConfigProblem }

export type ReloadResult =
  | { readonly ok: true; readonly line: string }
  | { readonly ok: false; readonly problem: ConfigProblem }

/** What a commit changes in the running cockpit. */
export interface ConfigTarget {
  readonly registry: CommandRegistry
  setUserKeymap(keymap: Keymap | null): void
  applySettings(settings: Settings): void
  /** After the swap: the menu is built again so its labels follow the keymaps. */
  rebuilt(): void
}

export interface ConfigLoaderOptions {
  /** The file, or null under `--no-config`. */
  readonly path: string | null
  /** settings.json, read again on every load: the init file overrides it in memory. */
  readonly base: () => Settings
  readonly buffers: ConfigApiEnv['buffers']
  readonly run: ConfigApiEnv['run']
  /** Milliseconds the file's top level may run. */
  readonly timeoutMs?: number
  readonly now?: () => number
}

/** The message, with the one thing a user hits first said by name. */
function explain(message: string): string {
  if (/^require is not defined/.test(message) || /^Cannot use import statement/.test(message)) {
    return `${message}: a runtime require or import is not available in the config; only \`import type\` is erased`
  }
  return message
}

/**
 * The problem an error stands for. A runtime error (the file's own throw, or
 * a validation error from the API) carries a frame in the file; a syntax
 * error carries V8's header instead, `file:line`, the source line and a
 * caret under the column; a validation error found after the body ran
 * carries the site of the call that asked for the thing it names.
 */
export function problemOf(error: unknown, file: string): ConfigProblem {
  const record = (typeof error === 'object' && error !== null ? error : {}) as {
    name?: unknown
    message?: unknown
    stack?: unknown
    site?: unknown
  }
  const message =
    typeof record.message === 'string'
      ? `${typeof record.name === 'string' ? record.name : 'Error'}: ${explain(record.message)}`
      : String(error)
  const stack = typeof record.stack === 'string' ? record.stack : ''
  const site =
    (record.site as CallSite | null | undefined) ?? siteIn(stack, file) ?? headerSite(stack)
  return { file, line: site?.line ?? null, column: site?.column ?? null, message }
}

function headerSite(stack: string): CallSite | null {
  // The stripper may print the line before too; the caret is under the last.
  const header = /^[^\n]*:(\d+)\n(?:[^\n]*\n)+?( *)\^/.exec(stack)
  if (header !== null) return { line: Number(header[1]), column: (header[2] ?? '').length + 1 }
  const line = /^[^\n]*:(\d+)\n/.exec(stack)
  return line === null ? null : { line: Number(line[1]), column: 0 }
}

/** `file, line 3, column 5`, or as much of it as is known. */
export function formatSite(problem: ConfigProblem): string {
  if (problem.line === null) return problem.file
  const column = problem.column === null || problem.column === 0 ? '' : `, column ${problem.column}`
  return `${problem.file}, line ${problem.line}${column}`
}

/** The help buffer's text for a failed load. */
export function renderProblem(problem: ConfigProblem): string {
  return [
    'Config errors',
    '',
    `${formatSite(problem)}:`,
    `  ${problem.message}`,
    '',
    'Nothing from this load was applied: the previous config, or the defaults, stays live.',
    'Fix the file, then M-x reload-config.',
  ].join('\n')
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

export type ConfigNoticeListener = (event: AgentNoticeEvent) => void

export class ConfigLoader {
  private readonly options: ConfigLoaderOptions
  private readonly listeners = new Set<ConfigNoticeListener>()
  /** The committed load: its command names are what a reload drops. */
  private live: StagedConfig | null = null
  /** The settings of the last load attempt's data file, while nothing is committed. */
  private base: Settings | null = null
  /** The settings the cockpit started with, for the restart note. */
  private started: Settings | null = null
  /**
   * What eval defined in the running image (#72), by command name and by
   * chord. Kept across a reload, except where the file now defines the same
   * name or chord: the later definition wins, as reloading init.el does.
   */
  private readonly evalCommands = new Map<string, Command>()
  private readonly evalBindings = new Map<string, string>()
  private current: ConfigStatus

  constructor(options: ConfigLoaderOptions) {
    this.options = options
    this.current =
      options.path === null ? { state: 'skipped' } : { state: 'absent', path: options.path }
  }

  get path(): string | null {
    return this.options.path
  }

  get status(): ConfigStatus {
    return this.current
  }

  /** The settings in force: the committed load's, else the data file's. */
  get settings(): Settings {
    return this.live?.settings ?? this.base ?? this.options.base()
  }

  /** The session bridge subscribes: a notice is shown and recorded like any event. */
  on(listener: ConfigNoticeListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  notify(text: string): void {
    const event: AgentNoticeEvent = { type: 'notice', text }
    for (const listener of [...this.listeners]) listener(event)
  }

  /**
   * Runs the file and checks everything it asked for, changing nothing live.
   * `reserved` is the cockpit's command names, which the file may neither
   * take nor lose; a binding may name them or the file's own commands.
   */
  stage(reserved: ReadonlySet<string>): StageResult {
    const base = this.options.base()
    this.base = base
    const path = this.options.path
    if (path === null || !existsSync(path)) {
      if (path !== null) this.current = { state: 'absent', path }
      return {
        ok: true,
        config: { commands: [], keymap: null, bindings: 0, settings: base, overridden: [] },
      }
    }
    const staging = new ConfigStaging(path, base, reserved)
    try {
      const source = readFileSync(path, 'utf8')
      const js = stripTypeScriptTypes(source, { mode: 'strip' })
      const api = createConfigApi(staging, {
        buffers: this.options.buffers,
        run: this.options.run,
        notice: (text) => this.notify(text),
      })
      const context = createContext({ nemesis: api })
      new Script(js, { filename: path }).runInContext(context, {
        timeout: this.options.timeoutMs ?? CONFIG_TIMEOUT_MS,
      })
      for (const binding of staging.bindings.values()) {
        if (!reserved.has(binding.command) && !staging.commands.has(binding.command)) {
          throw new ConfigError(
            `Keymap "user" binds ${binding.chord} to unknown command "${binding.command}"`,
            binding.site,
          )
        }
      }
    } catch (error) {
      const problem = problemOf(error, path)
      this.current = { state: 'error', path, problem }
      return { ok: false, problem }
    } finally {
      staging.sealed = true
    }
    return {
      ok: true,
      config: {
        commands: [...staging.commands.values()],
        keymap: staging.keymap,
        bindings: staging.bindings.size,
        settings: staging.settings(),
        overridden: [...staging.overrides.keys()],
      },
    }
  }

  /** Swaps the previous load for this one in one step. Everything was checked by `stage`. */
  commit(config: StagedConfig, target: ConfigTarget): void {
    for (const command of this.live?.commands ?? []) target.registry.unregister(command.name)
    for (const name of this.evalCommands.keys()) target.registry.unregister(name)
    target.registry.registerAll(config.commands)
    const defined = new Set(config.commands.map((command) => command.name))
    for (const [name, command] of [...this.evalCommands]) {
      if (defined.has(name)) this.evalCommands.delete(name)
      else target.registry.register(command)
    }
    const bound = new Set((config.keymap?.entries() ?? []).map((entry) => entry.chord))
    for (const [chord, command] of [...this.evalBindings]) {
      if (bound.has(chord) || !target.registry.has(command)) this.evalBindings.delete(chord)
    }
    let keymap: Keymap | null
    try {
      keymap = this.userKeymap(config.keymap, this.evalBindings)
    } catch (error) {
      // A chord of the file now prefixes one made at eval, or the reverse: the file wins.
      this.evalBindings.clear()
      keymap = config.keymap
      this.notify(
        `Bindings made at eval dropped: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    target.setUserKeymap(keymap)
    target.applySettings(config.settings)
    this.live = config
    this.started ??= config.settings
    const path = this.options.path
    if (path !== null && existsSync(path)) {
      this.current = {
        state: 'loaded',
        path,
        at: (this.options.now ?? Date.now)(),
        counts: this.counts(config),
      }
    }
    target.rebuilt()
  }

  /**
   * `reload-config`: the file again, against the cockpit's commands as they
   * are now (every name in the registry but the previous load's). On success
   * one line with the counts and the settings that wait for a restart.
   */
  reload(target: ConfigTarget): ReloadResult {
    const result = this.stage(this.reservedNames(target.registry))
    if (!result.ok) return result
    this.commit(result.config, target)
    return { ok: true, line: this.reloadLine(result.config) }
  }

  /**
   * The cockpit's own command names: every name in the registry but the
   * committed load's and the ones eval made, which a reload or an eval may
   * define again.
   */
  reservedNames(registry: CommandRegistry): Set<string> {
    const own = new Set((this.live?.commands ?? []).map((command) => command.name))
    return new Set(
      registry
        .list()
        .map((command) => command.name)
        .filter((name) => !own.has(name) && !this.evalCommands.has(name)),
    )
  }

  /**
   * Takes what one eval defined into the running image (#72): its commands
   * replace any of the same name, its bindings go into the user layer over
   * the file's. The merged layer is built first, so a conflict throws before
   * anything changes.
   */
  adoptEval(
    commands: readonly Command[],
    bindings: ReadonlyMap<string, string>,
    target: ConfigTarget,
  ): void {
    const merged = new Map([...this.evalBindings, ...bindings])
    const keymap = this.userKeymap(this.live?.keymap ?? null, merged)
    for (const command of commands) {
      target.registry.unregister(command.name)
      target.registry.register(command)
      this.evalCommands.set(command.name, command)
    }
    for (const [chord, command] of bindings) this.evalBindings.set(chord, command)
    target.setUserKeymap(keymap)
    target.rebuilt()
  }

  /** The user layer: the file's bindings with eval's over them. */
  private userKeymap(base: Keymap | null, bindings: ReadonlyMap<string, string>): Keymap | null {
    if (bindings.size === 0) return base
    return defineKeymap(USER_KEYMAP, {
      ...Object.fromEntries((base?.entries() ?? []).map((entry) => [entry.chord, entry.command])),
      ...Object.fromEntries(bindings),
    })
  }

  private counts(config: StagedConfig): ConfigCounts {
    return {
      commands: config.commands.length,
      bindings: config.bindings,
      settings: config.overridden.length,
    }
  }

  private reloadLine(config: StagedConfig): string {
    const path = this.options.path
    if (path === null) return 'No config: the app was started with --no-config.'
    if (this.current.state === 'absent') return `No config at ${path}: the defaults are live.`
    const counts = this.counts(config)
    const started = this.started
    const restart =
      started === null
        ? []
        : RESTART_SETTINGS.filter((key) => config.settings[key] !== started[key])
    const note =
      restart.length === 0
        ? ''
        : ` ${restart.join(' and ')} ${restart.length === 1 ? 'needs' : 'need'} a restart.`
    return `Config reloaded from ${path}: ${plural(counts.commands, 'command')}, ${plural(
      counts.bindings,
      'binding',
    )}, ${plural(counts.settings, 'setting')} overridden.${note}`
  }
}
