import { describe, expect, it, vi } from 'vitest'
import type { KeyPress } from '../../src/shared/keys'
import {
  assertBindingsAreRegistered,
  KeyDispatcher,
  parseKeyPress,
} from '../../src/main/commands/dispatcher'
import { defineKeymap, KeyResolver } from '../../src/main/commands/keymap'
import { CommandRegistry, defineCommand } from '../../src/main/commands/registry'
import type { AgentEvent, PermissionHandler } from '../../src/main/agent/events'
import { mockDriver } from '../../src/main/agent/mock'
import { SessionManager } from '../../src/main/agent/session-manager'
import { CONFIRM_SOURCES } from '../../src/main/commands/confirm'
import { Prompter } from '../../src/main/commands/prompter'
import {
  BUFFER_KEYMAPS,
  cockpitCommands,
  createCockpitDispatcher,
  createCockpitRegistry,
  createCockpitResolver,
  GLOBAL_KEYMAP,
  MODE_KEYMAPS,
  resolveCockpitDeps,
} from '../../src/main/commands/keyscheme'
import { parseStroke } from '../../src/main/commands/keymap'

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
    // Plan mode as a key, and the plan buffer's approve and reject over the
    // global send and compact (#82).
    expect(GLOBAL_KEYMAP.commandFor('C-c C-p')).toBe('toggle-plan-mode')
    expect(BUFFER_KEYMAPS.plan?.commandFor('C-c C-c')).toBe('approve-plan')
    expect(BUFFER_KEYMAPS.plan?.commandFor('C-c C-k')).toBe('reject-plan')
    // The spec buffer's one action over the global send (#85); the three
    // guideline commands are M-x only.
    expect(BUFFER_KEYMAPS.spec?.commandFor('C-c C-c')).toBe('start-fresh-session-from-spec')
    for (const name of ['interview', 'investigate', 'ask-codebase']) {
      expect(GLOBAL_KEYMAP.entries().some((entry) => entry.command === name)).toBe(false)
    }
    // The verify key (#81); attach-issue, attach-check and screenshot-window are M-x only.
    expect(GLOBAL_KEYMAP.commandFor('C-c C-v')).toBe('verify')
    for (const name of ['attach-issue', 'attach-check', 'screenshot-window']) {
      expect(GLOBAL_KEYMAP.entries().some((entry) => entry.command === name)).toBe(false)
    }
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

describe('the page layer and its modes (#120)', () => {
  const DOCUMENT = ['document']
  const PASSTHROUGH = ['passthrough', 'document']

  /** What one chord means in a page buffer in these modes, from a fresh resolver. */
  function inPage(chord: string, modes: readonly string[] = DOCUMENT): string | null {
    const keys = createCockpitResolver()
    let last = null as ReturnType<typeof keys.resolve> | null
    for (const token of chord.split(' ')) last = keys.resolve(parseStroke(token), 'page', modes)
    return last?.kind === 'command' ? last.command : (last?.kind ?? null)
  }

  it('resolves the chords document mode lists, and keeps the cockpit chords', () => {
    expect(inPage('C-v')).toBe('scroll-page-down')
    expect(inPage('M-v')).toBe('scroll-page-up')
    expect(inPage('C-n')).toBe('scroll-line-down')
    expect(inPage('C-p')).toBe('scroll-line-up')
    expect(inPage('<')).toBe('scroll-to-top')
    expect(inPage('>')).toBe('scroll-to-bottom')
    expect(inPage('C-s')).toBe('find-in-page')
    expect(inPage('C-+')).toBe('zoom-in')
    expect(inPage('C--')).toBe('zoom-out')
    expect(inPage('M-w')).toBe('copy-page-selection')
    expect(inPage('g')).toBe('reload-page')
    expect(inPage('C-z')).toBe('toggle-passthrough')
    expect(inPage('C-x C-f')).toBe('open-url')
    expect(inPage('C-x 4 C-f')).toBe('open-url-in-new-buffer')
    // The cockpit's own chords keep their meaning in a page.
    expect(inPage('C-x b')).toBe('switch-buffer')
    expect(inPage('C-x k')).toBe('kill-buffer')
    expect(inPage('M-x')).toBe('execute-command')
    expect(inPage('C-c C-c')).toBe('send-prompt')
    expect(inPage('C-g')).toBe('keyboard-quit')
    // ...and C-s everywhere else is still the buffer search.
    expect(GLOBAL_KEYMAP.commandFor('C-s')).toBe('search-buffer')
  })

  it('leaves an unbound printable key to the page', () => {
    for (const key of ['a', 'q', 'G', '1', ' ']) {
      const dispatcher = createCockpitDispatcher()
      const taken = dispatcher.take(press(key, { bufferType: 'page' }), DOCUMENT)
      expect(taken.consumed).toBe(false)
    }
    expect(inPage('a')).toBe('unbound')
  })

  it('consumes a bound chord and every stroke of a sequence it holds', () => {
    const dispatcher = createCockpitDispatcher()
    const page = { bufferType: 'page' as const }
    expect(
      dispatcher.take(press('x', { ...page, ctrlKey: true, code: 'KeyX' }), DOCUMENT).consumed,
    ).toBe(true)
    // C-x q is no binding, but the q was typed into the cockpit's sequence.
    expect(dispatcher.take(press('q', { ...page, code: 'KeyQ' }), DOCUMENT).consumed).toBe(true)
    expect(dispatcher.take(press('q', { ...page, code: 'KeyQ' }), DOCUMENT).consumed).toBe(false)
    expect(dispatcher.take(press('Control', page), DOCUMENT).consumed).toBe(false)
  })

  it('passthrough forwards everything but C-z, C-g and the cockpit chords included', () => {
    expect(inPage('C-z', PASSTHROUGH)).toBe('toggle-passthrough')
    for (const chord of ['C-v', 'C-s', 'C-g', 'C-x', 'C-c', 'M-x', 'g', '<', 'a']) {
      expect(inPage(chord, PASSTHROUGH)).toBe('unbound')
    }
    const dispatcher = createCockpitDispatcher()
    const page = { bufferType: 'page' as const }
    expect(
      dispatcher.take(press('x', { ...page, ctrlKey: true, code: 'KeyX' }), PASSTHROUGH).consumed,
    ).toBe(false)
    expect(
      dispatcher.take(press('g', { ...page, ctrlKey: true, code: 'KeyG' }), PASSTHROUGH).consumed,
    ).toBe(false)
    expect(
      dispatcher.take(press('z', { ...page, ctrlKey: true, code: 'KeyZ' }), PASSTHROUGH).consumed,
    ).toBe(true)
  })

  it('keeps passthrough to its exit chord, and every mode command registered', () => {
    expect(MODE_KEYMAPS['passthrough']?.keymap.entries()).toEqual([
      { chord: 'C-z', command: 'toggle-passthrough' },
    ])
    expect(MODE_KEYMAPS['passthrough']?.sealed).toBe(true)
    const registry = createCockpitRegistry()
    for (const mode of Object.values(MODE_KEYMAPS)) {
      for (const { command } of mode.keymap.entries()) expect(registry.has(command)).toBe(true)
    }
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

// The rewind command of #84 with the preview and the question of #99: the
// SDK's dry run fills the help buffer, the prompt buffer asks with the no
// highlighted, and only a yes runs the real rewind.
describe('the rewind command previews and asks (#99)', () => {
  function harness() {
    const prompter = new Prompter()
    for (const source of CONFIRM_SOURCES) prompter.addSource(source)
    const allow: PermissionHandler = {
      requestPermission: () => Promise.resolve({ behavior: 'allow' }),
    }
    const agent = new SessionManager({
      cwd: '/tmp/nemesis-unit',
      model: null,
      permissionHandler: allow,
      driver: mockDriver(),
    })
    const deps = resolveCockpitDeps({ prompter, agent })
    const registry = createCockpitRegistry(deps)
    const notices: string[] = []
    agent.on((event: AgentEvent) => {
      if (event.type === 'notice') notices.push(event.text)
    })
    const shown: string[] = []
    deps.help.on((content) => shown.push(content.text))
    return { deps, prompter, agent, registry, notices, shown }
  }

  async function sendAndWait(agent: SessionManager, text: string): Promise<void> {
    const turn = new Promise<void>((resolve) => {
      const off = agent.on((event) => {
        if (event.type === 'turn-end') {
          off()
          resolve()
        }
      })
    })
    await agent.send(text)
    await turn
  }

  /**
   * Runs rewind, picks checkpoint 2 and the target, and hands back the answer
   * in flight, boxed: an async function returning the promise itself would
   * await it, and it resolves only once the question is answered.
   */
  async function startRewind(
    h: ReturnType<typeof harness>,
    target: string,
  ): Promise<{ flow: Promise<unknown> }> {
    await h.registry.run('rewind', { source: 'test' })
    const list = h.prompter.pending
    expect(list).toMatchObject({ prompt: 'Rewind to:' })
    if (list === null) throw new Error('No checkpoint read')
    const second = h.agent.checkpoints()[1]
    if (second === undefined) throw new Error('No second checkpoint')
    await h.prompter.answer({ id: list.id, choice: second.uuid })
    const targets = h.prompter.pending
    expect(targets).toMatchObject({ prompt: 'Restore:' })
    if (targets === null) throw new Error('No target read')
    // The answer resolves only when the flow behind it ends, after the question.
    const flow = h.prompter.answer({ id: targets.id, choice: target })
    await vi.waitFor(() => expect(h.prompter.pending?.source).toBe('rewind'))
    return { flow }
  }

  it('shows the files, asks with the no first, and restores only after a yes', async () => {
    const h = harness()
    await sendAndWait(h.agent, 'one')
    await sendAndWait(h.agent, 'edit: beta changed')

    let { flow } = await startRewind(h, 'code')
    const question = h.prompter.pending
    expect(question).toMatchObject({ prompt: 'Restore 1 file to checkpoint 2?' })
    expect(question?.candidates.map((c) => c.label)).toEqual(['Do not restore', 'Restore'])
    expect(h.shown.at(-1)).toBe(
      [
        'Rewind to checkpoint 2: the files that would change.',
        '',
        '  /mock/notes.txt',
        '',
        '1 file, 1 insertion, 1 deletion.',
      ].join('\n'),
    )
    if (question === null) throw new Error('No question')
    await h.prompter.answer({ id: question.id, choice: 'no' })
    await flow
    expect(h.notices).toEqual(['Rewind: checkpoint 2 left as is, nothing restored.'])

    // The no left the file: the next preview lists it again, and for both
    // targets the buffer says what the conversation loses too.
    flow = (await startRewind(h, 'both')).flow
    const again = h.prompter.pending
    expect(again).toMatchObject({ prompt: 'Restore 1 file to checkpoint 2?' })
    expect(h.shown.at(-1)).toContain('  /mock/notes.txt\n')
    expect(h.shown.at(-1)).toContain(
      'The conversation goes back to before the checkpoint as well: 1 turn dropped.',
    )
    if (again === null) throw new Error('No question')
    await h.prompter.answer({ id: again.id, choice: 'yes' })
    await flow
    expect(h.notices.slice(1)).toEqual([
      'Rewind: files restored to checkpoint 2, 1 file changed.',
      'Rewind: conversation restored to before checkpoint 2; 1 checkpoint kept.',
    ])
    expect(h.agent.checkpoints().map((c) => c.index)).toEqual([1])
    await h.agent.stop()
  })

  it('asks one question for a conversation-only rewind, with the turns dropped', async () => {
    const h = harness()
    for (const text of ['one', 'two', 'three']) await sendAndWait(h.agent, text)
    const { flow } = await startRewind(h, 'conversation')
    const question = h.prompter.pending
    expect(question).toMatchObject({
      prompt: 'Restore the conversation to before checkpoint 2, dropping 2 turns?',
    })
    // No dry run was shown: the help buffer still holds the checkpoint list.
    expect(h.shown).toHaveLength(1)
    expect(h.shown[0]).toContain('Checkpoints, one per prompt sent')
    if (question === null) throw new Error('No question')
    await h.prompter.answer({ id: question.id, choice: 'no' })
    await flow
    expect(h.notices).toEqual(['Rewind: checkpoint 2 left as is, nothing restored.'])
    expect(h.agent.checkpoints().map((c) => c.index)).toEqual([1, 2, 3])
    await h.agent.stop()
  })
})

// Naming a session (#104): a free-text read, one event down the stream, on a
// chord that was free; a name with nothing printable is refused in the help
// buffer, since the palette has closed by the time it is known.
describe('name-session (#104)', () => {
  it('reads a name as free text and records it as an event; blanks are refused', async () => {
    const deps = resolveCockpitDeps()
    const registry = createCockpitRegistry(deps)
    const events: AgentEvent[] = []
    deps.agent.on((event) => events.push(event))
    expect(GLOBAL_KEYMAP.commandFor('C-c C-n')).toBe('name-session')

    await registry.run('name-session', { source: 'test' })
    const read = deps.prompter.pending
    expect(read).toMatchObject({ prompt: 'Name session:', freeText: true, candidates: [] })
    if (read === null) throw new Error('No read')
    await deps.prompter.answer({ id: read.id, choice: null, text: '  nemesis   security\nreview ' })
    expect(events).toEqual([{ type: 'named', name: 'nemesis security review' }])

    const shown = vi.fn()
    deps.help.on(shown)
    await registry.run('name-session', { source: 'test' })
    const again = deps.prompter.pending
    if (again === null) throw new Error('No read')
    await deps.prompter.answer({ id: again.id, choice: null, text: '\u0007' })
    expect(events).toHaveLength(1)
    expect(shown).toHaveBeenCalledTimes(1)
    expect((shown.mock.calls[0]?.[0] as { text: string }).text).toMatch(/not named/)
  })
})
