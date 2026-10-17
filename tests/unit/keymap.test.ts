import { describe, expect, it } from 'vitest'
import type { KeyPress } from '../../src/shared/keys'
import {
  defineKeymap,
  formatChord,
  formatStroke,
  KeymapError,
  KeyResolver,
  normalizeChord,
  parseChord,
  parseStroke,
  strokeFromKeyPress,
} from '../../src/main/commands/keymap'

function press(key: string, options: Partial<KeyPress> = {}): KeyPress {
  return {
    key,
    code: '',
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    metaKey: false,
    bufferType: null,
    ...options,
  }
}

function strokeText(keyPress: KeyPress): string {
  const stroke = strokeFromKeyPress(keyPress)
  return stroke === null ? 'none' : formatStroke(stroke)
}

describe('Emacs chord notation (#59)', () => {
  it('parses the modifiers in any order and prints one canonical form', () => {
    expect(formatStroke(parseStroke('C-x'))).toBe('C-x')
    expect(formatStroke(parseStroke('M-C-x'))).toBe('C-M-x')
    expect(formatStroke(parseStroke('s-M-C-x'))).toBe('C-M-s-x')
    expect(normalizeChord('M-C-x   C-s')).toBe('C-M-x C-s')
  })

  it('parses the named keys and the characters that look like modifiers', () => {
    expect(parseStroke('RET')).toMatchObject({ key: 'RET', control: false })
    expect(formatStroke(parseStroke('C-<up>'))).toBe('C-<up>')
    expect(formatStroke(parseStroke('S-TAB'))).toBe('S-TAB')
    expect(formatStroke(parseStroke('<f12>'))).toBe('<f12>')
    expect(formatStroke(parseStroke('C--'))).toBe('C--')
    expect(formatStroke(parseStroke('s-s'))).toBe('s-s')
  })

  it('parses a sequence of strokes', () => {
    expect(formatChord(parseChord('C-c C-c'))).toBe('C-c C-c')
    expect(parseChord('C-x C-s')).toHaveLength(2)
  })

  it('rejects what it cannot bind', () => {
    expect(() => parseStroke('C-')).toThrow(KeymapError)
    expect(() => parseStroke('C-foo')).toThrow(/Unknown key/)
    // Shift on a character is written as the shifted character, as in Emacs.
    expect(() => parseStroke('S-a')).toThrow(/named key/)
    expect(() => parseChord('   ')).toThrow(/Empty chord/)
  })
})

describe('key presses become strokes', () => {
  it('reads the modifiers the renderer reported', () => {
    expect(strokeText(press('x', { ctrlKey: true, code: 'KeyX' }))).toBe('C-x')
    expect(strokeFromKeyPress(press('Enter'))).toMatchObject({ key: 'RET' })
    expect(strokeFromKeyPress(press(' '))).toMatchObject({ key: 'SPC' })
    expect(strokeFromKeyPress(press('Tab', { shiftKey: true }))).toMatchObject({
      key: 'TAB',
      shift: true,
    })
  })

  it('leaves the shift of a printable character in the character', () => {
    expect(strokeFromKeyPress(press('A', { shiftKey: true, code: 'KeyA' }))).toMatchObject({
      key: 'A',
      shift: false,
    })
  })

  it('falls back to the physical key when Option rewrote the character', () => {
    // macOS turns Option-x into the character the layout prints.
    expect(strokeText(press('≈', { altKey: true, code: 'KeyX' }))).toBe('M-x')
  })

  it('ignores a bare modifier key', () => {
    expect(strokeFromKeyPress(press('Control', { ctrlKey: true }))).toBeNull()
  })
})

describe('keymaps reject conflicts when they are built', () => {
  it('refuses two bindings for the same chord', () => {
    expect(() => defineKeymap('test', { 'C-x': 'one', 'C-x ': 'two' })).toThrow(/already bound/)
  })

  it('refuses a binding no key sequence could ever reach', () => {
    expect(() => defineKeymap('test', { 'C-x': 'one', 'C-x b': 'two' })).toThrow(/can never run/)
  })

  it('refuses to bind a prefix of an existing binding', () => {
    expect(() => defineKeymap('test', { 'C-x b': 'two', 'C-x': 'one' })).toThrow(/is a prefix/)
  })

  it('lists its bindings sorted, for the palette and describe-bindings', () => {
    const keymap = defineKeymap('test', { 'M-x': 'palette', 'C-x b': 'switch' })
    expect(keymap.entries()).toEqual([
      { chord: 'C-x b', command: 'switch' },
      { chord: 'M-x', command: 'palette' },
    ])
    expect(keymap.commandFor('M-x')).toBe('palette')
    expect(keymap.commandFor('C-x')).toBeUndefined()
  })

  it('knows a prefix from a binding from nothing', () => {
    const keymap = defineKeymap('test', { 'C-x b': 'switch' })
    expect(keymap.lookup(['C-x'])).toEqual({ kind: 'prefix' })
    expect(keymap.lookup(['C-x', 'b'])).toEqual({ kind: 'command', command: 'switch' })
    expect(keymap.lookup(['C-x', 'z'])).toEqual({ kind: 'none' })
  })
})

describe('the resolver holds the half-typed sequence', () => {
  const global = defineKeymap('global', {
    'C-x b': 'switch-buffer',
    'C-c C-k': 'cancel-request',
    'C-s': 'search-buffer',
    'C-g': 'keyboard-quit',
  })
  const permission = defineKeymap('permission', { y: 'answer-yes', 'C-s': 'save-answer' })

  function resolver(): KeyResolver {
    return new KeyResolver({ global, byBufferType: { permission }, abort: 'C-g' })
  }

  it('waits for the rest of a prefix sequence', () => {
    const keys = resolver()
    expect(keys.resolve(parseStroke('C-x'))).toEqual({ kind: 'pending', chord: 'C-x' })
    expect(keys.pending).toBe('C-x')
    expect(keys.resolve(parseStroke('b'))).toEqual({
      kind: 'command',
      command: 'switch-buffer',
      chord: 'C-x b',
    })
    expect(keys.pending).toBeNull()
  })

  it('drops an unbound sequence and starts over', () => {
    const keys = resolver()
    keys.resolve(parseStroke('C-x'))
    expect(keys.resolve(parseStroke('z'))).toEqual({ kind: 'unbound', chord: 'C-x z' })
    expect(keys.pending).toBeNull()
    expect(keys.resolve(parseStroke('C-s'))).toMatchObject({ command: 'search-buffer' })
  })

  it('lets C-g abandon the sequence and still quit', () => {
    const keys = resolver()
    keys.resolve(parseStroke('C-x'))
    expect(keys.resolve(parseStroke('C-g'))).toEqual({
      kind: 'command',
      command: 'keyboard-quit',
      chord: 'C-g',
    })
    expect(keys.pending).toBeNull()
  })

  it('gives the buffer-type map the first word', () => {
    const keys = resolver()
    expect(keys.resolve(parseStroke('C-s'), 'permission')).toMatchObject({
      command: 'save-answer',
    })
    expect(keys.resolve(parseStroke('y'), 'permission')).toMatchObject({ command: 'answer-yes' })
    // The same keys in another buffer fall through to the global map.
    expect(keys.resolve(parseStroke('C-s'), 'prompt')).toMatchObject({ command: 'search-buffer' })
    expect(keys.resolve(parseStroke('y'), 'prompt')).toEqual({ kind: 'unbound', chord: 'y' })
  })

  it('still completes a global sequence the buffer map only begins', () => {
    const buffer = defineKeymap('prompt', { 'C-c C-c': 'send-prompt' })
    const keys = new KeyResolver({ global, byBufferType: { prompt: buffer } })
    expect(keys.resolve(parseStroke('C-c'), 'prompt')).toEqual({ kind: 'pending', chord: 'C-c' })
    expect(keys.resolve(parseStroke('C-k'), 'prompt')).toMatchObject({ command: 'cancel-request' })
    expect(keys.resolve(parseStroke('C-c'), 'prompt')).toEqual({ kind: 'pending', chord: 'C-c' })
    expect(keys.resolve(parseStroke('C-c'), 'prompt')).toMatchObject({ command: 'send-prompt' })
  })
})
