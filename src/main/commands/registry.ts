import type { BufferType } from '../../shared/keys'
import type { HookRegistry } from '../hooks'

/**
 * The command registry (#59). Every action in the cockpit is a named command,
 * so a key, the M-x palette (#65) and a later extension all reach it the same
 * way. Nothing in the app calls an action by any other route.
 */

/** Where the invocation came from, for commands that care. */
export interface CommandContext {
  readonly source: 'key' | 'palette' | 'menu' | 'config' | 'test' | 'mcp'
  /** With `mcp`: the name the client gave at initialize (#28), so a command can tell who asked. */
  readonly client?: string
  /** The chord that ran it, in Emacs notation, when a key did. */
  readonly chord?: string
  readonly bufferType?: BufferType | null
}

export interface Command {
  /** Kebab-case, as the user types it at M-x: `switch-buffer`. */
  readonly name: string
  /** One line, shown by the palette and by describe-command. */
  readonly doc: string
  /**
   * What `cockpit_run_command` costs an MCP client (ADR 0008): `free` runs at
   * once, `yes` asks the user each call, `never` is refused. Absent means
   * `yes`, so a command nobody thought about is not free by accident.
   */
  readonly mcp?: McpClass
  run(context: CommandContext): void | Promise<void>
}

/** The confirmation classes of ADR 0007, as a command declares one. */
export type McpClass = 'free' | 'yes' | 'never'

export class CommandError extends Error {
  override readonly name = 'CommandError'
}

const COMMAND_NAME = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/

export function defineCommand(command: Command): Command {
  if (!COMMAND_NAME.test(command.name)) {
    throw new CommandError(`Command name "${command.name}" is not kebab-case`)
  }
  if (command.doc.trim().length === 0) {
    throw new CommandError(`Command "${command.name}" needs a doc line`)
  }
  return Object.freeze({ ...command })
}

export class CommandRegistry {
  private readonly commands = new Map<string, Command>()
  /** The app's hooks (#165): before-command may refuse a run, after-command hears it. */
  private hooks: HookRegistry | null = null

  /** Fires the command points of ADR 0005 from `run`, whichever caller ran it. */
  useHooks(hooks: HookRegistry): void {
    this.hooks = hooks
  }

  register(command: Command): Command {
    const existing = this.commands.get(command.name)
    if (existing !== undefined) {
      throw new CommandError(`Command "${command.name}" is already registered`)
    }
    this.commands.set(command.name, command)
    return command
  }

  registerAll(commands: readonly Command[]): void {
    for (const command of commands) this.register(command)
  }

  /** Drops a command, as a config reload drops the previous load's (#71). */
  unregister(name: string): void {
    this.commands.delete(name)
  }

  get(name: string): Command | undefined {
    return this.commands.get(name)
  }

  has(name: string): boolean {
    return this.commands.has(name)
  }

  require(name: string): Command {
    const command = this.commands.get(name)
    if (command === undefined) throw new CommandError(`No command named "${name}"`)
    return command
  }

  /** Every command, sorted by name. Feeds the palette and describe-command. */
  list(): readonly Command[] {
    return Array.from(this.commands.values()).sort((a, b) => a.name.localeCompare(b.name))
  }

  /**
   * Runs a command. The hooks fire here, one level below the dispatcher, so
   * a key, the palette, the menu and the config all pass them (ADR 0005).
   */
  async run(name: string, context: CommandContext): Promise<void> {
    const command = this.require(name)
    const hooks = this.hooks
    if (hooks?.has('before-command') === true) {
      // The hook registry's notice says who refused and why; the command does not run.
      if ((await hooks.fire('before-command', { command: name, context })) !== null) return
    }
    if (hooks?.has('after-command') !== true) {
      await command.run(context)
      return
    }
    const started = Date.now()
    let ok = false
    try {
      await command.run(context)
      ok = true
    } finally {
      await hooks.fire('after-command', {
        command: name,
        context,
        ok,
        durationMs: Date.now() - started,
      })
    }
  }
}
