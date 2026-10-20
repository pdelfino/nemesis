import type { BufferType } from '../../shared/keys'
import type { PaletteCandidate } from '../../shared/palette'
import { HOOK_POINT_DOCS, HOOK_POINTS, isHookPoint, type HookListing } from '../hooks'
import { SETTING_DOCS, type Settings } from '../settings'
import type { KeyReading } from './dispatcher'
import type { Keymap } from './keymap'
import { BASE_MODE, togglerName, type ModeRegistry } from './modes'
import type { CommandRegistry } from './registry'

/**
 * The text of describe-command and describe-key (#65): a command's doc line
 * and the keys that run it, as the help buffer shows them. Pure functions over
 * the registry and the keymaps; the unit tests read them straight. The same
 * for describe-setting, describe-mode, describe-hook and describe-any (#171),
 * over the settings' doc lines, the mode registry and the hook points.
 */

/**
 * One keymap and the buffers it applies to: null for the global map. A mode's
 * layer (#166) names the mode, and its one kind when it has one.
 */
export interface KeymapLayer {
  readonly keymap: Keymap
  readonly bufferType: BufferType | null
  readonly mode?: string
}

/** Every chord that runs `name`, with the buffer type it is bound in. */
export function bindingsOf(
  layers: readonly KeymapLayer[],
  name: string,
): readonly { chord: string; bufferType: BufferType | null; mode?: string }[] {
  const bindings = []
  for (const layer of layers) {
    for (const entry of layer.keymap.entries()) {
      if (entry.command === name) {
        bindings.push({
          chord: entry.chord,
          bufferType: layer.bufferType,
          ...(layer.mode === undefined ? {} : { mode: layer.mode }),
        })
      }
    }
  }
  return bindings
}

/** The chords that run `name`, as one short note for the palette: `C-x b`, `y (permission)`. */
export function bindingNote(layers: readonly KeymapLayer[], name: string): string {
  return bindingsOf(layers, name)
    .map(({ chord, bufferType, mode }) => {
      const where = bufferType ?? mode
      return where === undefined || where === null ? chord : `${chord} (${where})`
    })
    .join(', ')
}

export function describeCommand(
  registry: CommandRegistry,
  layers: readonly KeymapLayer[],
  name: string,
): string {
  const command = registry.get(name)
  if (command === undefined) return `There is no command named ${name}.`
  const bindings = bindingsOf(layers, name)
  const lines = [command.name, command.doc]
  if (bindings.length === 0) {
    lines.push('It is not bound to any key; run it from M-x.')
  } else {
    for (const { chord, bufferType, mode } of bindings) {
      lines.push(
        bufferType !== null
          ? `It is bound to ${chord} in ${bufferType} buffers.`
          : mode !== undefined
            ? `It is bound to ${chord} in ${mode} mode.`
            : `It is bound to ${chord}.`,
      )
    }
  }
  return lines.join('\n')
}

/**
 * Every binding in force for a buffer of `bufferType` (describe-bindings): the
 * global layers first, then that buffer type's, each as chord, command and the
 * command's doc line. Without a type, every layer is listed.
 */
export function bindingsText(
  layers: readonly KeymapLayer[],
  registry: CommandRegistry,
  bufferType?: BufferType | null,
): string {
  const applies = (layer: KeymapLayer): boolean =>
    bufferType === undefined || layer.bufferType === null || layer.bufferType === bufferType
  const ordered = [
    ...layers.filter((layer) => applies(layer) && layer.bufferType === null),
    ...layers.filter((layer) => applies(layer) && layer.bufferType !== null),
  ]
  const sections = ordered.map((layer) => {
    const title = layer.bufferType === null ? 'Global bindings' : `${layer.bufferType} bindings`
    const rows = layer.keymap.entries().map(({ chord, command }) => {
      const doc = registry.get(command)?.doc ?? ''
      return `${chord}  ${command}${doc === '' ? '' : `  ${doc}`}`
    })
    return [title, ...rows].join('\n')
  })
  return sections.join('\n\n')
}

export function describeKey(registry: CommandRegistry, reading: KeyReading): string {
  const where = reading.bufferType === null ? '' : ` in a ${reading.bufferType} buffer`
  if (reading.command === null) return `${reading.chord} is not bound${where}.`
  const doc = registry.get(reading.command)?.doc ?? ''
  return `${reading.chord} runs ${reading.command}${where}.\n${doc}`.trimEnd()
}

/** The settings described, each the one in force and the one on the first run. */
export interface SettingsInForce {
  readonly current: () => Settings
  readonly defaults: Settings
}

function isSettingKey(key: string): key is keyof Settings {
  return Object.hasOwn(SETTING_DOCS, key)
}

/** describe-setting: the doc line, the type, the default and the value in force. */
export function describeSetting(settings: SettingsInForce, key: string): string {
  if (!isSettingKey(key)) return `There is no setting named ${key}.`
  const { type, doc } = SETTING_DOCS[key]
  const show = (value: unknown): string => JSON.stringify(value) ?? 'absent'
  return [
    key,
    doc,
    `Type: ${type}`,
    `Default: ${show(settings.defaults[key])}`,
    `Current: ${show(settings.current()[key])}`,
  ].join('\n')
}

/** describe-mode: the doc line, the buffers it applies to, its toggler, keys and hooks. */
export function describeMode(
  modes: ModeRegistry,
  layers: readonly KeymapLayer[],
  name: string,
): string {
  const mode = modes.get(name)
  if (mode === undefined) return `There is no mode named ${name}.`
  const lines = [`${mode.name} mode`, mode.doc]
  lines.push(
    mode.kinds === undefined
      ? 'It applies to any buffer.'
      : `It applies to ${mode.kinds.join(', ')} buffers.`,
  )
  if (mode.name !== BASE_MODE && mode.toggler !== false) {
    lines.push(`${mode.command ?? togglerName(mode.name)} turns it on and off.`)
  }
  for (const layer of layers) {
    if (layer.mode !== mode.name) continue
    for (const { chord, command } of layer.keymap.entries()) {
      lines.push(`While on, ${chord} runs ${command}.`)
    }
  }
  for (const { point, handler } of mode.hooks ?? []) {
    lines.push(`While on, ${handler.name} handles ${point}.`)
  }
  return lines.join('\n')
}

/** describe-hook: the point's doc line, its kind and timeout, and every handler on it. */
export function describeHook(listing: readonly HookListing[], point: string): string {
  if (!isHookPoint(point)) return `There is no hook point named ${point}.`
  const { kind, timeoutMs } = HOOK_POINTS[point]
  const lines = [
    point,
    HOOK_POINT_DOCS[point],
    `It is an ${kind} point; each handler has ${timeoutMs} ms.`,
  ]
  const handlers = listing.filter((entry) => entry.point === point)
  if (handlers.length === 0) lines.push('No handler is registered.')
  for (const entry of handlers) lines.push(`  ${entry.name} (${entry.source}): ${entry.doc}`)
  return lines.join('\n')
}

/** What describe-any lists, each tag the describe RET opens. */
export type DescribeKind = 'command' | 'setting' | 'mode' | 'hook' | 'key'

/** One binding as describe-any carries it in a candidate's id. */
export interface Binding {
  readonly chord: string
  readonly command: string
  readonly bufferType: BufferType | null
  readonly mode?: string
}

/** describe-any's id for a candidate: the kind, a colon, then the name or the binding as JSON. */
export function describeAnyId(kind: DescribeKind, name: string | Binding): string {
  return `${kind}:${typeof name === 'string' ? name : JSON.stringify(name)}`
}

/** describe-any (#171): one candidate per command, setting, mode, hook point and binding. */
export function describeAnyCandidates(
  registry: CommandRegistry,
  layers: readonly KeymapLayer[],
  modes: ModeRegistry,
): readonly PaletteCandidate[] {
  const candidates: PaletteCandidate[] = []
  for (const command of registry.list()) {
    candidates.push({
      id: describeAnyId('command', command.name),
      label: command.name,
      doc: command.doc,
      detail: 'command',
    })
  }
  for (const [key, { doc }] of Object.entries(SETTING_DOCS)) {
    candidates.push({ id: describeAnyId('setting', key), label: key, doc, detail: 'setting' })
  }
  for (const mode of modes.list()) {
    candidates.push({
      id: describeAnyId('mode', mode.name),
      label: mode.name,
      doc: mode.doc,
      detail: 'mode',
    })
  }
  for (const [point, doc] of Object.entries(HOOK_POINT_DOCS)) {
    candidates.push({ id: describeAnyId('hook', point), label: point, doc, detail: 'hook' })
  }
  for (const layer of layers) {
    for (const { chord, command } of layer.keymap.entries()) {
      const binding: Binding = {
        chord,
        command,
        bufferType: layer.bufferType,
        ...(layer.mode === undefined ? {} : { mode: layer.mode }),
      }
      candidates.push({
        id: describeAnyId('key', binding),
        label: chord,
        doc: `${command}${whereBound(binding)}`,
        detail: 'key',
      })
    }
  }
  return candidates
}

/** The answer to a key a describe-any candidate names, as describe-key words it. */
export function describeBinding(registry: CommandRegistry, binding: Binding): string {
  const doc = registry.get(binding.command)?.doc ?? ''
  return `${binding.chord} runs ${binding.command}${whereBound(binding)}.\n${doc}`.trimEnd()
}

function whereBound(binding: Binding): string {
  if (binding.bufferType !== null) return ` in ${binding.bufferType} buffers`
  if (binding.mode !== undefined) return ` in ${binding.mode} mode`
  return ''
}

/** Splits a describe-any id into its kind and the rest, or null when it is not one. */
export function parseDescribeAnyId(id: string): { kind: DescribeKind; name: string } | null {
  const colon = id.indexOf(':')
  if (colon < 0) return null
  const kind = id.slice(0, colon)
  if (!['command', 'setting', 'mode', 'hook', 'key'].includes(kind)) return null
  return { kind: kind as DescribeKind, name: id.slice(colon + 1) }
}
