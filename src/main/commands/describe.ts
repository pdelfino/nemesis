import type { BufferType } from '../../shared/keys'
import type { KeyReading } from './dispatcher'
import type { Keymap } from './keymap'
import type { CommandRegistry } from './registry'

/**
 * The text of describe-command and describe-key (#65): a command's doc line
 * and the keys that run it, as the help buffer shows them. Pure functions over
 * the registry and the keymaps; the unit tests read them straight.
 */

/** One keymap and the buffers it applies to: null for the global map. */
export interface KeymapLayer {
  readonly keymap: Keymap
  readonly bufferType: BufferType | null
}

/** Every chord that runs `name`, with the buffer type it is bound in. */
export function bindingsOf(
  layers: readonly KeymapLayer[],
  name: string,
): readonly { chord: string; bufferType: BufferType | null }[] {
  const bindings = []
  for (const layer of layers) {
    for (const entry of layer.keymap.entries()) {
      if (entry.command === name)
        bindings.push({ chord: entry.chord, bufferType: layer.bufferType })
    }
  }
  return bindings
}

/** The chords that run `name`, as one short note for the palette: `C-x b`, `y (permission)`. */
export function bindingNote(layers: readonly KeymapLayer[], name: string): string {
  return bindingsOf(layers, name)
    .map(({ chord, bufferType }) => (bufferType === null ? chord : `${chord} (${bufferType})`))
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
    for (const { chord, bufferType } of bindings) {
      lines.push(
        bufferType === null
          ? `It is bound to ${chord}.`
          : `It is bound to ${chord} in ${bufferType} buffers.`,
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
