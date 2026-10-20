import { describe, expect, it, vi } from 'vitest'
import { HelpBuffers } from '../../src/main/help'
import {
  bindingsText,
  describeAnyCandidates,
  describeBinding,
  describeCommand,
  describeHook,
  describeKey,
  describeMode,
  describeSetting,
  parseDescribeAnyId,
  type Binding,
} from '../../src/main/commands/describe'
import {
  cockpitKeymapLayers,
  cockpitModes,
  createCockpitRegistry,
  GLOBAL_KEYMAP,
  resolveCockpitDeps,
} from '../../src/main/commands/keyscheme'
import { HOOK_POINTS, HookRegistry } from '../../src/main/hooks'
import { defaultSettings, parseSettings, SETTING_DOCS } from '../../src/main/settings'

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

describe('describe-setting, describe-mode, describe-hook and describe-any (#171)', () => {
  const defaults = defaultSettings('/docs')
  const settings = { current: () => ({ ...defaults, theme: 'dark' as const }), defaults }

  it('has a non-empty doc and type for every key of the settings, and none the parser refuses', () => {
    expect(Object.keys(SETTING_DOCS).sort()).toEqual(Object.keys(defaults).sort())
    for (const [key, { doc, type }] of Object.entries(SETTING_DOCS)) {
      expect(doc.trim(), key).not.toBe('')
      expect(type.trim(), key).not.toBe('')
      // A documented key the parser does not know would throw "Unknown setting".
      expect(() =>
        parseSettings({ [key]: defaults[key as keyof typeof defaults] }, defaults),
      ).not.toThrow()
    }
  })

  it('shows a setting with its doc, type, default and value in force', () => {
    expect(describeSetting(settings, 'theme')).toBe(
      [
        'theme',
        SETTING_DOCS.theme.doc,
        `Type: ${SETTING_DOCS.theme.type}`,
        'Default: "system"',
        'Current: "dark"',
      ].join('\n'),
    )
    expect(describeSetting(settings, 'notify')).toContain('Current: null')
    expect(describeSetting(settings, 'ghost')).toBe('There is no setting named ghost.')
    expect(describeSetting(settings, 'toString')).toBe('There is no setting named toString.')
  })

  it('shows a mode with its doc, the buffers it applies to and its toggler', () => {
    const mode = cockpitModes
      .list()
      .find((candidate) => candidate.toggler !== false && candidate.name !== 'base')
    if (mode === undefined) throw new Error('no togglable mode')
    const text = describeMode(cockpitModes, cockpitKeymapLayers(), mode.name)
    expect(text.split('\n').slice(0, 2)).toEqual([`${mode.name} mode`, mode.doc])
    expect(text).toContain('turns it on and off.')
    expect(describeMode(cockpitModes, cockpitKeymapLayers(), 'ghost')).toBe(
      'There is no mode named ghost.',
    )
  })

  it('shows a hook point with its kind and every handler on it', () => {
    const hooks = new HookRegistry(() => undefined)
    hooks.on(
      'before-command',
      { name: 'audit', doc: 'Log the command name.', run: () => {} },
      'config',
    )
    const text = describeHook(hooks.list(), 'before-command')
    expect(text).toContain('It is an interceptor point; each handler has 30000 ms.')
    expect(text).toContain('  audit (config): Log the command name.')
    expect(describeHook([], 'after-init')).toContain('No handler is registered.')
    expect(describeHook([], 'ghost')).toBe('There is no hook point named ghost.')
  })

  it('lists one candidate of each kind, tagged, and each opens its describe', () => {
    const registry = createCockpitRegistry()
    const candidates = describeAnyCandidates(registry, cockpitKeymapLayers(), cockpitModes)
    const kinds = new Set(candidates.map((candidate) => candidate.detail))
    expect([...kinds].sort()).toEqual(['command', 'hook', 'key', 'mode', 'setting'])
    expect(candidates.filter((c) => c.detail === 'setting')).toHaveLength(
      Object.keys(SETTING_DOCS).length,
    )
    expect(candidates.filter((c) => c.detail === 'hook')).toHaveLength(
      Object.keys(HOOK_POINTS).length,
    )
    for (const candidate of candidates) {
      const parsed = parseDescribeAnyId(candidate.id)
      expect(parsed?.kind, candidate.id).toBe(candidate.detail)
    }
    const key = candidates.find((c) => c.detail === 'key' && c.label === 'C-h a')
    const binding = parseDescribeAnyId(key?.id ?? '')
    if (binding === null) throw new Error('no C-h a candidate')
    expect(describeBinding(registry, JSON.parse(binding.name) as Binding)).toBe(
      'C-h a runs describe-any.\nDescribe a command, setting, mode, hook point or key binding, read from one list.',
    )
    expect(parseDescribeAnyId('nothing')).toBeNull()
  })

  it('binds describe-any to C-h a and opens the help buffer from the palette', async () => {
    expect(GLOBAL_KEYMAP.entries()).toContainEqual({ chord: 'C-h a', command: 'describe-any' })
    const deps = resolveCockpitDeps({ settings })
    const registry = createCockpitRegistry(deps)
    const shown = vi.fn()
    deps.help.on(shown)
    await registry.run('describe-any', { source: 'test' })
    const read = deps.prompter.pending
    expect(read?.source).toBe('describe-any')
    await deps.prompter.answer({ id: read?.id ?? '', choice: 'setting:theme' })
    expect(shown).toHaveBeenLastCalledWith(
      expect.objectContaining({ text: expect.stringContaining('Current: "dark"') }),
    )
  })
})
