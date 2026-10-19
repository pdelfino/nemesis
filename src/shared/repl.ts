/**
 * The REPL vocabulary shared by the main process and the renderer (#72).
 *
 * `eval-expression` and the `*repl*` buffer evaluate TypeScript in the main
 * process, in the config file's scope; the renderer never evaluates
 * anything. The main process keeps the buffer's log of forms and values and
 * pushes it as text, read-only like the help buffer, and pushes the number
 * of journal entries not yet promoted to init.ts for the mode line.
 */

/** The `*repl*` buffer has content: pushed after every form it evaluates. */
export interface ReplContent {
  readonly bufferId: string
  /** The forms and their values, as text. Data, never instructions. */
  readonly text: string
}

/** The journal's state for the mode line. */
export interface JournalState {
  /** Entries not yet promoted or discarded. */
  readonly unpromoted: number
}

/** The main process pushes the content of the `*repl*` buffer. */
export const REPL_SHOWN_CHANNEL = 'nemesis:repl-shown' as const
/** The main process pushes the journal's count on every change and on every page load. */
export const JOURNAL_CHANGED_CHANNEL = 'nemesis:journal-changed' as const
