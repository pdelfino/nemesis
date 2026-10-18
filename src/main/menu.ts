import { Menu, type MenuItemConstructorOptions } from 'electron'
import type { KeymapLayer } from './commands/describe'
import { bindingNote } from './commands/describe'
import type { CommandRegistry } from './commands/registry'

/**
 * The application menu (#30). The standard macOS sections are role items, so
 * Cmd-Q, Cmd-W, Cmd-C and Cmd-V in the editors, Hide and Minimize come from
 * the system; the `Commands` menu is generated from the registry, one item per
 * command with its chord written in the label, and is the one place a new user
 * reads what the cockpit does and which keys run it.
 *
 * Chords are text, never accelerators. An Emacs chord is a sequence (`C-x b`),
 * an accelerator is one stroke, and an accelerator would take the key before
 * the renderer's capture (#61) ever saw it. The only accelerators in this menu
 * are the ones the roles carry themselves.
 *
 * The menu is built once at startup. When the config reloads (M3, #71) the
 * reload must call `installMenu` again so the labels follow the keymaps.
 *
 * `send-prompt` and `search-buffer` act in the renderer when a key or the
 * palette dispatches them; the menu runs their main-process bodies, which are
 * empty until a renderer-side door exists for a menu click.
 */

export interface MenuOptions {
  /** Reload and the devtools toggle are offered in development only. */
  readonly isDev: boolean
}

/** The top-level label of the generated menu. Its items carry the command name as `id`. */
export const COMMANDS_MENU_LABEL = 'Commands'

/** Between the command and its chord in a label: `Switch buffer    C-x b`. */
const CHORD_GAP = '    '

/** `switch-buffer` reads `Switch buffer` on a menu. */
export function humanize(name: string): string {
  const words = name.replace(/-/g, ' ')
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/** The label of a command's item: its name, then its chords when it has any. */
export function commandLabel(name: string, layers: readonly KeymapLayer[]): string {
  const note = bindingNote(layers, name)
  return note.length === 0 ? humanize(name) : `${humanize(name)}${CHORD_GAP}${note}`
}

function commandItem(
  registry: CommandRegistry,
  layers: readonly KeymapLayer[],
  name: string,
): MenuItemConstructorOptions {
  return {
    id: name,
    label: commandLabel(name, layers),
    click: () => {
      registry.run(name, { source: 'menu' }).catch((error: unknown) => {
        // The name is safe to print; nothing from a buffer is.
        console.error(`Command ${name} (menu) failed:`, error)
      })
    },
  }
}

/** The whole template, a pure function of the registry and the keymaps. */
export function buildMenuTemplate(
  registry: CommandRegistry,
  layers: readonly KeymapLayer[],
  options: MenuOptions,
): MenuItemConstructorOptions[] {
  const separator: MenuItemConstructorOptions = { type: 'separator' }
  return [
    {
      // macOS replaces this label with the bundle's name.
      label: 'Nemesis',
      submenu: [
        { role: 'about' },
        separator,
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        separator,
        { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        separator,
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'pasteAndMatchStyle' },
        { role: 'delete' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        ...(options.isDev
          ? [
              { role: 'reload' } as const,
              { role: 'forceReload' } as const,
              { role: 'toggleDevTools' } as const,
              separator,
            ]
          : []),
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        separator,
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: COMMANDS_MENU_LABEL,
      submenu: registry.list().map((command) => commandItem(registry, layers, command.name)),
    },
    {
      role: 'window',
      submenu: [{ role: 'minimize' }, { role: 'zoom' }, separator, { role: 'front' }],
    },
    {
      role: 'help',
      // The help commands again, where a Mac user looks first; macOS adds its
      // menu search here, which finds a command by chord text too.
      submenu: ['describe-command', 'describe-key'].map((name) =>
        commandItem(registry, layers, name),
      ),
    },
  ]
}

/** Builds the menu and makes it the application menu. Call again after the keymaps change (#71). */
export function installMenu(
  registry: CommandRegistry,
  layers: readonly KeymapLayer[],
  options: MenuOptions,
): Menu {
  const menu = Menu.buildFromTemplate(buildMenuTemplate(registry, layers, options))
  Menu.setApplicationMenu(menu)
  return menu
}
