import type { BufferType } from '../../shared/keys'

/**
 * The command registry (#59). Every action in the cockpit is a named command,
 * so a key, the M-x palette (#65) and a later extension all reach it the same
 * way. Nothing in the app calls an action by any other route.
 */

/** Where the invocation came from, for commands that care. */
export interface CommandContext {
  readonly source: 'key' | 'palette' | 'menu' | 'config' | 'test'
  /** The chord that ran it, in Emacs notation, when a key did. */
  readonly chord?: string
  readonly bufferType?: BufferType | null
}

export interface Command {
  /** Kebab-case, as the user types it at M-x: `switch-buffer`. */
  readonly name: string
  /** One line, shown by the palette and by describe-command. */
  readonly doc: string
  run(context: CommandContext): void | Promise<void>
}

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

  async run(name: string, context: CommandContext): Promise<void> {
    await this.require(name).run(context)
  }
}
