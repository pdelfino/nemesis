import type { BufferInfo } from '../../shared/buffers'
import type { BufferType, ModeShape } from '../../shared/keys'
import type { HookHandler, HookPoint, HookRegistry } from '../hooks'
import type { KeymapSpec } from './keymap'
import { defineKeymap, Keymap } from './keymap'
import type { PaletteSource, Prompter } from './prompter'
import type { Command, CommandContext } from './registry'
import { CommandError, defineCommand } from './registry'

/**
 * Modes (#166, ADR 0004): a mode is a definition registered once, by name,
 * with a keymap layer, the hooks it attaches, settings with defaults, and
 * `enable` and `disable` run at the transaction boundary. A buffer's modes
 * are a list in priority order, first wins, on `BufferInfo.modes`; the
 * resolver looks a key up in them, then in the `base` mode, the global map.
 *
 * Who switches a mode: a command in the registry (`toggle-<name>`,
 * `enable-mode`, `disable-mode`), the config file, or a rule the user wrote
 * there. This module imports nothing of the IPC layer and no channel in
 * src/shared/ names a mode switch, so neither a page nor the renderer can
 * turn one on (SECURITY.org T4; tests/unit/modes.test.ts pins it).
 *
 * The page toggles are modes too (#168): `reader`, `blocker`, `passthrough`
 * and `form-guide` (keyscheme.ts), each keeping its old command name as its
 * toggler. `document` and `hint` stay the page buffer's own, always on and
 * on while labels are up, and their names are reserved here.
 */

/** A handler a mode attaches at a hook point (ADR 0005) while it is on. */
export interface ModeHook {
  readonly point: HookPoint
  readonly handler: HookHandler<HookPoint>
}

/** Live state of one mode in one buffer: created on enable, dropped on disable. */
export interface ModeState<Settings extends object = Record<string, unknown>> {
  readonly mode: string
  readonly bufferId: string
  readonly settings: Settings
}

export interface ModeSpec<Settings extends object = Record<string, unknown>> {
  /** Kebab-case, the same rule as a command name. */
  readonly name: string
  /** One line, shown by the palette. */
  readonly doc: string
  /** The mode's keymap layer: the same spec as defineKeymap's, or a keymap built already. */
  readonly keymap?: KeymapSpec | Keymap
  /** Attached with the source `mode:<name>` while the mode is on in any buffer. */
  readonly hooks?: readonly ModeHook[]
  /** Defaults; an enable call may override them. */
  readonly settings?: Settings
  /** Shown in the mode line. Default true. */
  readonly visible?: boolean
  /** While on, an unmodified key is a command, not text. Default false. */
  readonly modal?: boolean
  /** While on, no layer below this one sees a key. Default false. */
  readonly sealed?: boolean
  /** Registers `toggle-<name>`. Default true. */
  readonly toggler?: boolean
  /** The toggler's name when it is not `toggle-<name>`: a mode that kept the command it came from (#168). */
  readonly command?: string
  /** Buffer kinds the mode may be enabled in. Absent means any. */
  readonly kinds?: readonly BufferType[]
  enable?(buffer: BufferInfo, state: ModeState<Settings>): void | Promise<void>
  disable?(buffer: BufferInfo, state: ModeState<Settings>): void | Promise<void>
}

/** A checked, frozen mode, its keymap built once so a bad chord fails at definition. */
export interface Mode extends ModeSpec<Record<string, unknown>> {
  readonly layer: Keymap | null
}

/** Who defined a mode: the cockpit, or the config file, whose reload drops and redefines its own. */
export type ModeSource = 'cockpit' | 'config'

export class ModeError extends Error {
  override readonly name = 'ModeError'
}

const MODE_NAME = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/

/** The mode every buffer is in, last: the global map. Never listed, never disabled. */
export const BASE_MODE = 'base'

/** Which modes a new buffer of each kind starts in, first wins. */
export const DEFAULT_MODES: Readonly<Partial<Record<BufferType, readonly string[]>>> = {
  permission: ['permission'],
  diff: ['diff'],
  plan: ['plan'],
  spec: ['spec'],
  // A page is in `document` always; the blocker is on from creation (#126).
  page: ['blocker', 'document'],
}

export function defineMode<Settings extends object>(spec: ModeSpec<Settings>): Mode {
  if (!MODE_NAME.test(spec.name)) throw new ModeError(`Mode name "${spec.name}" is not kebab-case`)
  if (spec.doc.trim().length === 0) throw new ModeError(`Mode "${spec.name}" needs a doc line`)
  const keymap = spec.keymap
  const layer =
    keymap === undefined
      ? null
      : keymap instanceof Keymap
        ? keymap
        : defineKeymap(spec.name, keymap)
  return Object.freeze({ ...(spec as unknown as ModeSpec), layer })
}

/** The name of a mode's toggle command. */
export function togglerName(mode: string): string {
  return `toggle-${mode}`
}

/** `toggle-<name>` for a mode, acting through `toggle`, which knows the current buffer. */
export function toggleCommand(mode: Mode, toggle: (name: string) => Promise<void>): Command {
  return defineCommand({
    name: mode.command ?? togglerName(mode.name),
    // A mode of the page boundary is the user's to switch, never an MCP client's or the config's.
    ...(mode.kinds?.includes('page') === true ? { mcp: 'never' as const } : {}),
    doc: `Turn ${mode.name} mode on or off in the current buffer: ${mode.doc}`,
    run: () => toggle(mode.name),
  })
}

/** Told when a mode is dropped, so every window takes it off its buffers. */
export type ModeDropListener = (mode: Mode) => void

/**
 * The modes the app knows, by name: the cockpit's and the config file's.
 * One for the app; each window's `BufferModes` holds its buffers' state.
 */
export class ModeRegistry {
  private readonly modes = new Map<string, { readonly mode: Mode; readonly source: ModeSource }>()
  /** How many buffers, across windows, have each mode on: the hooks go on at one and off at zero. */
  private readonly attached = new Map<string, number>()
  private readonly listeners = new Set<ModeDropListener>()
  private hooks: HookRegistry | null = null

  /** `reserved` are names no mode may take: the page buffer's own modes until #168. */
  constructor(private readonly reserved: ReadonlySet<string> = new Set()) {}

  /** The app's hooks (#165): a mode's handlers go there while it is on. */
  useHooks(hooks: HookRegistry): void {
    this.hooks = hooks
  }

  register(mode: Mode, source: ModeSource = 'cockpit'): void {
    if (this.reserved.has(mode.name)) {
      throw new ModeError(`Mode "${mode.name}" is the page buffer's own`)
    }
    if (this.modes.has(mode.name)) throw new ModeError(`Mode "${mode.name}" is already defined`)
    this.modes.set(mode.name, { mode, source })
  }

  get(name: string): Mode | undefined {
    return this.modes.get(name)?.mode
  }

  has(name: string): boolean {
    return this.modes.has(name)
  }

  /** Every mode, or every mode of one source, in definition order. */
  list(source?: ModeSource): readonly Mode[] {
    return [...this.modes.values()]
      .filter((entry) => source === undefined || entry.source === source)
      .map((entry) => entry.mode)
  }

  /** The names a mode of `source` may not take: the reserved ones and every other source's. */
  takenNames(source: ModeSource): ReadonlySet<string> {
    return new Set([
      ...this.reserved,
      ...[...this.modes].filter(([, entry]) => entry.source !== source).map(([name]) => name),
    ])
  }

  /** The modes a new buffer of this kind starts in, first wins. */
  defaultsFor(kind: BufferType): readonly string[] {
    return DEFAULT_MODES[kind] ?? []
  }

  /** The shape the renderer composes a buffer's keys from, per mode name. */
  shapes(): Readonly<Record<string, ModeShape>> {
    const shapes: Record<string, ModeShape> = {}
    for (const mode of this.list()) {
      if (mode.name === BASE_MODE) continue
      shapes[mode.name] = {
        keys: mode.layer?.shape() ?? { chords: [], prefixes: [] },
        modal: mode.modal === true,
        visible: mode.visible !== false,
      }
    }
    return shapes
  }

  /**
   * Swaps every mode of `source` for `next`, as a config reload does: each
   * dropped mode is taken off every buffer that had it first.
   */
  replace(source: ModeSource, next: readonly Mode[]): void {
    for (const [name, entry] of [...this.modes]) {
      if (entry.source !== source) continue
      for (const listener of [...this.listeners]) listener(entry.mode)
      this.modes.delete(name)
      this.hooks?.dropSource(`mode:${name}`)
      this.attached.delete(name)
    }
    for (const mode of next) this.register(mode, source)
  }

  onDrop(listener: ModeDropListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** A buffer turned the mode on: its hooks go on with the first. */
  attach(mode: Mode): void {
    const count = this.attached.get(mode.name) ?? 0
    this.attached.set(mode.name, count + 1)
    if (count > 0 || this.hooks === null) return
    for (const { point, handler } of mode.hooks ?? []) {
      this.hooks.on(point, handler, `mode:${mode.name}`)
    }
  }

  /** A buffer turned the mode off: its hooks go with the last. */
  detach(mode: Mode): void {
    const count = (this.attached.get(mode.name) ?? 0) - 1
    if (count > 0) {
      this.attached.set(mode.name, count)
      return
    }
    this.attached.delete(mode.name)
    this.hooks?.dropSource(`mode:${mode.name}`)
  }
}

/** What `BufferModes` needs of the window's buffer list. */
export interface ModeBuffers {
  get(id: string): BufferInfo | undefined
  readonly current: BufferInfo | null
  list(): readonly BufferInfo[]
  update(id: string, patch: { readonly modes: readonly string[] }): BufferInfo
  subscribe(listener: (list: { readonly buffers: readonly BufferInfo[] }) => void): () => void
}

/**
 * One window's buffers and the modes they are in (#166). The buffer list
 * holds the names, in priority order; this holds each live mode's state,
 * created when the mode goes on and dropped when it goes off or the buffer
 * is killed. A buffer's default modes go on when it appears in the list.
 */
export class BufferModes {
  private readonly states = new Map<string, Map<string, ModeState>>()
  /** Each buffer as last listed, so a killed buffer's disable still sees it. */
  private readonly last = new Map<string, BufferInfo>()
  private readonly notify: (text: string) => void
  private readonly unsubscribe: (() => void)[]

  constructor(
    private readonly registry: ModeRegistry,
    private readonly buffers: ModeBuffers,
    notify: (text: string) => void = () => {},
  ) {
    this.notify = notify
    this.follow(buffers.list())
    this.unsubscribe = [
      buffers.subscribe(({ buffers: list }) => this.follow(list)),
      registry.onDrop((mode) => this.dropped(mode)),
    ]
  }

  /** The window is gone: every mode of its buffers goes off, so no hook outlives it. */
  dispose(): void {
    for (const off of this.unsubscribe.splice(0)) off()
    this.follow([])
  }

  /** The modes of a buffer, first wins; empty for an unknown id. */
  enabled(bufferId: string): readonly string[] {
    return this.buffers.get(bufferId)?.modes ?? []
  }

  /** A live mode's state in a buffer, or undefined when it is off. */
  state(bufferId: string, name: string): ModeState | undefined {
    return this.states.get(bufferId)?.get(name)
  }

  /** Turns a mode on in a buffer, in front of the modes it already has. On already is a no-op. */
  async enableMode(bufferId: string, name: string, settings?: object): Promise<void> {
    const buffer = this.ownBuffer(bufferId)
    const mode = this.registry.get(name)
    if (mode === undefined || name === BASE_MODE) throw new ModeError(`No mode named "${name}"`)
    if (mode.kinds !== undefined && !mode.kinds.includes(buffer.kind)) {
      throw new ModeError(`Mode "${name}" is for ${mode.kinds.join(', ')} buffers`)
    }
    if ((buffer.modes ?? []).includes(name)) return
    const state = this.start(buffer, mode, settings)
    try {
      await mode.enable?.(buffer, state)
    } catch (error) {
      this.stop(buffer.id, mode)
      throw error
    }
    // Read again: the buffer may have changed while enable ran.
    const now = this.buffers.get(buffer.id)
    if (now === undefined) {
      this.stop(buffer.id, mode)
      return
    }
    // A mode turned on now goes first: the one the user just asked for wins.
    this.buffers.update(buffer.id, { modes: [name, ...(now.modes ?? [])] })
  }

  /** Turns a mode off in a buffer. Off already is a no-op. */
  async disableMode(bufferId: string, name: string): Promise<void> {
    const buffer = this.ownBuffer(bufferId)
    if (!(buffer.modes ?? []).includes(name)) return
    this.buffers.update(buffer.id, { modes: (buffer.modes ?? []).filter((m) => m !== name) })
    const mode = this.registry.get(name)
    if (mode === undefined) return
    const state = this.stop(buffer.id, mode)
    await mode.disable?.(buffer, state)
  }

  /** The current buffer, which the mode commands act on. */
  get current(): BufferInfo | null {
    return this.buffers.current
  }

  /** Whether this window has the buffer. */
  exists(bufferId: string): boolean {
    return this.buffers.get(bufferId) !== undefined
  }

  /** The buffers a mode read is for, while the buffers read before it is answered (#168). */
  targets: readonly string[] | null = null

  /** The buffers the mode commands act on now: the ones read, else the current one. */
  targetIds(): readonly string[] {
    if (this.targets !== null) return this.targets
    const id = this.buffers.current?.id
    return id === undefined ? [] : [id]
  }

  /** The names among `names` that are registered modes: a page's `document` and `hint` are not. */
  registered(names: readonly string[]): readonly string[] {
    return names.filter((name) => name !== BASE_MODE && this.registry.has(name))
  }

  /** The modes that could go on in a buffer now: registered, allowed for its kind, and off. */
  available(bufferId: string): readonly Mode[] {
    const buffer = this.buffers.get(bufferId)
    if (buffer === undefined) return []
    const on = buffer.modes ?? []
    return this.registry
      .list()
      .filter(
        (mode) =>
          mode.name !== BASE_MODE &&
          !on.includes(mode.name) &&
          (mode.kinds === undefined || mode.kinds.includes(buffer.kind)),
      )
  }

  /** On when off, off when on, in a buffer. */
  async toggleMode(bufferId: string, name: string): Promise<void> {
    if (this.enabled(bufferId).includes(name)) await this.disableMode(bufferId, name)
    else await this.enableMode(bufferId, name)
  }

  private ownBuffer(bufferId: string): BufferInfo {
    const buffer = this.buffers.get(bufferId)
    if (buffer === undefined) throw new ModeError(`No buffer with id "${bufferId}"`)
    return buffer
  }

  private start(buffer: BufferInfo, mode: Mode, settings?: object): ModeState {
    const state: ModeState = Object.freeze({
      mode: mode.name,
      bufferId: buffer.id,
      settings: Object.freeze({ ...(mode.settings ?? {}), ...(settings ?? {}) }),
    })
    const live = this.states.get(buffer.id) ?? new Map<string, ModeState>()
    live.set(mode.name, state)
    this.states.set(buffer.id, live)
    this.registry.attach(mode)
    return state
  }

  private stop(bufferId: string, mode: Mode): ModeState {
    const live = this.states.get(bufferId)
    const state = live?.get(mode.name) ?? {
      mode: mode.name,
      bufferId,
      settings: { ...(mode.settings ?? {}) },
    }
    if (live?.delete(mode.name) === true) this.registry.detach(mode)
    return state
  }

  /** A buffer that appeared with modes (its kind's defaults): each registered one goes on. */
  private adopt(buffer: BufferInfo): void {
    if (this.states.has(buffer.id)) return
    this.states.set(buffer.id, new Map())
    for (const name of buffer.modes ?? []) {
      const mode = this.registry.get(name)
      if (mode === undefined) continue
      const state = this.start(buffer, mode)
      this.settle(() => mode.enable?.(buffer, state), mode, 'enable')
    }
  }

  private follow(list: readonly BufferInfo[]): void {
    const ids = new Set(list.map((buffer) => buffer.id))
    for (const buffer of list) this.adopt(buffer)
    // A killed buffer: every mode it had goes off, so its hooks are detached.
    for (const [id, live] of [...this.states]) {
      if (ids.has(id)) continue
      const buffer = this.last.get(id)
      this.states.delete(id)
      for (const state of live.values()) {
        const mode = this.registry.get(state.mode)
        if (mode === undefined) continue
        this.registry.detach(mode)
        if (buffer !== undefined) this.settle(() => mode.disable?.(buffer, state), mode, 'disable')
      }
    }
    this.last.clear()
    for (const buffer of list) this.last.set(buffer.id, buffer)
  }

  /** A mode dropped by a config reload goes off every buffer of this window that had it. */
  private dropped(mode: Mode): void {
    for (const [id, live] of this.states) {
      const state = live.get(mode.name)
      if (state === undefined) continue
      live.delete(mode.name)
      const buffer = this.buffers.get(id)
      if (buffer === undefined) continue
      this.buffers.update(id, { modes: (buffer.modes ?? []).filter((m) => m !== mode.name) })
      this.settle(() => mode.disable?.(buffer, state), mode, 'disable')
    }
  }

  /** An enable or disable nobody awaits: a failure is a notice, not a crash. */
  private settle(step: () => void | Promise<void>, mode: Mode, name: string): void {
    const report = (error: unknown): void => {
      this.notify(
        `Mode ${mode.name}: ${name} failed: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    try {
      void Promise.resolve(step()).catch(report)
    } catch (error) {
      report(error)
    }
  }
}

/** The palette's reads of enable-mode and disable-mode. */
export const ENABLE_MODE_SOURCE = 'modes-off'
export const DISABLE_MODE_SOURCE = 'modes-on'

export function modeSources(modes: BufferModes): readonly PaletteSource[] {
  return [
    {
      name: ENABLE_MODE_SOURCE,
      candidates: () => {
        // Every mode that could go on in at least one of the buffers, once each.
        const seen = new Map<string, Mode>()
        for (const id of modes.targetIds()) {
          for (const mode of modes.available(id)) seen.set(mode.name, mode)
        }
        return [...seen.values()].map((mode) => ({
          id: mode.name,
          label: mode.name,
          doc: mode.doc,
        }))
      },
    },
    {
      name: DISABLE_MODE_SOURCE,
      candidates: () => {
        const names = new Set(
          modes.targetIds().flatMap((id) => modes.registered(modes.enabled(id))),
        )
        return [...names].map((name) => ({ id: name, label: name, doc: `${name} mode` }))
      },
    },
  ]
}

/**
 * `enable-mode` and `disable-mode` over the current buffer, read through the
 * palette, and `toggle-<name>` for every togglable mode of `togglable`.
 */
export function modeCommands(
  modes: BufferModes,
  prompter: Prompter,
  togglable: readonly Mode[],
): readonly Command[] {
  const currentId = (): string => {
    const buffer = modes.current
    if (buffer === null) throw new CommandError('There is no current buffer')
    return buffer.id
  }
  /**
   * Reads the mode to switch and applies it to every target. From the palette
   * the buffers are read first, several at once when marked (#167); from a
   * key, the config or a test, the current buffer is the one.
   */
  const switchMode = (
    context: CommandContext,
    prompt: string,
    source: string,
    apply: (id: string, name: string) => Promise<void>,
  ): void => {
    const readMode = (ids: readonly string[]): void => {
      modes.targets = ids
      prompter.read({ source, prompt, onCancel: () => (modes.targets = null) }, async (name) => {
        modes.targets = null
        // A buffer the mode is not for, or one gone since the read, is skipped.
        for (const id of ids) {
          await apply(id, name).catch((error: unknown) => {
            if (!(error instanceof ModeError)) throw error
          })
        }
      })
    }
    if (context.source !== 'palette') {
      readMode([currentId()])
      return
    }
    const chosen: string[] = []
    prompter.read(
      { source: 'buffers', prompt: 'In buffer:', multiple: true, after: () => readMode(chosen) },
      (id) => {
        // Another window's buffer is that window's to switch.
        if (modes.exists(id)) chosen.push(id)
      },
    )
  }
  return [
    defineCommand({
      name: 'enable-mode',
      // Page modes sit on the page boundary: the user's, never an MCP client's.
      mcp: 'never',
      doc: 'Turn a mode on in the buffers chosen, several at once when marked (M-SPC marks); from a key, in the current buffer.',
      run: (context) =>
        switchMode(context, 'Enable mode:', ENABLE_MODE_SOURCE, (id, name) =>
          modes.enableMode(id, name),
        ),
    }),
    defineCommand({
      name: 'disable-mode',
      mcp: 'never',
      doc: 'Turn a mode off in the buffers chosen, several at once when marked (M-SPC marks); from a key, in the current buffer.',
      run: (context) =>
        switchMode(context, 'Disable mode:', DISABLE_MODE_SOURCE, (id, name) =>
          modes.disableMode(id, name),
        ),
    }),
    ...togglable
      .filter((mode) => mode.name !== BASE_MODE && mode.toggler !== false)
      .map((mode) => toggleCommand(mode, (name) => modes.toggleMode(currentId(), name))),
  ]
}
