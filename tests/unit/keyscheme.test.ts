import { describe, expect, it, vi } from 'vitest'
import type { KeyPress } from '../../src/shared/keys'
import {
  assertBindingsAreRegistered,
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
  resolveCockpitDeps,
} from '../../src/main/commands/keyscheme'

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
    // The help keys, Emacs 28's (#65).
    expect(GLOBAL_KEYMAP.commandFor('C-h x')).toBe('describe-command')
    expect(GLOBAL_KEYMAP.commandFor('C-h k')).toBe('describe-key')
    // Search across transcripts (#69), on the free C-x s.
    expect(GLOBAL_KEYMAP.commandFor('C-x s')).toBe('search-transcripts')
    // The guide's context keys (#80).
    expect(GLOBAL_KEYMAP.commandFor('C-c C-l')).toBe('clear')
    expect(GLOBAL_KEYMAP.commandFor('C-c C-k')).toBe('compact')
    // A diff buffer's file opens on the Org key for a link (#68).
    expect(BUFFER_KEYMAPS.diff?.commandFor('C-c C-o')).toBe('open-diff-file')
    expect(GLOBAL_KEYMAP.commandFor('C-c C-o')).toBeUndefined()
  })

  it('registers every command a keymap names', () => {
    const registry = createCockpitRegistry()
    expect(registry.list()).toHaveLength(
      cockpitCommands(resolveCockpitDeps(), new CommandRegistry()).length,
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

  it('reads the next sequence for describe-key instead of running it (#65)', async () => {
    const deps = resolveCockpitDeps()
    const dispatcher = createCockpitDispatcher(deps)
    const shown = vi.fn()
    deps.help.on(shown)
    // The command that asked is answered with a capture, so the renderer
    // hands every key over until the sequence ends.
    expect(await dispatcher.handle(press('h', { ctrlKey: true, code: 'KeyH' }))).toEqual({
      status: 'pending',
      chord: 'C-h',
    })
    expect(await dispatcher.handle(press('k', { code: 'KeyK' }))).toEqual({
      status: 'command',
      chord: 'C-h k',
      command: 'describe-key',
      capture: true,
    })
    expect(await dispatcher.handle(press('x', { ctrlKey: true, code: 'KeyX' }))).toEqual({
      status: 'pending',
      chord: 'C-x',
    })
    expect(await dispatcher.handle(press('b', { code: 'KeyB' }))).toEqual({
      status: 'captured',
      chord: 'C-x b',
      command: 'switch-buffer',
    })
    await vi.waitFor(() => expect(shown).toHaveBeenCalled())
    expect(shown.mock.calls[0]?.[0]).toMatchObject({
      text: 'C-x b runs switch-buffer.\nSwitch to the next buffer.',
    })
    // Nothing ran: the log has only the key that asked, and the buffer did not switch.
    expect(dispatcher.log.map((record) => record.command)).toEqual(['describe-key'])
    expect(deps.buffers.current?.kind).toBe('help')

    // An unbound sequence is read too, with no command.
    const reading = deps.keys.read()
    expect(await dispatcher.handle(press('q', { code: 'KeyQ', bufferType: 'transcript' }))).toEqual(
      { status: 'captured', chord: 'q' },
    )
    expect(await reading).toEqual({ chord: 'q', command: null, bufferType: 'transcript' })
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
})

// The guide's context commands (#80): clear is a fresh session, correct
// counts toward the nudge, side-question reads free text and answers in the
// help buffer without a trace in the session's stream.
describe('the context commands (#80)', () => {
  it('clear drops the session, correct counts, side-question answers in the help buffer', async () => {
    const deps = resolveCockpitDeps()
    const registry = createCockpitRegistry(deps)
    const events: string[] = []
    deps.agent.on((event) => events.push(event.type))
    const turn = new Promise<void>((resolve) => {
      const off = deps.agent.on((event) => {
        if (event.type === 'turn-end') {
          off()
          resolve()
        }
      })
    })
    await deps.agent.send('one')
    await turn
    expect(deps.agent.sessionId).toBe('mock-session')

    await registry.run('correct', { source: 'test' })
    await registry.run('correct', { source: 'test' })
    expect(events.at(-1)).toBe('nudge')

    const shown = vi.fn()
    deps.help.on(shown)
    await registry.run('side-question', { source: 'test' })
    const read = deps.prompter.pending
    expect(read).toMatchObject({ prompt: 'Side question:', freeText: true, candidates: [] })
    if (read === null) throw new Error('No read')
    const seen = events.length
    await deps.prompter.answer({ id: read.id, choice: null, text: ' what is two ' })
    expect(shown.mock.calls.map((call) => (call[0] as { text: string }).text)).toEqual([
      'Side question: what is two\n\nAsking...',
      'Side question: what is two\n\nYou said: what is two\n\nThis answer is not in the session history.',
    ])
    expect(events).toHaveLength(seen)
    expect(deps.buffers.current?.kind).toBe('help')

    await registry.run('clear', { source: 'test' })
    await vi.waitFor(() => expect(events.slice(-2)).toEqual(['stopped', 'notice']))
    expect(deps.agent.sessionId).toBeNull()
    expect(registry.get('compact')?.doc).toMatch(/prompt buffer is the instruction/)
    await deps.agent.stop()
  })
})
