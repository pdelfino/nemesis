import type { PaletteSource, Prompter } from './prompter'

/**
 * A yes or no read through the prompt buffer (#51, SECURITY.org T2). The
 * download and external-protocol policies in src/main/security ask the user
 * before anything lands on disk or launches, and so does a diff buffer
 * before its file goes to the system (#68); they know nothing of the
 * palette, only a function that answers true or false. This file is that
 * function and the three fixed sources it reads from.
 *
 * The no comes first in both sources, so it is the highlighted candidate
 * when the read opens: a stray `RET` refuses, and a yes takes a deliberate
 * step (type a letter of it, or `C-n`). `C-g`, and any newer read taking the
 * palette, are a no as well. The details of what is asked (filename, size,
 * origin, URL) are the prompt line, never a candidate: candidates are the
 * app's words, the prompt carries the page's.
 */

export const DOWNLOAD_SOURCE = 'download'
export const EXTERNAL_SOURCE = 'external'
/** A diff buffer's `C-c C-o` asks before the file goes to the system (#68). */
export const OPEN_FILE_SOURCE = 'open-file'

/** What a yes answers with; anything else is a no. */
const YES = 'yes'
const NO = 'no'

export const CONFIRM_SOURCES: readonly PaletteSource[] = [
  {
    name: DOWNLOAD_SOURCE,
    candidates: () => [
      { id: NO, label: 'Do not download', doc: 'Nothing is written.' },
      {
        id: YES,
        label: 'Save to nemesis-quarantine',
        doc: 'The file lands in ~/Downloads/nemesis-quarantine with the quarantine attribute, and is not opened.',
      },
    ],
  },
  {
    name: EXTERNAL_SOURCE,
    candidates: () => [
      { id: NO, label: 'Do not open', doc: 'Nothing is launched.' },
      {
        id: YES,
        label: 'Open with the system handler',
        doc: 'The link is handed to the application the system has for it.',
      },
    ],
  },
  {
    name: OPEN_FILE_SOURCE,
    candidates: () => [
      { id: NO, label: 'Do not open', doc: 'Nothing is launched.' },
      {
        id: YES,
        label: 'Open with the default application',
        doc: 'The file is handed to the application the system has for it; the cockpit does not run it.',
      },
    ],
  },
]

/** True only when the user picked the yes candidate; a cancel is false. */
export function confirm(prompter: Prompter, source: string, prompt: string): Promise<boolean> {
  return new Promise((resolve) => {
    prompter.read({ source, prompt, onCancel: () => resolve(false) }, (choice) => {
      resolve(choice === YES)
    })
  })
}
