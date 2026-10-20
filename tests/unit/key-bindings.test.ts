import { describe, expect, it } from 'vitest'
import { createCockpitDispatcher } from '../../src/main/commands/keyscheme'
import { defineKeymap } from '../../src/main/commands/keymap'
import type { KeyBindings } from '../../src/shared/keys'
import { startsCockpitChord } from '../../src/shared/keys'

// The main process publishes the shape of its keymaps, never the commands, so
// the renderer can leave every unbound key to the editor under it (#61).

describe('the shape of a keymap', () => {
  it('lists the chords and every proper prefix of a sequence', () => {
    expect(
      defineKeymap('x', { 'C-x b': 'a', 'C-x k': 'b', 'C-c C-c': 'c', 'M-x': 'd' }).shape(),
    ).toEqual({
      chords: ['C-c C-c', 'C-x b', 'C-x k', 'M-x'],
      prefixes: ['C-c', 'C-x'],
    })
  })

  it('is what the cockpit dispatcher publishes', () => {
    const bindings = createCockpitDispatcher().bindings
    expect(bindings.global.chords).toEqual([
      'C-c C-c',
      'C-c C-e',
      'C-c C-i',
      'C-c C-k',
      'C-c C-l',
      'C-c C-n',
      'C-c C-p',
      'C-c C-r',
      'C-c C-u',
      'C-c C-v',
      'C-g',
      'C-h b',
      'C-h k',
      'C-h x',
      'C-s',
      'C-x 5 2',
      'C-x 5 a',
      'C-x 5 F',
      'C-x 5 w',
      'C-x b',
      'C-x k',
      'C-x n',
      'C-x s',
      'M-x',
    ])
    expect(bindings.global.prefixes).toEqual(['C-c', 'C-h', 'C-x', 'C-x 5'])
    expect(bindings.byBufferType.permission).toEqual({
      chords: ['1', '2', '3', '4', 'a', 'n', 'y'],
      prefixes: [],
    })
    // The plan buffer's own send and compact keys (#82).
    expect(bindings.byBufferType.plan).toEqual({
      chords: ['C-c C-c', 'C-c C-k'],
      prefixes: ['C-c'],
    })
    expect(JSON.stringify(bindings)).not.toContain('switch-buffer')
  })
})

describe('what the renderer hands over', () => {
  const bindings: KeyBindings = {
    global: { chords: ['C-c C-c', 'C-g', 'M-x'], prefixes: ['C-c'] },
    byBufferType: { permission: { chords: ['y'], prefixes: [] } },
  }

  it('takes a bound chord or a prefix of one, in any buffer', () => {
    expect(startsCockpitChord('C-g', bindings, null)).toBe(true)
    expect(startsCockpitChord('C-c', bindings, 'prompt')).toBe(true)
    expect(startsCockpitChord('M-x', bindings, 'transcript')).toBe(true)
  })

  it('leaves the editor its own Emacs keys', () => {
    for (const token of ['C-a', 'C-e', 'C-k', 'M-f', 'M-p', 'C-y', 'a', 'RET']) {
      expect(startsCockpitChord(token, bindings, 'prompt')).toBe(false)
    }
  })

  it('consults the buffer-type map before the global one', () => {
    expect(startsCockpitChord('y', bindings, 'permission')).toBe(true)
    expect(startsCockpitChord('y', bindings, 'prompt')).toBe(false)
    expect(startsCockpitChord('y', bindings, null)).toBe(false)
  })
})
