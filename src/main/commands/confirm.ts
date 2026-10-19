import type { PaletteSource, Prompter } from './prompter'

/**
 * A yes or no read through the prompt buffer (#51, SECURITY.org T2). The
 * download and external-protocol policies in src/main/security ask the user
 * before anything lands on disk or launches, so does a diff buffer before
 * its file goes to the system (#68), and so does the verify key before a
 * command that came from an attached issue runs in a shell (#98), and so does
 * the rewind command before the files or the conversation go back to a
 * checkpoint (#99), and so does closing a worktree window before its folder
 * goes (#87); they know nothing of the palette, only a function that
 * answers true or false. This file is that function and the six fixed
 * sources it reads from.
 *
 * The no comes first in every source, so it is the highlighted candidate
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
/** `C-c C-v` asks before a command from an attached issue, remote text, runs in a shell (#98). */
export const VERIFY_SOURCE = 'verify'
/** `rewind` asks before the working tree or the conversation goes back to a checkpoint (#99). */
export const REWIND_SOURCE = 'rewind'

/** Closing a worktree window asks whether to remove the worktree; keeping it is the highlighted answer (#87). */
export const WORKTREE_SOURCE = 'worktree'

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
  {
    name: VERIFY_SOURCE,
    candidates: () => [
      { id: NO, label: 'Do not run', doc: 'Nothing runs and no evidence is recorded.' },
      {
        id: YES,
        label: 'Run it with your permissions',
        doc: 'The command runs in a shell as a child of the cockpit, outside the agent; the yes holds for this session while the issue is unchanged.',
      },
    ],
  },
  {
    name: REWIND_SOURCE,
    candidates: () => [
      {
        id: NO,
        label: 'Do not restore',
        doc: 'Nothing changes; the checkpoints stay as they are.',
      },
      {
        id: YES,
        label: 'Restore',
        doc: 'The files listed go back to their state at the checkpoint, or the conversation to before it, as the question says.',
      },
    ],
  },
  {
    name: WORKTREE_SOURCE,
    candidates: () => [
      {
        id: NO,
        label: 'Keep the worktree',
        doc: 'The folder and its branch stay as they are.',
      },
      {
        id: YES,
        label: 'Remove the worktree',
        doc: 'git worktree remove, only when git status shows nothing uncommitted; the branch stays.',
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
