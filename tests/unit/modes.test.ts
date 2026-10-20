import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BufferRegistry } from '../../src/main/buffers'
import {
  cockpitKeymapLayers,
  COCKPIT_MODES,
  createCockpitResolver,
  createModeRegistry,
} from '../../src/main/commands/keyscheme'
import { bindingNote, describeCommand } from '../../src/main/commands/describe'
import { parseStroke } from '../../src/main/commands/keymap'
import {
  BASE_MODE,
  BufferModes,
  DEFAULT_MODES,
  defineMode,
  modeCommands,
  ModeError,
  ModeRegistry,
  modeSources,
} from '../../src/main/commands/modes'
import { Prompter } from '../../src/main/commands/prompter'
import { CommandRegistry, defineCommand } from '../../src/main/commands/registry'
import { CONFIG_FILE, ConfigLoader, type ConfigTarget } from '../../src/main/config/loader'
import { HookRegistry, type HookHandler, type HookPoint } from '../../src/main/hooks'
import { defaultSettings } from '../../src/main/settings'

// ADR 0004 (#166): a mode is a registered definition, on in a buffer by
// membership in its list, first wins; its hooks go on with it and off with
// it; and nothing a page or the renderer sends can switch one.

const root = join(import.meta.dirname, '../..')

function handler(name: string, run: HookHandler<HookPoint>['run'] = () => undefined) {
  return { name, doc: `The ${name} handler.`, run }
}

function rig(registry: ModeRegistry = new ModeRegistry()) {
  const notices: string[] = []
  const hooks = new HookRegistry((text) => notices.push(text))
  registry.useHooks(hooks)
  const buffers = new BufferRegistry()
  const modes = new BufferModes(registry, buffers, (text) => notices.push(text))
  return { registry, hooks, buffers, modes, notices }
}

describe('defineMode and the registry', () => {
  it('refuses a duplicate name, a bad name, a missing doc and a reserved name', () => {
    const registry = new ModeRegistry(new Set(['passthrough']))
    registry.register(defineMode({ name: 'focus', doc: 'Focus.' }))
    expect(() => registry.register(defineMode({ name: 'focus', doc: 'Again.' }))).toThrow(ModeError)
    expect(() => registry.register(defineMode({ name: 'focus', doc: 'Again.' }))).toThrow(
      /already defined/,
    )
    expect(() => defineMode({ name: 'Focus', doc: 'Focus.' })).toThrow(/kebab-case/)
    expect(() => defineMode({ name: 'focus', doc: ' ' })).toThrow(/doc line/)
    expect(() => registry.register(defineMode({ name: 'passthrough', doc: 'No.' }))).toThrow(
      /page buffer's own/,
    )
  })

  it('builds the keymap once, so a bad chord fails at definition', () => {
    expect(() =>
      defineMode({ name: 'bad', doc: 'Bad.', keymap: { 'C-x': 'a', 'C-x b': 'b' } }),
    ).toThrow(/can never run/)
  })

  it('holds base and the four buffer keymaps as the cockpit modes, each its kind default', () => {
    const registry = createModeRegistry()
    expect(registry.list().map((mode) => mode.name)).toEqual([
      BASE_MODE,
      'permission',
      'diff',
      'plan',
      'spec',
    ])
    expect(DEFAULT_MODES).toEqual({
      permission: ['permission'],
      diff: ['diff'],
      plan: ['plan'],
      spec: ['spec'],
    })
    expect(registry.get('permission')?.modal).toBe(true)
    expect(registry.get(BASE_MODE)?.visible).toBe(false)
    // None of the five registers a toggle: base is under everything, the four are their kinds' own.
    expect(COCKPIT_MODES.every((mode) => mode.toggler === false)).toBe(true)
  })
})

describe('a buffer and its modes', () => {
  it('starts a buffer of a kind in its default modes', () => {
    const { buffers, modes } = rig(createModeRegistry())
    const plan = buffers.create({ kind: 'plan', title: 'Plan' })
    expect(plan.modes).toEqual(['plan'])
    expect(modes.state(plan.id, 'plan')).toMatchObject({ mode: 'plan', bufferId: plan.id })
    expect(buffers.create({ kind: 'prompt', title: 'Prompt' }).modes).toBeUndefined()
  })

  it('puts a mode enabled at runtime first, and resolves its keys before the kind default', async () => {
    const registry = createModeRegistry()
    registry.register(
      defineMode({ name: 'focus', doc: 'Focus.', keymap: { 'C-c C-c': 'next-turn' } }),
    )
    const { buffers, modes } = rig(registry)
    const plan = buffers.create({ kind: 'plan', title: 'Plan' })
    await modes.enableMode(plan.id, 'focus')
    expect(buffers.get(plan.id)?.modes).toEqual(['focus', 'plan'])

    const keys = createCockpitResolver(registry)
    const resolve = (chord: string, list: readonly string[]) => {
      let last = null
      for (const token of chord.split(' ')) last = keys.resolve(parseStroke(token), 'plan', list)
      return last
    }
    expect(resolve('C-c C-c', ['focus', 'plan'])).toMatchObject({ command: 'next-turn' })
    expect(resolve('C-c C-c', ['plan'])).toMatchObject({ command: 'approve-plan' })
    // A key no mode binds falls to base.
    expect(resolve('C-c C-k', ['focus', 'plan'])).toMatchObject({ command: 'reject-plan' })
    expect(resolve('C-x b', ['focus', 'plan'])).toMatchObject({ command: 'switch-buffer' })
    // Off: the kind default answers again.
    await modes.disableMode(plan.id, 'focus')
    expect(buffers.get(plan.id)?.modes).toEqual(['plan'])
    expect(resolve('C-c C-c', buffers.get(plan.id)?.modes ?? [])).toMatchObject({
      command: 'approve-plan',
    })
  })

  it('makes enable and disable no-ops when already on or off, and passes settings to the state', async () => {
    const registry = new ModeRegistry()
    const seen: unknown[] = []
    registry.register(
      defineMode({
        name: 'focus',
        doc: 'Focus.',
        settings: { dim: true, width: 80 },
        enable: (_buffer, state) => {
          seen.push(['on', state.settings])
        },
        disable: () => {
          seen.push(['off'])
        },
      }),
    )
    const { buffers, modes } = rig(registry)
    const id = buffers.current?.id ?? buffers.create({ kind: 'prompt', title: 'Prompt' }).id
    await modes.enableMode(id, 'focus', { width: 100 })
    await modes.enableMode(id, 'focus')
    expect(modes.state(id, 'focus')?.settings).toEqual({ dim: true, width: 100 })
    await modes.disableMode(id, 'focus')
    await modes.disableMode(id, 'focus')
    expect(seen).toEqual([['on', { dim: true, width: 100 }], ['off']])
    expect(modes.state(id, 'focus')).toBeUndefined()
  })

  it('refuses an unknown mode, base, a kind the mode is not for, and a page buffer', async () => {
    const { buffers, modes } = rig(createModeRegistry())
    const prompt = buffers.create({ kind: 'prompt', title: 'Prompt' })
    await expect(modes.enableMode(prompt.id, 'ghost')).rejects.toThrow(/No mode named "ghost"/)
    await expect(modes.enableMode(prompt.id, BASE_MODE)).rejects.toThrow(/No mode named/)
    await expect(modes.enableMode(prompt.id, 'plan')).rejects.toThrow(/for plan buffers/)
    const page = buffers.create({ kind: 'page', title: 'Page' })
    await expect(modes.enableMode(page.id, 'focus')).rejects.toThrow(/page buffer/)
  })

  it('drops the mode when enable throws, so nothing is half on', async () => {
    const registry = new ModeRegistry()
    registry.register(
      defineMode({
        name: 'broken',
        doc: 'Broken.',
        hooks: [{ point: 'buffer-created', handler: handler('broken-created') }],
        enable: () => {
          throw new Error('no')
        },
      }),
    )
    const { buffers, modes, hooks } = rig(registry)
    const prompt = buffers.create({ kind: 'prompt', title: 'Prompt' })
    await expect(modes.enableMode(prompt.id, 'broken')).rejects.toThrow('no')
    expect(buffers.get(prompt.id)?.modes).toBeUndefined()
    expect(hooks.list()).toEqual([])
  })
})

describe("a mode's hooks (ADR 0005 through #165)", () => {
  function hooked() {
    const registry = new ModeRegistry()
    registry.register(
      defineMode({
        name: 'focus',
        doc: 'Focus.',
        hooks: [
          { point: 'buffer-created', handler: handler('focus-created') },
          { point: 'after-command', handler: handler('focus-ran') },
        ],
      }),
    )
    return rig(registry)
  }

  it('registers them with the source mode:<name> on enable and drops them on disable', async () => {
    const { buffers, modes, hooks } = hooked()
    const prompt = buffers.create({ kind: 'prompt', title: 'Prompt' })
    expect(hooks.list()).toEqual([])
    await modes.enableMode(prompt.id, 'focus')
    expect(hooks.list().map((entry) => [entry.point, entry.name, entry.source])).toEqual([
      ['buffer-created', 'focus-created', 'mode:focus'],
      ['after-command', 'focus-ran', 'mode:focus'],
    ])
    await modes.disableMode(prompt.id, 'focus')
    expect(hooks.list()).toEqual([])
  })

  it('keeps them while any buffer has the mode on, and drops them with the last', async () => {
    const { buffers, modes, hooks } = hooked()
    const one = buffers.create({ kind: 'prompt', title: 'One' })
    const two = buffers.create({ kind: 'transcript', title: 'Two' })
    await modes.enableMode(one.id, 'focus')
    await modes.enableMode(two.id, 'focus')
    expect(hooks.list()).toHaveLength(2)
    await modes.toggleMode(one.id, 'focus')
    expect(hooks.list()).toHaveLength(2)
    // Killing the other buffer turns its modes off too.
    buffers.kill(two.id)
    expect(hooks.list()).toEqual([])
  })

  it('drops them when the window goes', async () => {
    const { buffers, modes, hooks } = hooked()
    const prompt = buffers.create({ kind: 'prompt', title: 'Prompt' })
    await modes.enableMode(prompt.id, 'focus')
    modes.dispose()
    expect(hooks.list()).toEqual([])
  })
})

describe('the mode commands', () => {
  function commands() {
    const registry = createModeRegistry()
    const focus = defineMode({ name: 'focus', doc: 'Focus.' })
    registry.register(focus)
    const r = rig(registry)
    const prompter = new Prompter()
    for (const source of modeSources(r.modes)) prompter.addSource(source)
    const table = new CommandRegistry()
    table.registerAll(modeCommands(r.modes, prompter, [focus, ...COCKPIT_MODES]))
    const prompt = r.buffers.create({ kind: 'prompt', title: 'Prompt' })
    r.buffers.switchTo(prompt.id)
    return { ...r, prompter, table, prompt }
  }

  it('registers toggle-<name> for a togglable mode only, plus enable-mode and disable-mode', () => {
    const { table } = commands()
    expect(table.list().map((command) => command.name)).toEqual([
      'disable-mode',
      'enable-mode',
      'toggle-focus',
    ])
  })

  it('toggles the current buffer', async () => {
    const { table, buffers, prompt } = commands()
    await table.run('toggle-focus', { source: 'test' })
    expect(buffers.get(prompt.id)?.modes).toEqual(['focus'])
    await table.run('toggle-focus', { source: 'test' })
    expect(buffers.get(prompt.id)?.modes).toEqual([])
  })

  it('reads the mode to enable or disable through the palette, over the current buffer', async () => {
    const { table, buffers, prompter, prompt } = commands()
    const reads: { source: string; ids: string[] }[] = []
    prompter.on((request) => {
      if (request === null) return
      reads.push({ source: request.source, ids: request.candidates.map((c) => c.id) })
    })
    await table.run('enable-mode', { source: 'test' })
    // Only what may go on in a prompt buffer: not base, not the four kinds' own.
    expect(reads.at(-1)).toEqual({ source: 'modes-off', ids: ['focus'] })
    await prompter.answer({ id: 'p1', choice: 'focus' })
    expect(buffers.get(prompt.id)?.modes).toEqual(['focus'])
    await table.run('disable-mode', { source: 'test' })
    expect(reads.at(-1)).toEqual({ source: 'modes-on', ids: ['focus'] })
    await prompter.answer({ id: 'p2', choice: 'focus' })
    expect(buffers.get(prompt.id)?.modes).toEqual([])
  })

  it('names a mode layer in describe and in the palette note', () => {
    const registry = createModeRegistry()
    registry.register(defineMode({ name: 'focus', doc: 'Focus.', keymap: { n: 'next-buffer' } }))
    const layers = cockpitKeymapLayers(registry)
    expect(bindingNote(layers, 'next-buffer')).toBe('n (focus)')
    const table = new CommandRegistry()
    table.register(defineCommand({ name: 'next-buffer', doc: 'Next.', run: () => {} }))
    expect(describeCommand(table, layers, 'next-buffer')).toContain(
      'It is bound to n in focus mode.',
    )
    // The four kinds' modes still read as their buffers.
    expect(bindingNote(layers, 'answer-yes')).toBe('y (permission)')
  })
})

describe('the config door (#166)', () => {
  function harness() {
    const dir = mkdtempSync(join(tmpdir(), 'nemesis-modes-'))
    const path = join(dir, CONFIG_FILE)
    const r = rig(createModeRegistry())
    const commands = new CommandRegistry()
    commands.register(defineCommand({ name: 'next-turn', doc: 'Next.', run: () => {} }))
    const loader = new ConfigLoader({
      path,
      base: () => defaultSettings('/documents'),
      buffers: () => [],
      run: (name) => commands.run(name, { source: 'config' }),
      hooks: r.hooks,
      modes: r.registry,
      toggleMode: async (name) => {
        const current = r.buffers.current
        if (current !== null) await r.modes.toggleMode(current.id, name)
      },
    })
    const target: ConfigTarget = {
      registry: commands,
      setUserKeymap: () => {},
      applySettings: () => {},
      rebuilt: () => {},
    }
    const prompt = r.buffers.create({ kind: 'prompt', title: 'Prompt' })
    r.buffers.switchTo(prompt.id)
    return {
      ...r,
      loader,
      target,
      commands,
      prompt,
      write: (source: string) => writeFileSync(path, source, 'utf8'),
    }
  }

  const FOCUS = `nemesis.defineMode({
  name: 'focus',
  doc: 'Bind n to the next turn.',
  keymap: { n: 'next-turn' },
  modal: true,
  settings: { dim: true },
  hooks: [{ point: 'buffer-created', name: 'focus-created', doc: 'Says so.', run() {} }],
})
`

  it('defines the mode and its toggle, and a reload takes the old one off every buffer', async () => {
    const h = harness()
    h.write(FOCUS)
    expect(h.loader.reload(h.target).ok).toBe(true)
    expect(h.registry.get('focus')).toMatchObject({ modal: true, settings: { dim: true } })
    expect(h.registry.shapes()['focus']).toEqual({
      keys: { chords: ['n'], prefixes: [] },
      modal: true,
      visible: true,
    })
    await h.commands.run('toggle-focus', { source: 'test' })
    expect(h.buffers.get(h.prompt.id)?.modes).toEqual(['focus'])
    expect(h.hooks.list().map((entry) => entry.source)).toEqual(['mode:focus'])

    expect(h.loader.reload(h.target).ok).toBe(true)
    expect(h.buffers.get(h.prompt.id)?.modes).toEqual([])
    expect(h.hooks.list()).toEqual([])
    expect(h.registry.has('focus')).toBe(true)

    h.write('')
    expect(h.loader.reload(h.target).ok).toBe(true)
    expect(h.registry.has('focus')).toBe(false)
    expect(h.commands.has('toggle-focus')).toBe(false)
  })

  it('loads the Modes example of docs/config.org as written', async () => {
    const h = harness()
    for (const name of ['switch-buffer', 'search-buffer']) {
      h.commands.register(defineCommand({ name, doc: 'Cockpit.', run: () => {} }))
    }
    const doc = readFileSync(join(root, 'docs', 'config.org'), 'utf8')
    const modes = doc.slice(doc.indexOf('\n* Modes\n'))
    const example = /#\+begin_src typescript\n([\s\S]*?)#\+end_src/.exec(modes)?.[1]
    expect(example).toContain('nemesis.defineMode')
    h.write(example ?? '')
    expect(h.loader.reload(h.target).ok).toBe(true)
    await h.commands.run('toggle-focus', { source: 'test' })
    expect(h.buffers.get(h.prompt.id)?.modes).toEqual(['focus'])
    expect(h.hooks.list().map((entry) => entry.name)).toEqual(['focus-count'])
  })

  it("refuses a cockpit mode's name, and an unknown command in a mode's keymap, on the file's line", () => {
    const h = harness()
    h.write(`nemesis.defineMode({ name: 'plan', doc: 'Mine.' })\n`)
    const taken = h.loader.reload(h.target)
    expect(taken.ok).toBe(false)
    if (!taken.ok) expect(taken.problem.message).toMatch(/Mode "plan" is the cockpit's/)

    h.write(`\nnemesis.defineMode({ name: 'focus', doc: 'Focus.', keymap: { n: 'ghost' } })\n`)
    const unknown = h.loader.reload(h.target)
    expect(unknown.ok).toBe(false)
    if (!unknown.ok) {
      expect(unknown.problem.message).toMatch(/Mode "focus" binds n to unknown command "ghost"/)
      expect(unknown.problem.line).toBe(2)
    }
    expect(h.registry.has('focus')).toBe(false)
  })
})

describe('no page or IPC message switches a mode (ADR 0004, T4)', () => {
  it('has no import from the IPC layer, Electron or the preload', () => {
    const source = readFileSync(join(root, 'src/main/commands/modes.ts'), 'utf8')
    const specifiers = [...source.matchAll(/^import\s[^'"]*['"]([^'"]+)['"]/gm)].map(
      (match) => match[1] ?? '',
    )
    expect(specifiers.length).toBeGreaterThan(0)
    for (const specifier of specifiers) {
      expect(specifier).not.toMatch(/(^|\/)ipc$|electron|preload|bridge/)
    }
  })

  it('has no channel in src/shared/ that carries a mode switch', () => {
    const dir = join(root, 'src/shared')
    for (const file of readdirSync(dir).filter((name) => name.endsWith('.ts'))) {
      const source = readFileSync(join(dir, file), 'utf8')
      for (const match of source.matchAll(/CHANNEL\s*=\s*['"]([^'"]+)['"]/g)) {
        expect(match[1], file).not.toMatch(/mode/i)
      }
    }
    const preload = readFileSync(join(root, 'src/preload/index.ts'), 'utf8')
    expect(preload).not.toMatch(/mode/i)
  })
})
