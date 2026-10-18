import { describe, expect, it, vi } from 'vitest'
import type { KeyPress } from '../../src/shared/keys'
import {
  assertBindingsAreRegistered,
  isInternalSender,
  KeyDispatcher,
  parseKeyPress,
} from '../../src/main/commands/dispatcher'
import { defineKeymap, KeyResolver } from '../../src/main/commands/keymap'
import { CommandRegistry, defineCommand } from '../../src/main/commands/registry'
import {
  BUFFER_KEYMAPS,
  cockpitCommands,
  createCockpitDispatcher,
  createCockpitRegistry,
  GLOBAL_KEYMAP,
} from '../../src/main/commands/keyscheme'
import { BufferRegistry } from '../../src/main/buffers'
import { PermissionBridge } from '../../src/main/agent/permission-bridge'

function press(key: string, options: Partial<KeyPress> = {}): KeyPress {
  return {
    key,
    code: '',
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    metaKey: false,
    bufferType: null,
    ...options,
  }
}

describe('the default Emacs keyscheme (#59)', () => {
  it('binds the cockpit keys the issue asks for', () => {
    expect(GLOBAL_KEYMAP.commandFor('C-c C-c')).toBe('send-prompt')
    expect(GLOBAL_KEYMAP.commandFor('M-x')).toBe('execute-command')
    expect(GLOBAL_KEYMAP.commandFor('C-x b')).toBe('switch-buffer')
    expect(GLOBAL_KEYMAP.commandFor('C-x k')).toBe('kill-buffer')
    expect(GLOBAL_KEYMAP.commandFor('C-s')).toBe('search-buffer')
    expect(GLOBAL_KEYMAP.commandFor('C-g')).toBe('keyboard-quit')
    expect(BUFFER_KEYMAPS.permission?.commandFor('y')).toBe('answer-yes')
    expect(BUFFER_KEYMAPS.permission?.commandFor('n')).toBe('answer-no')
    // The session allow and the question digits (#63).
    expect(BUFFER_KEYMAPS.permission?.commandFor('a')).toBe('allow-for-session')
    expect(BUFFER_KEYMAPS.permission?.commandFor('1')).toBe('choose-option-1')
    expect(BUFFER_KEYMAPS.permission?.commandFor('4')).toBe('choose-option-4')
    expect(BUFFER_KEYMAPS.permission?.commandFor('5')).toBeUndefined()
  })

  it('registers every command a keymap names', () => {
    const registry = createCockpitRegistry()
    const buffers = new BufferRegistry()
    expect(registry.list()).toHaveLength(
      cockpitCommands(buffers, new PermissionBridge(buffers)).length,
    )
    expect(() =>
      assertBindingsAreRegistered(registry, [GLOBAL_KEYMAP, ...Object.values(BUFFER_KEYMAPS)]),
    ).not.toThrow()
  })

  it('fails at startup when a binding names a command nobody registered', () => {
    const registry = new CommandRegistry()
    expect(() =>
      assertBindingsAreRegistered(registry, [defineKeymap('x', { 'C-q': 'ghost' })]),
    ).toThrow(/unknown command "ghost"/)
  })
})

describe('the dispatcher', () => {
  it('runs the command a chord names and logs the dispatch', async () => {
    const dispatcher = createCockpitDispatcher()
    expect(await dispatcher.handle(press('x', { altKey: true, code: 'KeyX' }))).toEqual({
      status: 'command',
      chord: 'M-x',
      command: 'execute-command',
    })
    expect(await dispatcher.handle(press('x', { ctrlKey: true, code: 'KeyX' }))).toEqual({
      status: 'pending',
      chord: 'C-x',
    })
    expect(await dispatcher.handle(press('b', { code: 'KeyB' }))).toMatchObject({
      command: 'switch-buffer',
    })
    expect(dispatcher.log.map((record) => record.command)).toEqual([
      'execute-command',
      'switch-buffer',
    ])
    expect(dispatcher.log.every((record) => typeof record.at === 'number')).toBe(true)
  })

  it('answers a permission prompt with an unmodified key', async () => {
    const dispatcher = createCockpitDispatcher()
    expect(
      await dispatcher.handle(press('y', { code: 'KeyY', bufferType: 'permission' })),
    ).toMatchObject({
      command: 'answer-yes',
    })
    expect(
      await dispatcher.handle(press('y', { code: 'KeyY', bufferType: 'prompt' })),
    ).toMatchObject({
      status: 'unbound',
    })
  })

  it('ignores a bare modifier and reports the sequence in flight', async () => {
    const dispatcher = createCockpitDispatcher()
    await dispatcher.handle(press('x', { ctrlKey: true, code: 'KeyX' }))
    expect(await dispatcher.handle(press('Control', { ctrlKey: true }))).toEqual({
      status: 'ignored',
      chord: 'C-x',
    })
    expect(dispatcher.pending).toBe('C-x')
  })

  it('tells the renderer when a command throws, without logging its buffer', async () => {
    const registry = new CommandRegistry()
    registry.register(
      defineCommand({
        name: 'boom',
        doc: 'Throws.',
        run: () => {
          throw new Error('no')
        },
      }),
    )
    const dispatcher = new KeyDispatcher(
      registry,
      new KeyResolver({ global: defineKeymap('global', { 'C-q': 'boom' }) }),
    )
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    expect(await dispatcher.handle(press('q', { ctrlKey: true, code: 'KeyQ' }))).toEqual({
      status: 'error',
      chord: 'C-q',
      command: 'boom',
    })
    expect(errors).toHaveBeenCalled()
    errors.mockRestore()
  })
})

describe('what the main process accepts from a page', () => {
  it('validates the key press payload', () => {
    expect(parseKeyPress({ key: 'x', code: 'KeyX', ctrlKey: true })).toEqual({
      key: 'x',
      code: 'KeyX',
      ctrlKey: true,
      altKey: false,
      shiftKey: false,
      metaKey: false,
      bufferType: null,
    })
    expect(() => parseKeyPress(null)).toThrow(/not an object/)
    expect(() => parseKeyPress({ code: 'KeyX' })).toThrow(/usable key/)
    expect(() => parseKeyPress({ key: 'x', code: 'KeyX', bufferType: 'root' })).toThrow(
      /Unknown buffer type/,
    )
  })

  it('accepts only the top frame of an internal page (SECURITY.org)', () => {
    expect(isInternalSender({ url: 'file:///app/out/renderer/index.html', parent: null })).toBe(
      true,
    )
    expect(isInternalSender({ url: 'file:///app/out/renderer/index.html', parent: {} })).toBe(false)
    expect(isInternalSender({ url: 'https://example.com/', parent: null })).toBe(false)
    expect(isInternalSender(null)).toBe(false)
    expect(
      isInternalSender(
        { url: 'http://localhost:5173/index.html', parent: null },
        'http://localhost:5173',
      ),
    ).toBe(true)
  })
})
