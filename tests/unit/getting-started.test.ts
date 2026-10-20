import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { normalizeChord, type Keymap } from '../../src/main/commands/keymap'
import {
  BUFFER_KEYMAPS,
  cockpitModes,
  GLOBAL_KEYMAP,
  MODE_KEYMAPS,
} from '../../src/main/commands/keyscheme'

/** docs/getting-started.org (#145): a chord the guide names must exist in the keyscheme. */
const doc = readFileSync(join(__dirname, '..', '..', 'docs', 'getting-started.org'), 'utf8')

/** The guide's prose and tables, without the example init.ts, whose chords are the user's own. */
const prose = doc.replace(/#\+begin_src[\s\S]*?#\+end_src/g, '')

const keymaps: readonly Keymap[] = [
  GLOBAL_KEYMAP,
  ...Object.values(BUFFER_KEYMAPS),
  ...Object.values(MODE_KEYMAPS).map((mode) => mode.keymap),
  ...cockpitModes.list().flatMap((mode) => (mode.layer === null ? [] : [mode.layer])),
]
const bound = new Set(keymaps.flatMap((keymap) => keymap.entries().map((e) => e.chord)))
const prefixes = new Set(keymaps.flatMap((keymap) => keymap.shape().prefixes))

/** Every `=C-...=` and `=M-...=` span: one stroke or a chord of several, spaces between. */
const chords = [
  ...new Set(
    [...prose.matchAll(/=([^=\n]+)=/g)]
      .map((match) => match[1] ?? '')
      .filter((span) => /^[CM]-\S+( \S+)*$/.test(span) && !span.startsWith('M-x ')),
  ),
]

describe('docs/getting-started.org', () => {
  it('names some chords', () => {
    expect(chords.length).toBeGreaterThan(20)
  })

  it.each(chords)('%s is bound in the keyscheme, or is the prefix of a bound chord', (chord) => {
    const normal = normalizeChord(chord)
    expect(bound.has(normal) || prefixes.has(normal), `${chord} is not in keyscheme.ts`).toBe(true)
  })

  it('describes C-c C-r per buffer: reader-mode in a page, review-diff elsewhere', () => {
    expect(BUFFER_KEYMAPS.page?.commandFor('C-c C-r')).toBe('reader-mode')
    expect(GLOBAL_KEYMAP.commandFor('C-c C-r')).toBe('review-diff')
    for (const type of ['prompt', 'transcript', 'plan', 'reader'] as const) {
      expect(BUFFER_KEYMAPS[type]?.commandFor('C-c C-r'), type).not.toBe('reader-mode')
    }
    expect(doc).toContain('=reader-mode=, the page as text')
    expect(doc).toContain('=review-diff=, a reviewer window')
  })

  it('binds the page tools it teaches where it says', () => {
    const page = BUFFER_KEYMAPS.page
    expect(page?.commandFor('C-c C-s')).toBe('show-semantic-view')
    expect(page?.commandFor('C-c C-w')).toBe('form-guide-mode')
    expect(page?.commandFor('C-c S')).toBe('share-page')
    const modes = (name: string) => Object.values(MODE_KEYMAPS).find((m) => m.keymap.name === name)
    expect(modes('document')?.keymap.commandFor('f')).toBe('follow-hint')
    expect(modes('document')?.keymap.commandFor('F')).toBe('copy-hint-url')
    expect(cockpitModes.get('form-guide')?.layer?.commandFor('C-c C-y')).toBe('form-guide-accept')
    expect(GLOBAL_KEYMAP.commandFor('C-x 5 F')).toBe('toggle-full-screen')
  })

  it('has no em-dash and points at docs/mcp.org', () => {
    expect(doc).not.toContain('—')
    expect(doc).toContain('docs/mcp.org')
    expect(doc).toContain('--no-restore')
  })
})
