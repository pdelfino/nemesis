import { stripTypeScriptTypes } from 'node:module'
import { inspect } from 'node:util'
import { createContext, Script, type Context } from 'node:vm'
import type { ConfigApiEnv } from './api'
import { ConfigError, ConfigStaging, createConfigApi } from './api'
import type { Journal } from './journal'
import type { ConfigLoader, ConfigTarget } from './loader'
import { CONFIG_TIMEOUT_MS, problemOf } from './loader'

/**
 * Eval in the config scope (#72, ADR 0006): `eval-expression` and the
 * `*repl*` buffer evaluate erasable TypeScript in the main process, with the
 * same `nemesis` object the init file gets and nothing else in scope, so a
 * definition made at eval is the same kind of thing the file makes. The
 * forms share one node:vm context for the life of the app: a `const` one
 * form declares, the next one reads.
 *
 * Each form is staged and checked like a load of the file, then its
 * commands and bindings are taken into the running image at once
 * (ConfigLoader.adoptEval), and the form is appended to the journal, which
 * holds it until it is promoted to init.ts or discarded. `nemesis.settings.set`
 * belongs in the file and is refused here, before anything is adopted.
 *
 * Eval runs only on a command the user ran from the cockpit's keys or
 * palette. Nothing reaches it from a page buffer or from an MCP server.
 * Like the file, it is trusted code with the app's privileges; node:vm is not
 * a sandbox.
 */

/** The name an error's frame carries for a form. */
export const EVAL_FILE = 'eval'

/** The printed value is cut here: the transcript is not a dump. */
const MAX_PRINTED = 2_000

export interface EvalOutcome {
  readonly ok: boolean
  /** The printed value, or the error. */
  readonly text: string
  /** What the form defined, journaled or not: `command say-hi, binding C-c h`. */
  readonly defined: string | null
  /** The journal note, when the form defined something. */
  readonly journal: string | null
}

export interface ConfigEvalOptions {
  readonly loader: ConfigLoader
  readonly target: ConfigTarget
  /** Null under `--no-config`: definitions still apply, and the note says they are not kept. */
  readonly journal: Journal | null
  readonly buffers: ConfigApiEnv['buffers']
  readonly run: ConfigApiEnv['run']
  readonly timeoutMs?: number
}

function printed(value: unknown): string {
  const text = typeof value === 'string' ? JSON.stringify(value) : inspect(value, { depth: 2 })
  return text.length > MAX_PRINTED ? `${text.slice(0, MAX_PRINTED)}...` : text
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === 'object' || typeof value === 'function') &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  )
}

export class ConfigEval {
  private readonly options: ConfigEvalOptions
  private context: Context | null = null

  constructor(options: ConfigEvalOptions) {
    this.options = options
  }

  async evaluate(form: string): Promise<EvalOutcome> {
    const { loader, target } = this.options
    const staging = new ConfigStaging(
      EVAL_FILE,
      loader.settings,
      loader.reservedNames(target.registry),
    )
    const api = createConfigApi(staging, {
      buffers: this.options.buffers,
      run: this.options.run,
      notice: (text) => loader.notify(text),
    })
    this.context ??= createContext({})
    // Every form gets its own `nemesis`, recording into its own staging.
    ;(this.context as { nemesis?: unknown }).nemesis = api
    let value: unknown
    let defined: string | null = null
    try {
      const js = stripTypeScriptTypes(form, { mode: 'strip' })
      value = new Script(js, { filename: EVAL_FILE }).runInContext(this.context, {
        timeout: this.options.timeoutMs ?? CONFIG_TIMEOUT_MS,
      })
      staging.sealed = true
      if (staging.overrides.size > 0) {
        throw new ConfigError(
          'nemesis.settings.set is not applied at eval: put it in init.ts and run reload-config',
        )
      }
      // A mode from eval would outlive the journal's promote and discard (#166).
      if (staging.modes.size > 0) {
        throw new ConfigError(
          'nemesis.defineMode is not applied at eval: put it in init.ts and run reload-config',
        )
      }
      // A handler from eval would be the `repl` source of ADR 0005, which waits for its own issue.
      if (staging.hooks.size > 0 || staging.removals.length > 0) {
        throw new ConfigError(
          'nemesis.on and nemesis.off are not applied at eval: put them in init.ts and run reload-config',
        )
      }
      // An entry from eval would outlive the journal's promote and discard, as a mode would (#180).
      if (staging.contextMenu.size > 0) {
        throw new ConfigError(
          'nemesis.addContextMenuCommand is not applied at eval: put it in init.ts and run reload-config',
        )
      }
      for (const binding of staging.bindings.values()) {
        if (!target.registry.has(binding.command) && !staging.commands.has(binding.command)) {
          throw new ConfigError(
            `Keymap "user" binds ${binding.chord} to unknown command "${binding.command}"`,
          )
        }
      }
      const commands = [...staging.commands.values()]
      const bindings = new Map(
        [...staging.bindings.values()].map((binding) => [binding.chord, binding.command]),
      )
      if (commands.length > 0 || bindings.size > 0) {
        loader.adoptEval(commands, bindings, target)
        defined = [
          ...commands.map((command) => `command ${command.name}`),
          ...[...bindings.keys()].map((chord) => `binding ${chord}`),
        ].join(', ')
      }
    } catch (error) {
      return { ok: false, text: problemOf(error, EVAL_FILE).message, defined: null, journal: null }
    } finally {
      staging.sealed = true
    }
    const note = defined === null ? null : this.journal(form, defined)
    try {
      if (isThenable(value)) value = await value
    } catch (error) {
      return { ok: false, text: problemOf(error, EVAL_FILE).message, defined, journal: note }
    }
    return { ok: true, text: printed(value), defined, journal: note }
  }

  private journal(form: string, defined: string): string {
    const journal = this.options.journal
    if (journal === null) return 'Not journaled: the app was started with --no-config.'
    const entry = journal.append(form, defined)
    const count = journal.count
    return `Journaled ${defined} as entry ${entry.id} of ${journal.path}: ${count} unpromoted.`
  }
}
