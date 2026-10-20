import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  encodeFieldWrite,
  MAX_FIELD_WRITE_CHARS,
  MAX_TEXT_CHARS,
  type FieldAnswer,
  type FieldStatus,
  type FieldWriteAnswer,
  type TextAnswer,
} from '../shared/page-door'

/**
 * edit-with-external-editor (#178, option A): a page field's text in the
 * user's own editor. The text goes to a file of ours, mode 0600, in a folder
 * of the profile; the editor (the `externalEditor` setting, `emacsclient` by
 * default) is spawned with that one path as its only argument, no shell; and
 * when it exits the file is read back and deleted, whatever happened.
 * `emacsclient` waits for the buffer to be finished with `C-x #`, so its exit
 * is the save.
 */

/** The folder of the profile the files live in while they are edited. */
export const EXTERNAL_EDIT_FOLDER = 'external-edit'

export interface ExternalEditOptions {
  /** The profile folder; the file goes in EXTERNAL_EDIT_FOLDER under it. */
  readonly profileDir: string
  /** The editor program, spawned with the file's path and nothing else. */
  readonly editor: string
}

/** The editor's exit, or its failure to start. */
function waitFor(editor: string, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(editor, [path], { stdio: 'ignore', shell: false })
    child.once('error', (error) => reject(new Error(`Could not start ${editor}: ${error.message}`)))
    child.once('exit', (code, signal) => {
      if (code === 0) resolve()
      else reject(new Error(`${editor} exited with ${signal ?? `code ${String(code)}`}`))
    })
  })
}

/** The text as the editor left it when it exited; the file is gone before this settles. */
export async function editExternally(text: string, options: ExternalEditOptions): Promise<string> {
  const dir = join(options.profileDir, EXTERNAL_EDIT_FOLDER)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const path = join(dir, `${randomUUID()}.txt`)
  try {
    writeFileSync(path, text, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    await waitFor(options.editor, path)
    return readFileSync(path, 'utf8')
  } finally {
    rmSync(path, { force: true })
  }
}

/**
 * What goes back into the field: an editor's final newline, which the field
 * did not have, is dropped, so a one-line field keeps one line.
 */
export function editedValue(before: string, after: string): string {
  if (after.endsWith('\n') && !before.endsWith('\n')) {
    return after.slice(0, after.endsWith('\r\n') ? -2 : -1)
  }
  return after
}

/** A door answer and the document number it was read under (cockpit.ts's `askDocument`). */
export interface DocumentAnswer<A> {
  readonly answer: A
  readonly document: number
}

/** The door requests one edit makes on the current page, and the editor. */
export interface FieldEditDeps {
  readonly field: () => Promise<DocumentAnswer<FieldAnswer>>
  readonly text: (
    element: number,
    from: number,
    chars: number,
  ) => Promise<DocumentAnswer<TextAnswer>>
  readonly write: (args: readonly number[]) => Promise<DocumentAnswer<FieldWriteAnswer>>
  /** The page's document number now: a navigation while the editor ran makes a new one. */
  readonly document: () => number
  readonly edit: (text: string) => Promise<string>
}

/** Why a field is not edited, as the notice says it. */
export function fieldRefusal(status: Exclude<FieldStatus, 'ok'>): string {
  switch (status) {
    case 'none':
      return 'Nothing to edit: focus a text field of the page first'
    case 'masked':
      return 'Not sent to the editor: a password or other secret field is typed by hand'
    case 'readonly':
      return 'Not sent to the editor: the field is read-only'
    case 'gone':
    case 'changed':
      return 'Not written back: the field changed while it was edited'
  }
}

/**
 * The focused field of a page through the door: its value read whole, in
 * pieces past MAX_TEXT_CHARS, edited, and written back in pieces into the
 * same element of the same document. Resolves with a notice; rejects with
 * an Error whose message is the notice of a refusal or a failure.
 */
export async function editFocusedField(deps: FieldEditDeps): Promise<string> {
  const read = await deps.field()
  if (read.answer.status !== 'ok') throw new Error(fieldRefusal(read.answer.status))
  const { element, total } = read.answer
  let before = read.answer.text
  while (before.length < total) {
    const piece = await deps.text(element, before.length, MAX_TEXT_CHARS)
    if (
      piece.document !== read.document ||
      piece.answer.status !== 'ok' ||
      piece.answer.text === ''
    )
      throw new Error(fieldRefusal('changed'))
    before += piece.answer.text
  }
  const after = editedValue(before, await deps.edit(before))
  if (after === before) return 'The field is unchanged'
  if (deps.document() !== read.document) throw new Error(fieldRefusal('changed'))
  let from = 0
  let at = 0
  do {
    const text = after.slice(at, at + MAX_FIELD_WRITE_CHARS)
    at += text.length
    const last = at >= after.length
    const wrote = await deps.write(encodeFieldWrite({ element, from, last, text }))
    if (wrote.document !== read.document) throw new Error(fieldRefusal('changed'))
    if (wrote.answer.status !== 'ok') throw new Error(fieldRefusal(wrote.answer.status))
    from = wrote.answer.total
  } while (at < after.length)
  return 'The field holds the edited text'
}
