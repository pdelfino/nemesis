import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  editedValue,
  editExternally,
  editFocusedField,
  EXTERNAL_EDIT_FOLDER,
  type FieldEditDeps,
} from '../../src/main/external-editor'
import {
  decodeFieldWrite,
  MAX_FIELD_WRITE_CHARS,
  MAX_TEXT_CHARS,
  type FieldAnswer,
} from '../../src/shared/page-door'

/**
 * edit-with-external-editor (#178): the file the editor gets is ours, mode
 * 0600, and gone once the editor exits, whatever the exit; the field is read
 * and written through the door in pieces, and a refusal writes nothing.
 */

let scratch: string

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'nemesis-external-editor-'))
})

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true })
})

/** A fake editor: records the file's mode and argv, appends `!`, exits with `code`. */
function fakeEditor(code = 0): { readonly editor: string; readonly seen: string } {
  const seen = join(scratch, 'seen.json')
  const editor = join(scratch, 'editor.mjs')
  writeFileSync(
    editor,
    [
      '#!/usr/bin/env node',
      "import { appendFileSync, statSync, writeFileSync } from 'node:fs'",
      'const path = process.argv[2]',
      `writeFileSync(${JSON.stringify(seen)}, JSON.stringify({ args: process.argv.slice(2), mode: statSync(path).mode & 0o777 }))`,
      "appendFileSync(path, '!')",
      `process.exit(${code})`,
      '',
    ].join('\n'),
  )
  chmodSync(editor, 0o755)
  return { editor, seen }
}

describe('editExternally', () => {
  it('hands the editor a 0600 file of the profile, reads the edit, and deletes the file', async () => {
    const { editor, seen } = fakeEditor()
    const profileDir = join(scratch, 'profile')
    expect(await editExternally('a comment', { profileDir, editor })).toBe('a comment!')
    const recorded = JSON.parse(readFileSync(seen, 'utf8')) as { args: string[]; mode: number }
    expect(recorded.mode).toBe(0o600)
    expect(recorded.args).toHaveLength(1)
    expect(recorded.args[0]?.startsWith(join(profileDir, EXTERNAL_EDIT_FOLDER))).toBe(true)
    expect(readdirSync(join(profileDir, EXTERNAL_EDIT_FOLDER))).toEqual([])
  })

  it('deletes the file when the editor fails or cannot start', async () => {
    const profileDir = join(scratch, 'profile')
    await expect(
      editExternally('text', { profileDir, editor: fakeEditor(3).editor }),
    ).rejects.toThrow(/code 3/)
    expect(readdirSync(join(profileDir, EXTERNAL_EDIT_FOLDER))).toEqual([])
    await expect(
      editExternally('text', { profileDir, editor: join(scratch, 'no-such-editor') }),
    ).rejects.toThrow(/Could not start/)
    expect(readdirSync(join(profileDir, EXTERNAL_EDIT_FOLDER))).toEqual([])
  })
})

describe('editedValue', () => {
  it("drops the editor's final newline when the field had none", () => {
    expect(editedValue('one', 'one!\n')).toBe('one!')
    expect(editedValue('one', 'one!\r\n')).toBe('one!')
    expect(editedValue('one\n', 'one!\n')).toBe('one!\n')
    expect(editedValue('', 'two\nlines')).toBe('two\nlines')
  })
})

/** A page whose focused field holds `value`, through fakes of the door's three requests. */
function fakePage(value: string, status: FieldAnswer['status'] = 'ok') {
  let field = value
  let document = 1
  const writes: Array<ReturnType<typeof decodeFieldWrite>> = []
  const reads: number[] = []
  const deps = (edit: (text: string) => string): FieldEditDeps => ({
    field: () =>
      Promise.resolve({
        document,
        answer:
          status === 'ok'
            ? { status, element: 4, total: field.length, text: field.slice(0, MAX_TEXT_CHARS) }
            : { status, element: 0, total: 0, text: '' },
      }),
    text: (element, from, chars) => {
      reads.push(from)
      expect(element).toBe(4)
      return Promise.resolve({
        document,
        answer: { status: 'ok', total: field.length, text: field.slice(from, from + chars) },
      })
    },
    write: (args) => {
      const write = decodeFieldWrite(args)
      writes.push(write)
      field = (write.from === 0 ? '' : field) + write.text
      return Promise.resolve({ document, answer: { status: 'ok', total: field.length } })
    },
    document: () => document,
    edit: (text) => Promise.resolve(edit(text)),
  })
  return {
    deps,
    writes,
    reads,
    value: () => field,
    navigate: () => {
      document += 1
    },
  }
}

describe('editFocusedField', () => {
  it('writes the edit back into the same element', async () => {
    const page = fakePage('hello')
    expect(await editFocusedField(page.deps((text) => `${text}!\n`))).toMatch(/edited/)
    expect(page.value()).toBe('hello!')
    expect(page.writes).toEqual([{ element: 4, from: 0, last: true, text: 'hello!' }])
  })

  it('reads and writes a long value in pieces', async () => {
    const long = 'a'.repeat(MAX_TEXT_CHARS * 2 + 10)
    const page = fakePage(long)
    await editFocusedField(page.deps((text) => `${text}!`))
    expect(page.reads).toEqual([MAX_TEXT_CHARS, MAX_TEXT_CHARS * 2])
    expect(page.value()).toBe(`${long}!`)
    expect(page.writes.every((write) => write.text.length <= MAX_FIELD_WRITE_CHARS)).toBe(true)
    expect(page.writes.filter((write) => write.last)).toHaveLength(1)
    expect(page.writes.at(-1)?.last).toBe(true)
  })

  it('refuses a password field, and nothing focused, before the editor runs', async () => {
    for (const [status, notice] of [
      ['masked', /secret field/],
      ['none', /focus a text field/],
      ['readonly', /read-only/],
    ] as const) {
      const page = fakePage('', status)
      let ran = false
      await expect(
        editFocusedField(
          page.deps((text) => {
            ran = true
            return text
          }),
        ),
      ).rejects.toThrow(notice)
      expect(ran).toBe(false)
      expect(page.writes).toEqual([])
    }
  })

  it('writes nothing when the page navigated while the editor ran, or nothing changed', async () => {
    const page = fakePage('draft')
    await expect(
      editFocusedField(
        page.deps((text) => {
          page.navigate()
          return `${text}!`
        }),
      ),
    ).rejects.toThrow(/changed while it was edited/)
    expect(page.writes).toEqual([])
    expect(await editFocusedField(page.deps((text) => `${text}\n`))).toMatch(/unchanged/)
    expect(page.writes).toEqual([])
  })
})
