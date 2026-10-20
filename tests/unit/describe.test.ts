import { describe, expect, it, vi } from 'vitest'
import { HelpBuffers } from '../../src/main/help'
import { bindingsText, describeCommand, describeKey } from '../../src/main/commands/describe'
import {
  cockpitKeymapLayers,
  createCockpitRegistry,
  resolveCockpitDeps,
} from '../../src/main/commands/keyscheme'

describe('describe-command and describe-key (#65)', () => {
  const registry = createCockpitRegistry()
  const layers = cockpitKeymapLayers()

  it('shows the doc line and every key that runs the command', () => {
    expect(describeCommand(registry, layers, 'describe-command')).toBe(
      [
        'describe-command',
        'Show what a command does and the keys that run it.',
        'It is bound to C-h x.',
      ].join('\n'),
    )
    expect(describeCommand(registry, layers, 'answer-yes')).toContain(
      'It is bound to y in permission buffers.',
    )
    expect(describeCommand(registry, layers, 'choose-buffer')).toContain(
      'It is not bound to any key; run it from M-x.',
    )
    expect(describeCommand(registry, layers, 'ghost')).toBe('There is no command named ghost.')
  })

  it('says what a key sequence runs, or that it is unbound', () => {
    expect(
      describeKey(registry, { chord: 'C-x b', command: 'switch-buffer', bufferType: null }),
    ).toBe('C-x b runs switch-buffer.\nSwitch to the next buffer.')
    expect(describeKey(registry, { chord: 'q', command: null, bufferType: 'transcript' })).toBe(
      'q is not bound in a transcript buffer.',
    )
  })
})

describe('the help buffer', () => {
  it('is one buffer, reused while it lives and recreated after a kill', () => {
    const deps = resolveCockpitDeps()
    const help = new HelpBuffers(deps.buffers)
    const shown = vi.fn()
    help.on(shown)

    const first = help.show('one')
    expect(first).toMatchObject({ kind: 'help', title: 'Help', elementId: 'help' })
    expect(deps.buffers.current?.id).toBe(first.id)
    expect(shown).toHaveBeenLastCalledWith({ bufferId: first.id, text: 'one' })

    deps.buffers.switchToNext()
    expect(help.show('two').id).toBe(first.id)
    expect(deps.buffers.current?.id).toBe(first.id)
    expect(deps.buffers.list().filter((buffer) => buffer.kind === 'help')).toHaveLength(1)

    deps.buffers.kill(first.id)
    expect(help.buffer).toBeNull()
    const third = help.show('three')
    expect(third.id).not.toBe(first.id)
    expect(shown).toHaveBeenLastCalledWith({ bufferId: third.id, text: 'three' })
  })
})

describe('describe-bindings', () => {
  it('lists the global bindings, then the buffer layer', () => {
    const registry = createCockpitRegistry()
    const text = bindingsText(cockpitKeymapLayers(), registry, 'permission')
    expect(text).toContain('C-x b  switch-buffer  Switch to the next buffer.')
    expect(text).toContain('permission bindings')
    expect(text.indexOf('C-x b  switch-buffer')).toBeLessThan(text.indexOf('permission bindings'))
    expect(text.indexOf('permission bindings')).toBeLessThan(text.indexOf('y  answer-yes'))
    expect(text).not.toContain('transcript bindings')
  })
})
