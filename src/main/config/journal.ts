import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * The eval journal (#72): `~/.config/nemesis/journal.org`, next to init.ts.
 * Every eval that defines or redefines a command or a binding is appended
 * here with a timestamp and the form, so a definition made in the running
 * image is never silently lost: `journal-promote` moves an entry to the end
 * of init.ts, `journal-discard` deletes it, and the mode line shows how many
 * are left. The file is Org, one heading per entry and the form in a source
 * block, so it reads and edits like any other note.
 *
 * The file is read on every call: an edit made by hand in between is what
 * the next list shows.
 */

export const JOURNAL_FILE = 'journal.org'

/** The journal of a config folder: beside init.ts. */
export function journalPath(configFile: string): string {
  return join(dirname(configFile), JOURNAL_FILE)
}

const HEADER = [
  '#+TITLE: Nemesis eval journal',
  '',
  'Definitions made at eval, not yet in init.ts. M-x journal-promote moves one',
  'to the end of init.ts; M-x journal-discard deletes one.',
  '',
].join('\n')

const BEGIN = '#+begin_src typescript'
const END = '#+end_src'

export interface JournalEntry {
  /** Its place in the file, 1 first: what the palette answers with. */
  readonly id: string
  /** The Org inactive timestamp, brackets included. */
  readonly at: string
  /** What the form defined: `command say-hi, binding C-c h`. */
  readonly summary: string
  readonly form: string
}

export class JournalError extends Error {
  override readonly name = 'JournalError'
}

export type JournalListener = (count: number) => void

export interface JournalOptions {
  /** The journal file. */
  readonly path: string
  /** The init.ts a promoted entry is appended to. */
  readonly configFile: string
  readonly now?: () => Date
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/** `[2026-10-18 Sun 22:16]`, local time, as Org writes an inactive timestamp. */
export function orgTimestamp(date: Date): string {
  const two = (value: number): string => String(value).padStart(2, '0')
  return `[${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ${
    WEEKDAYS[date.getDay()] ?? ''
  } ${two(date.getHours())}:${two(date.getMinutes())}]`
}

/** Org's comma escape: a line inside a block that would read as a heading or a keyword. */
function escapeLine(line: string): string {
  return /^,*(\*|#\+)/.test(line) ? `,${line}` : line
}

function unescapeLine(line: string): string {
  return /^,+(\*|#\+)/.test(line) ? line.slice(1) : line
}

/** The entries of a journal's text, in file order. */
export function parseJournal(text: string): JournalEntry[] {
  const entries: JournalEntry[] = []
  const lines = text.split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    const heading = /^\* (\[[^\]]*\]) ?(.*)$/.exec(lines[index] ?? '')
    if (heading === null) continue
    const begin = lines.findIndex((line, at) => at > index && line.trim() === BEGIN)
    const end = lines.findIndex((line, at) => at > begin && line.trim() === END)
    const next = lines.findIndex((line, at) => at > index && line.startsWith('* '))
    if (begin < 0 || end < 0 || (next >= 0 && begin > next)) continue
    entries.push({
      id: String(entries.length + 1),
      at: heading[1] ?? '',
      summary: heading[2] ?? '',
      form: lines
        .slice(begin + 1, end)
        .map(unescapeLine)
        .join('\n'),
    })
    index = end
  }
  return entries
}

/** A journal's text for these entries. */
export function renderJournal(entries: readonly Omit<JournalEntry, 'id'>[]): string {
  const blocks = entries.map((entry) =>
    [
      `* ${entry.at} ${entry.summary}`,
      BEGIN,
      ...entry.form.split('\n').map(escapeLine),
      END,
      '',
    ].join('\n'),
  )
  return [HEADER, ...blocks].join('\n')
}

export class Journal {
  private readonly options: JournalOptions
  private readonly listeners = new Set<JournalListener>()

  constructor(options: JournalOptions) {
    this.options = options
  }

  get path(): string {
    return this.options.path
  }

  /** The entries not yet promoted or discarded. */
  list(): JournalEntry[] {
    if (!existsSync(this.options.path)) return []
    return parseJournal(readFileSync(this.options.path, 'utf8'))
  }

  get count(): number {
    return this.list().length
  }

  /** The mode line follows the count. */
  on(listener: JournalListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  append(form: string, summary: string): JournalEntry {
    const entries = this.list()
    const entry: JournalEntry = {
      id: String(entries.length + 1),
      at: orgTimestamp((this.options.now ?? (() => new Date()))()),
      summary,
      form,
    }
    this.write([...entries, entry])
    return entry
  }

  /**
   * Appends the entry's form to the end of init.ts, with a comment naming
   * where it came from, then drops it from the journal. The file is written,
   * not loaded: reload-config loads it.
   */
  promote(id: string): JournalEntry {
    const entries = this.list()
    const entry = this.find(entries, id)
    const file = this.options.configFile
    mkdirSync(dirname(file), { recursive: true })
    const existing = existsSync(file) ? readFileSync(file, 'utf8') : ''
    const separator = existing.length === 0 ? '' : existing.endsWith('\n') ? '\n' : '\n\n'
    appendFileSync(
      file,
      `${separator}// Promoted from the eval journal, ${entry.at}: ${entry.summary}\n${entry.form}\n`,
    )
    this.write(entries.filter((candidate) => candidate !== entry))
    return entry
  }

  discard(id: string): JournalEntry {
    const entries = this.list()
    const entry = this.find(entries, id)
    this.write(entries.filter((candidate) => candidate !== entry))
    return entry
  }

  private find(entries: readonly JournalEntry[], id: string): JournalEntry {
    const entry = entries.find((candidate) => candidate.id === id)
    if (entry === undefined) throw new JournalError(`The journal has no entry ${id}`)
    return entry
  }

  private write(entries: readonly JournalEntry[]): void {
    mkdirSync(dirname(this.options.path), { recursive: true })
    writeFileSync(this.options.path, renderJournal(entries))
    for (const listener of [...this.listeners]) listener(entries.length)
  }
}
