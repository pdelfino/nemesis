import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, statSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentEvent, AgentQuestion } from './agent/events'

/**
 * Transcripts on disk (#64). Every session is a folder under the sessions dir,
 * named by the SDK's session id, with two files written as the events arrive:
 *
 *   events.jsonl  the source of truth: every AgentEvent the cockpit saw, one
 *                 JSON object per line with a `ts` added, appended as it
 *                 happens and fsynced when a turn ends
 *   session.org   a rendering of the same events a person reads in Emacs: one
 *                 heading per turn, You and Claude under it, tool calls as
 *                 source blocks, tool output as example blocks
 *
 * The events arrive before the session id does (the user's text is in the
 * stream before the SDK answers with its init frame), so they wait in memory
 * until `started` names the folder, then land in order. Both files are
 * append-only and written synchronously: when `record()` returns, the bytes
 * are in the file, so a crash loses nothing that was seen.
 *
 * The rendering is a view, not the record: a line of prose that Org would
 * read as a heading or a keyword is escaped with a leading comma, Org's own
 * convention inside blocks, and the raw text stays intact in events.jsonl.
 *
 * Nothing in this file is written anywhere but the session folder, and
 * nothing here logs content (CLAUDE.md, SECURITY.org).
 */

export const EVENT_LOG_FILE = 'events.jsonl'
export const TRANSCRIPT_FILE = 'session.org'

/** A turn heading shows this much of the prompt's first line. */
const EXCERPT_LENGTH = 72

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const

/** Org's inactive timestamp, in local time: `[2026-10-17 Fri 14:03]`. */
export function orgTimestamp(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  const day = WEEKDAYS[date.getDay()] ?? 'Sun'
  return `[${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${day} ${pad(date.getHours())}:${pad(date.getMinutes())}]`
}

/**
 * Prefixes a comma to every line Org would otherwise read as structure: a
 * heading (`* `) or a keyword or block fence (`#+`), and lines already so
 * escaped, so the escape stays reversible inside a block.
 */
export function escapeOrg(text: string): string {
  return text
    .split('\n')
    .map((line) => (/^,*(\*+ |#\+)/.test(line) ? `,${line}` : line))
    .join('\n')
}

/** The first non-empty line of the prompt, cut to fit a heading. */
function excerpt(text: string): string {
  const line = text
    .split('\n')
    .map((candidate) => candidate.trim())
    .find((candidate) => candidate.length > 0)
  if (line === undefined) return '(empty prompt)'
  const squeezed = line.replace(/\s+/g, ' ')
  return squeezed.length > EXCERPT_LENGTH ? `${squeezed.slice(0, EXCERPT_LENGTH - 3)}...` : squeezed
}

/** A note is one list item; a newline inside it would end the item. */
function oneLine(text: string): string {
  return text.replace(/\s*\n\s*/g, ' ')
}

/** Tool arguments as data on the page, one JSON document, never run or interpreted. */
function formatInput(input: Record<string, unknown>): string {
  try {
    return JSON.stringify(input, null, 2)
  } catch {
    return '(arguments could not be shown)'
  }
}

/** Each question, its options numbered from 1, the way the cockpit showed them. */
function formatQuestions(questions: readonly AgentQuestion[]): string {
  const lines: string[] = []
  for (const question of questions) {
    lines.push(question.question)
    for (const [index, option] of question.options.entries()) {
      const detail = option.description.length === 0 ? '' : `: ${option.description}`
      lines.push(`${index + 1}. ${option.label}${detail}`)
    }
  }
  return lines.join('\n')
}

function describeOutcome(
  toolName: string,
  outcome: 'allow' | 'allow-session' | 'deny' | 'aborted',
): string {
  switch (outcome) {
    case 'allow':
      return `Allowed ${toolName} once`
    case 'allow-session':
      return `Allowed ${toolName} for this session`
    case 'deny':
      return `Denied ${toolName}`
    case 'aborted':
      return `Request for ${toolName} withdrawn`
  }
}

/**
 * The Org rendering, event by event. Pure: `append()` returns the text to add
 * at the end of the file and keeps only what the next event needs to know,
 * which tool a result answers and whether Claude is mid-reply. The unit tests
 * join the chunks and read the document.
 */
export class OrgTranscript {
  private readonly now: () => Date
  private readonly toolNames = new Map<string, string>()
  /** Claude is mid-reply: the next text extends the block instead of opening one. */
  private open = false

  constructor(now: () => Date = () => new Date()) {
    this.now = now
  }

  /** The first lines of a new file. A folder reopened by a resume skips this. */
  static header(sessionId: string, date: Date): string {
    return `#+title: Nemesis session ${sessionId}\n#+date: ${orgTimestamp(date)}\n`
  }

  append(event: AgentEvent): string {
    if (event.type === 'assistant-text' && this.open) return `${escapeOrg(event.text)}\n`
    this.open = false
    switch (event.type) {
      case 'user-text':
        return block(
          `* ${orgTimestamp(this.now())} ${excerpt(event.text)}`,
          '** You',
          escapeOrg(event.text),
        )
      case 'assistant-text':
        this.open = true
        return block('** Claude', escapeOrg(event.text))
      case 'assistant-thinking':
        return block('** Thinking', escapeOrg(event.text))
      case 'tool-use':
        this.toolNames.set(event.toolUseId, event.name)
        return block(
          `** Tool: ${event.name}`,
          '#+begin_src json',
          escapeOrg(formatInput(event.input)),
          '#+end_src',
        )
      case 'tool-result': {
        const name = this.toolNames.get(event.toolUseId) ?? 'tool'
        return block(
          `** Result: ${name}${event.isError ? ' (error)' : ''}`,
          '#+begin_example',
          escapeOrg(event.text.length === 0 ? '(no output)' : event.text),
          '#+end_example',
        )
      }
      case 'started':
        return note(
          `Session started: ${event.model}, ${event.permissionMode} mode, in ${event.cwd}`,
        )
      case 'turn-end':
        return event.isError ? note(`Turn failed: ${event.result}`) : ''
      case 'error':
        return note(`Error: ${event.message}`)
      case 'stopped':
        return note(`Session stopped (${event.reason})`)
      case 'permission-request':
        return event.questions === undefined
          ? note(`Permission asked: ${event.toolName}`)
          : block(
              `** Question: ${event.questions.map((question) => question.header).join(', ')}`,
              escapeOrg(formatQuestions(event.questions)),
            )
      case 'question-answered':
        return note(`Answered ${event.header}: ${event.answer}`)
      case 'permission-answered':
        return event.outcome === 'answered'
          ? ''
          : note(describeOutcome(event.toolName, event.outcome))
      case 'notice':
        return note(event.text)
    }
  }
}

/** A block starts after a blank line and ends with a newline, so the file always does. */
function block(...lines: readonly string[]): string {
  return `\n${lines.join('\n')}\n`
}

/** A session note: one list item, set off from the prose around it. */
function note(text: string): string {
  return block(`- ${oneLine(text)}`)
}

export interface SessionRecorderOptions {
  /** The sessions folder from the settings; created on first use. */
  readonly sessionsDir: string
  /** Injected by the tests, so the timestamps in the files are known. */
  readonly now?: (() => Date) | undefined
}

interface OpenFolder {
  readonly sessionId: string
  readonly path: string
  readonly log: number
  readonly org: number
  readonly transcript: OrgTranscript
}

/**
 * Writes one session to its folder. The bridge feeds it every event of the
 * session and of the permission bridge, in the order the window sees them.
 * A session that stops and starts again under another id gets another folder;
 * one that resumes under the same id appends to the same files.
 */
export class SessionRecorder {
  private readonly sessionsDir: string
  private readonly now: () => Date
  private readonly pending: AgentEvent[] = []
  private folderValue: OpenFolder | null = null
  /** Set after a write failed: the error is reported once, then the session is not recorded. */
  private broken = false

  constructor(options: SessionRecorderOptions) {
    this.sessionsDir = options.sessionsDir
    this.now = options.now ?? (() => new Date())
  }

  /** The folder being written, once `started` named it. */
  get folder(): string | null {
    return this.folderValue?.path ?? null
  }

  record(event: AgentEvent): void {
    if (this.broken) return
    try {
      if (event.type === 'started') {
        if (this.folderValue !== null && this.folderValue.sessionId !== event.sessionId) {
          this.close()
        }
        if (this.folderValue === null) this.open(event.sessionId)
      } else if (
        this.folderValue === null &&
        (event.type === 'error' || event.type === 'stopped')
      ) {
        // The session died before the SDK named it. What was seen is still
        // worth keeping, under a name that says so.
        this.open(`unstarted-${this.now().toISOString().replace(/[:.]/g, '-')}`)
      }
      if (this.folderValue === null) {
        this.pending.push(event)
        return
      }
      this.write(this.folderValue, event)
      if (event.type === 'turn-end') {
        fsyncSync(this.folderValue.log)
        fsyncSync(this.folderValue.org)
      }
      if (event.type === 'stopped') this.close()
    } catch (error) {
      this.broken = true
      // The failure is named; the event that failed to land is not.
      console.error(`Could not write the session folder: ${describe(error)}`)
    }
  }

  /** Flushes and closes the files. Safe to call twice; the next `started` reopens. */
  close(): void {
    const folder = this.folderValue
    if (folder === null) return
    this.folderValue = null
    try {
      fsyncSync(folder.log)
      fsyncSync(folder.org)
    } finally {
      closeSync(folder.log)
      closeSync(folder.org)
    }
  }

  private open(sessionId: string): void {
    const path = join(this.sessionsDir, sessionId)
    mkdirSync(path, { recursive: true })
    const orgPath = join(path, TRANSCRIPT_FILE)
    const fresh = !existsSync(orgPath) || statSync(orgPath).size === 0
    const log = openSync(join(path, EVENT_LOG_FILE), 'a')
    const org = openSync(orgPath, 'a')
    const folder: OpenFolder = {
      sessionId,
      path,
      log,
      org,
      transcript: new OrgTranscript(this.now),
    }
    this.folderValue = folder
    if (fresh) writeSync(org, OrgTranscript.header(sessionId, this.now()))
    const waiting = this.pending.splice(0)
    for (const event of waiting) this.write(folder, event)
  }

  private write(folder: OpenFolder, event: AgentEvent): void {
    writeSync(folder.log, `${JSON.stringify({ ts: this.now().toISOString(), ...event })}\n`)
    const chunk = folder.transcript.append(event)
    if (chunk.length > 0) writeSync(folder.org, chunk)
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
