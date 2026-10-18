import type { MenuItemConstructorOptions } from 'electron'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { bindingNote } from '../../src/main/commands/describe'
import { cockpitKeymapLayers, createCockpitRegistry } from '../../src/main/commands/keyscheme'

/**
 * The application menu (#30) over the pure template builder: the standard
 * sections are there, the `Commands` menu has one item per registered command
 * with its chord as text, and no item of ours carries an accelerator, so no
 * key is taken from the renderer's capture. The live menu, clicked from the
 * main process, is tests/e2e/menu.spec.ts.
 */

const built = vi.fn((template: MenuItemConstructorOptions[]) => ({ template }))
const installed = vi.fn()
vi.mock('electron', () => ({
  Menu: {
    buildFromTemplate: built,
    setApplicationMenu: installed,
  },
}))

const { buildMenuTemplate, commandLabel, COMMANDS_MENU_LABEL, humanize, installMenu } =
  await import('../../src/main/menu')

/** The submenu as the template spells it; the builder never passes a Menu instance. */
function items(entry: MenuItemConstructorOptions | undefined): MenuItemConstructorOptions[] {
  if (entry === undefined || !Array.isArray(entry.submenu)) throw new Error('No submenu')
  return entry.submenu
}

function topLevel(template: MenuItemConstructorOptions[]): string[] {
  return template.map((entry) => entry.label ?? entry.role ?? '')
}

function byLabel(template: MenuItemConstructorOptions[], label: string) {
  return template.find((entry) => entry.label === label)
}

/** Every item of every submenu, flattened. */
function allItems(template: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] {
  return template.flatMap((entry) => items(entry))
}

describe('the application menu (#30)', () => {
  const registry = createCockpitRegistry()
  const layers = cockpitKeymapLayers()

  beforeEach(() => {
    built.mockClear()
    installed.mockClear()
  })

  it('has the standard sections and the generated Commands menu', () => {
    const template = buildMenuTemplate(registry, layers, { isDev: false })
    expect(topLevel(template)).toEqual(['Nemesis', 'Edit', 'View', 'Commands', 'window', 'help'])
    expect(items(template[0]).map((item) => item.role)).toEqual([
      'about',
      undefined,
      'hide',
      'hideOthers',
      'unhide',
      undefined,
      'quit',
    ])
    expect(items(byLabel(template, 'Edit')).map((item) => item.role)).toContain('copy')
    expect(items(byLabel(template, 'Edit')).map((item) => item.role)).toContain('paste')
    expect(items(template[4]).map((item) => item.role)).toEqual([
      'minimize',
      'zoom',
      undefined,
      'front',
    ])
  })

  it('offers reload and the devtools toggle in development only', () => {
    const dev = items(byLabel(buildMenuTemplate(registry, layers, { isDev: true }), 'View'))
    const packaged = items(byLabel(buildMenuTemplate(registry, layers, { isDev: false }), 'View'))
    expect(dev.map((item) => item.role)).toContain('toggleDevTools')
    expect(dev.map((item) => item.role)).toContain('reload')
    expect(packaged.map((item) => item.role)).not.toContain('toggleDevTools')
    expect(packaged.map((item) => item.role)).not.toContain('reload')
    for (const view of [dev, packaged]) {
      expect(view.map((item) => item.role)).toContain('zoomIn')
      expect(view.map((item) => item.role)).toContain('zoomOut')
    }
  })

  it('lists every command once, with the chord from the keymaps as text', () => {
    const template = buildMenuTemplate(registry, layers, { isDev: false })
    const commands = items(byLabel(template, COMMANDS_MENU_LABEL))
    const names = registry.list().map((command) => command.name)
    expect(names.length).toBeGreaterThan(5)
    expect(commands.map((item) => item.id)).toEqual(names)
    expect(commands.map((item) => item.label)).toEqual(
      names.map((name) => commandLabel(name, layers)),
    )

    const label = (name: string) => commands.find((item) => item.id === name)?.label
    expect(label('switch-buffer')).toBe('Switch buffer    C-x b')
    expect(label('describe-command')).toBe('Describe command    C-h x')
    expect(label('answer-yes')).toBe(`Answer yes    ${bindingNote(layers, 'answer-yes')}`)
    expect(label('answer-yes')).toContain('y (permission)')
    // A command without a binding shows its name alone.
    expect(bindingNote(layers, 'choose-buffer')).toBe('')
    expect(label('choose-buffer')).toBe('Choose buffer')
    expect(humanize('choose-option-1')).toBe('Choose option 1')
  })

  it('has no accelerator anywhere: roles carry their own, chords stay text', () => {
    const template = buildMenuTemplate(registry, layers, { isDev: true })
    for (const item of [...template, ...allItems(template)]) {
      expect(item.accelerator).toBeUndefined()
    }
    for (const item of allItems(template)) {
      // An item is one of ours, with an id and a click, or a role item, or a separator.
      const ours = item.id !== undefined && typeof item.click === 'function'
      expect(ours || item.role !== undefined || item.type === 'separator').toBe(true)
    }
  })

  it('runs the command through the registry when its item is clicked, as a menu invocation', async () => {
    const run = vi.spyOn(registry, 'run').mockResolvedValue(undefined)
    const template = buildMenuTemplate(registry, layers, { isDev: false })
    const item = items(byLabel(template, COMMANDS_MENU_LABEL)).find(
      (one) => one.id === 'switch-buffer',
    )
    if (item === undefined || typeof item.click !== 'function') throw new Error('No item')
    item.click({} as never, undefined, {} as never)
    expect(run).toHaveBeenCalledWith('switch-buffer', { source: 'menu' })
    run.mockRestore()
  })

  it('the Help menu repeats the two help commands', () => {
    const template = buildMenuTemplate(registry, layers, { isDev: false })
    expect(items(template[5]).map((item) => item.id)).toEqual(['describe-command', 'describe-key'])
  })

  it('installMenu builds the template and sets it as the application menu', () => {
    const menu = installMenu(registry, layers, { isDev: false })
    expect(built).toHaveBeenCalledTimes(1)
    expect(topLevel(built.mock.calls[0]?.[0] ?? [])).toContain(COMMANDS_MENU_LABEL)
    expect(installed).toHaveBeenCalledWith(menu)
  })
})
