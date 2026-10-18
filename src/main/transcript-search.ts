import { createReadStream } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import type { TranscriptGoto } from '../shared/agent'
import { TRANSCRIPT_FILE } from './transcripts'

/**
 * Search across transcripts (#69): every `session.org` the recorder wrote
 * (src/main/transcripts.ts), streamed line by line, for a case-insensitive
 * substring. No index in version 1: the folder is the index, and the cost of
 * a search is one pass over the files, newest first, stopped at the match
 * cap. A line is reported as the window shows it, with Org's comma escape
 * undone, so the transcript buffer can find it again after the session is
 * resumed; the structure lines of the file (headings, keywords, block
 * fences) are not searched, since they are not in the window.
 *
 * `searchTranscripts` is pure over a directory, so the unit tests run it
 * over fixture folders. `TranscriptSearch` holds the last result for the
 * palette read that follows, and the jump to the match the window makes
 * once the session is shown again, pushed the way the help text is.
 */

/** A search stops after this many matches; the folder is a knowledge base, not a log. */
export const MAX_MATCHES = 200

/** A match line longer than this is shown as a window around the match. */
const EXCERPT_LENGTH = 80
/** How much of the line before the match the window keeps. */
const EXCERPT_LEAD = 20

export interface TranscriptMatch {
  /** The folder name: the SDK's session id, which a resume takes. */
  readonly sessionId: string
  /** The first prompt of the session, as its first heading has it. */
  readonly title: string
  /** When the turn the line belongs to started, `YYYY-MM-DD HH:MM`, or empty. */
  readonly date: string
  /** The line's number in the file, from 1. */
  readonly line: number
  /** The whole line as the window shows it: Org's comma escape undone. */
  readonly text: string
  /** The line cut to fit a palette row, around the match. */
  readonly excerpt: string
}

/** A turn heading: `* [2026-10-17 Fri 14:03] first line of the prompt`. */
const TURN_HEADING = /^\* \[(\d{4}-\d{2}-\d{2}) \w{3} (\d{2}:\d{2})\] ?(.*)$/
/** The file's own date: `#+date: [2026-10-17 Fri 14:03]`. */
const DATE_KEYWORD = /^#\+date: \[(\d{4}-\d{2}-\d{2}) \w{3} (\d{2}:\d{2})\]/
/** A line Org reads as structure, and the recorder never escaped: not searched. */
const STRUCTURE = /^(\*+ |#\+)/

/** The inverse of `escapeOrg` in transcripts.ts: one leading comma off a line it escaped. */
export function unescapeOrg(line: string): string {
  return line.replace(/^,(?=,*(\*+ |#\+))/, '')
}

/** The line cut to fit a palette row, with the match in view. */
export function excerptAround(text: string, index: number): string {
  if (text.length <= EXCERPT_LENGTH) return text.trim()
  const start = Math.max(0, index - EXCERPT_LEAD)
  const end = Math.min(text.length, start + EXCERPT_LENGTH)
  const head = start > 0 ? '...' : ''
  const tail = end < text.length ? '...' : ''
  return `${head}${text.slice(start, end).trim()}${tail}`
}

/** What a palette row reads: the session's first prompt, the date, the line. */
export function describeMatch(match: TranscriptMatch): string {
  return [match.title, match.date, match.excerpt].filter((part) => part.length > 0).join(' · ')
}

/**
 * Every match of `query` in the sessions folder, newest session first (by
 * the transcript's modification time, the last turn written), in line order
 * within a session, at most MAX_MATCHES of them. An empty query, a missing
 * folder and an unreadable file all match nothing.
 */
export async function searchTranscripts(
  sessionsDir: string,
  query: string,
): Promise<TranscriptMatch[]> {
  const needle = query.toLowerCase()
  if (needle.length === 0) return []
  const matches: TranscriptMatch[] = []
  for (const folder of await transcriptFolders(sessionsDir)) {
    const room = MAX_MATCHES - matches.length
    if (room <= 0) break
    matches.push(...(await scanTranscript(sessionsDir, folder, needle, room)))
  }
  return matches
}

interface TranscriptFolder {
  readonly name: string
  readonly modifiedAt: number
}

/** The folders with a transcript, newest first; a folder without one is not a session. */
async function transcriptFolders(sessionsDir: string): Promise<string[]> {
  let entries
  try {
    entries = await readdir(sessionsDir, { withFileTypes: true })
  } catch {
    // No sessions folder yet: nothing has been recorded.
    return []
  }
  const folders: TranscriptFolder[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    try {
      const info = await stat(join(sessionsDir, entry.name, TRANSCRIPT_FILE))
      folders.push({ name: entry.name, modifiedAt: info.mtimeMs })
    } catch {
      continue
    }
  }
  return folders
    .sort((a, b) => b.modifiedAt - a.modifiedAt || a.name.localeCompare(b.name))
    .map((folder) => folder.name)
}

interface FoundLine {
  readonly date: string
  readonly line: number
  readonly text: string
  readonly excerpt: string
}

/**
 * One file, streamed: the matching lines with the date of the turn they are
 * in. The title is the first turn heading, learned on the way and applied
 * at the end, so a line before any prompt still names its session.
 */
async function scanTranscript(
  sessionsDir: string,
  sessionId: string,
  needle: string,
  limit: number,
): Promise<TranscriptMatch[]> {
  const found: FoundLine[] = []
  let title: string | null = null
  let fileDate = ''
  let date = ''
  let number = 0
  const input = createReadStream(join(sessionsDir, sessionId, TRANSCRIPT_FILE), {
    encoding: 'utf8',
  })
  const lines = createInterface({ input, crlfDelay: Infinity })
  try {
    for await (const raw of lines) {
      number += 1
      const heading = TURN_HEADING.exec(raw)
      if (heading !== null) {
        date = `${heading[1]} ${heading[2]}`
        title ??= heading[3] ?? ''
        continue
      }
      const keyword = DATE_KEYWORD.exec(raw)
      if (keyword !== null) fileDate = `${keyword[1]} ${keyword[2]}`
      if (STRUCTURE.test(raw)) continue
      const text = unescapeOrg(raw)
      const index = text.toLowerCase().indexOf(needle)
      if (index === -1) continue
      found.push({
        date: date.length > 0 ? date : fileDate,
        line: number,
        text,
        excerpt: excerptAround(text, index),
      })
      if (found.length >= limit) break
    }
  } catch {
    // A file that cannot be read matches nothing; the rest of the folder still does.
    return []
  } finally {
    lines.close()
    input.destroy()
  }
  const sessionTitle = title === null || title.length === 0 ? '(no prompt)' : title
  return found.map((line) => ({ sessionId, title: sessionTitle, ...line }))
}

export type TranscriptGotoListener = (target: TranscriptGoto) => void

export interface TranscriptSearchOptions {
  /** The sessions folder from the settings; null when none is wired, as in the unit tests. */
  readonly sessionsDir: string | null
}

/**
 * The search as the commands use it (#69): runs one, keeps the result for
 * the read that lists it, and tells the window which line to go to once the
 * session is shown again. The matches are kept in memory only, and only
 * until the next search.
 */
export class TranscriptSearch {
  private readonly sessionsDir: string | null
  private readonly listeners = new Set<TranscriptGotoListener>()
  private matchesValue: readonly TranscriptMatch[] = []

  constructor(options: TranscriptSearchOptions) {
    this.sessionsDir = options.sessionsDir
  }

  /** The result of the last search, what the `matches` source lists. */
  get matches(): readonly TranscriptMatch[] {
    return this.matchesValue
  }

  async search(query: string): Promise<readonly TranscriptMatch[]> {
    this.matchesValue =
      this.sessionsDir === null ? [] : await searchTranscripts(this.sessionsDir, query)
    return this.matchesValue
  }

  /** The bridge subscribes and pushes the jump to the window. */
  on(listener: TranscriptGotoListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** Asks the window to put the transcript's point on the match's line. */
  goTo(match: TranscriptMatch): void {
    const target: TranscriptGoto = { text: match.text }
    for (const listener of [...this.listeners]) listener(target)
  }
}
