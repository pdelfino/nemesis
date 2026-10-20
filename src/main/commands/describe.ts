import type { BufferType } from '../../shared/keys'
import type { KeyReading } from './dispatcher'
import type { Keymap } from './keymap'
import type { CommandRegistry } from './registry'

/**
 * The text of describe-command and describe-key (#65): a command's doc line
 * and the keys that run it, as the help buffer shows them. Pure functions over
 * the registry and the keymaps; the unit tests read them straight.
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

export function describeKey(registry: CommandRegistry, reading: KeyReading): string {
  const where = reading.bufferType === null ? '' : ` in a ${reading.bufferType} buffer`
  if (reading.command === null) return `${reading.chord} is not bound${where}.`
  const doc = registry.get(reading.command)?.doc ?? ''
  return `${reading.chord} runs ${reading.command}${where}.\n${doc}`.trimEnd()
}
