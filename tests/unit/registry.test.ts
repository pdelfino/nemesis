import { describe, expect, it, vi } from 'vitest'
import {
  CommandError,
  CommandRegistry,
  defineCommand,
  type Command,
} from '../../src/main/commands/registry'

function noop(name: string, doc = 'Does nothing yet.'): Command {
  return defineCommand({ name, doc, run: () => undefined })
}

describe('the command registry (#59)', () => {
  it('insists on a kebab-case name and a doc line', () => {
    expect(() => noop('Switch Buffer')).toThrow(CommandError)
    expect(() => noop('switch_buffer')).toThrow(/kebab-case/)
    expect(() => noop('switch-buffer', ' ')).toThrow(/doc line/)
    expect(noop('switch-buffer').name).toBe('switch-buffer')
  })

  it('freezes a command so nothing rewrites it later', () => {
    expect(Object.isFrozen(noop('kill-buffer'))).toBe(true)
  })

  it('refuses to register the same name twice', () => {
    const registry = new CommandRegistry()
    registry.register(noop('kill-buffer'))
    expect(() => registry.register(noop('kill-buffer'))).toThrow(/already registered/)
  })

  it('lists commands sorted by name, for the palette and describe-command', () => {
    const registry = new CommandRegistry()
    registry.registerAll([noop('switch-buffer'), noop('execute-command'), noop('kill-buffer')])
    expect(registry.list().map((command) => command.name)).toEqual([
      'execute-command',
      'kill-buffer',
      'switch-buffer',
    ])
    expect(registry.get('kill-buffer')?.doc).toBe('Does nothing yet.')
    expect(registry.has('no-such-command')).toBe(false)
  })

  it('runs a command by name and says so when there is none', async () => {
    const run = vi.fn()
    const registry = new CommandRegistry()
    registry.register(defineCommand({ name: 'send-prompt', doc: 'Sends.', run }))
    await registry.run('send-prompt', { source: 'palette' })
    expect(run).toHaveBeenCalledWith({ source: 'palette' })
    await expect(registry.run('nope', { source: 'test' })).rejects.toThrow(/No command named/)
  })

  it('refuses a never command from the config or the MCP door, whatever a hook asks', async () => {
    const run = vi.fn()
    const registry = new CommandRegistry()
    registry.register(
      defineCommand({ name: 'answer-yes', mcp: 'never', doc: 'Allow the pending tool once.', run }),
    )
    await expect(registry.run('answer-yes', { source: 'config' })).rejects.toThrow(
      /only you can answer.*the config/,
    )
    await expect(registry.run('answer-yes', { source: 'mcp', client: 'x' })).rejects.toThrow(
      /an MCP client/,
    )
    expect(run).not.toHaveBeenCalled()
    for (const source of ['key', 'palette', 'menu', 'test'] as const) {
      await registry.run('answer-yes', { source })
    }
    expect(run).toHaveBeenCalledTimes(4)
  })
})
