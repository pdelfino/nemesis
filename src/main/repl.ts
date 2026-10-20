import { readFile } from 'node:fs/promises'
import { extname, resolve } from 'node:path'
import type { AgentNoticeEvent } from './agent/events'
import type { BufferInfo } from '../shared/buffers'
import type { ReplContent } from '../shared/repl'
import type { BufferRegistry } from './buffers'
import type { EvalOutcome } from './config/eval'
import type { Journal, JournalEntry } from './config/journal'

/**
 * The `*repl*` buffer and the journal commands' state (#72). One `repl`
 * buffer in the registry, created by the `repl` command and reused, like the
 * help buffer; `RET` in it reads a form off the palette, and the form and its
 * value are added to the buffer's log, which is pushed to the window whole.
 * `eval-expression` evaluates the same way from anywhere and answers with a
 * notice in the transcript, as the echo area does in Emacs. `load-file`
 * (#182) evaluates a whole `.ts` or `.js` file the same way, as one form.
 *
 * The evaluator is src/main/config/eval.ts, given by the app; without one
 * (a unit test, a registry built from nothing) every form is refused.
 */

export const REPL_ELEMENT_ID = 'repl'

export const REPL_TITLE = '*repl*'

/** How many forms the buffer keeps: the oldest go first. */
const MAX_LOG = 200

export type ReplShownListener = (content: ReplContent) => void
export type ReplNoticeListener = (event: AgentNoticeEvent) => void

export interface ReplOptions {
  readonly evaluate?: (form: string) => Promise<EvalOutcome>
  /** Null under `--no-config`, or without the app. */
  readonly journal?: Journal | null
}

const NO_EVALUATOR: (form: string) => Promise<EvalOutcome> = () =>
  Promise.resolve({ ok: false, text: 'No evaluator is installed', defined: null, journal: null })

export class Repl {
  private readonly buffers: BufferRegistry
  private readonly evaluator: (form: string) => Promise<EvalOutcome>
  private readonly journal: Journal | null
  private readonly shown = new Set<ReplShownListener>()
  private readonly notices = new Set<ReplNoticeListener>()
  private readonly log: string[] = []
  private bufferId: string | null = null

  constructor(buffers: BufferRegistry, options: ReplOptions = {}) {
    this.buffers = buffers
    this.evaluator = options.evaluate ?? NO_EVALUATOR
    this.journal = options.journal ?? null
    buffers.subscribe((list) => {
      if (this.bufferId !== null && !list.buffers.some((buffer) => buffer.id === this.bufferId)) {
        this.bufferId = null
      }
    })
  }

  /** The bridge subscribes and pushes the log to the window. */
  onShown(listener: ReplShownListener): () => void {
    this.shown.add(listener)
    return () => {
      this.shown.delete(listener)
    }
  }

  /** The session bridge subscribes: a value or a journal note is shown and recorded like any event. */
  on(listener: ReplNoticeListener): () => void {
    this.notices.add(listener)
    return () => {
      this.notices.delete(listener)
    }
  }

  get buffer(): BufferInfo | null {
    return this.bufferId === null ? null : (this.buffers.get(this.bufferId) ?? null)
  }

  /** Opens the `*repl*` buffer, or goes back to it, and gives it the point. */
  open(): BufferInfo {
    const buffer =
      this.buffer ??
      this.buffers.create({ kind: 'repl', title: REPL_TITLE, elementId: REPL_ELEMENT_ID })
    this.bufferId = buffer.id
    this.push(buffer)
    this.buffers.switchTo(buffer.id)
    return buffer
  }

  /**
   * Evaluates one form and adds it and its value to the log. `echo` is
   * eval-expression's: the value is a notice in the transcript too. A
   * journal note is always a notice, so the mode line count is never the
   * only sign a form was kept.
   */
  async evaluate(form: string, echo: boolean): Promise<EvalOutcome> {
    const outcome = await this.evaluator(form)
    const value = outcome.ok ? `=> ${outcome.text}` : `!! ${outcome.text}`
    this.log.push(
      [`> ${form}`, value, ...(outcome.journal === null ? [] : [outcome.journal])].join('\n'),
    )
    if (this.log.length > MAX_LOG) this.log.splice(0, this.log.length - MAX_LOG)
    const buffer = this.buffer
    if (buffer !== null) this.push(buffer)
    if (echo) this.notify(value)
    if (outcome.journal !== null) this.notify(outcome.journal)
    return outcome
  }

  /**
   * `load-file` (#182): reads a `.ts` or `.js` file and evaluates its text as
   * one form, through the same evaluator, journal and notices as
   * eval-expression, so what the file defines is staged and checked like a
   * form. The value is echoed after a line naming the file.
   */
  async loadFile(path: string): Promise<EvalOutcome> {
    const file = resolve(path)
    const extension = extname(file)
    if (extension !== '.ts' && extension !== '.js') {
      const outcome = {
        ok: false,
        text: `Not loaded: ${file} is not a .ts or .js file`,
        defined: null,
        journal: null,
      }
      this.notify(outcome.text)
      return outcome
    }
    let source: string
    try {
      source = await readFile(file, 'utf8')
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      const outcome = { ok: false, text: `Not loaded: ${reason}`, defined: null, journal: null }
      this.notify(outcome.text)
      return outcome
    }
    this.notify(`Loading ${file}`)
    return this.evaluate(source, true)
  }

  /** The journal's entries, for the palette; none without a journal. */
  entries(): readonly JournalEntry[] {
    return this.journal?.list() ?? []
  }

  /** `journal-promote`: the entry goes to the end of init.ts. */
  promote(id: string): void {
    const journal = this.requireJournal()
    const entry = journal.promote(id)
    this.notify(
      `Promoted ${entry.summary} to init.ts: ${journal.count} unpromoted. M-x reload-config loads it from the file.`,
    )
  }

  /** `journal-discard`: the entry is deleted. What it defined stays live until a restart. */
  discard(id: string): void {
    const journal = this.requireJournal()
    const entry = journal.discard(id)
    this.notify(`Discarded ${entry.summary} from the journal: ${journal.count} unpromoted.`)
  }

  notify(text: string): void {
    const event: AgentNoticeEvent = { type: 'notice', text }
    for (const listener of [...this.notices]) listener(event)
  }

  private requireJournal(): Journal {
    if (this.journal === null) throw new Error('No journal: the app was started with --no-config')
    return this.journal
  }

  private push(buffer: BufferInfo): void {
    const text =
      this.log.length === 0
        ? 'Forms are evaluated in the config scope, with the same nemesis object as init.ts.'
        : this.log.join('\n\n')
    for (const listener of [...this.shown]) listener({ bufferId: buffer.id, text })
  }
}
