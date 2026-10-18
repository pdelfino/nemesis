import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentEvent } from './agent/events'
import { EVENT_LOG_FILE } from './transcripts'

/**
 * The session index (#67): what the sessions folder holds, read back from
 * the event logs the recorder writes (src/main/transcripts.ts). One summary
 * per folder whose log has a `started` event, since that is the id the SDK
 * resumes by; a folder a session died in before it was named (`unstarted-`)
 * has nothing to resume and is left out. The history of one session is its
 * whole log, in order, for the window to show again ahead of the new turns.
 *
 * Nothing here writes, and nothing here logs content: the files are read in
 * the main process and the events reach the window the way live ones do.
 */

export interface SessionSummary {
  /** The SDK's session id, which names the folder and which a resume takes. */
  readonly id: string
  /** The first line of the first prompt, cut to fit a palette row. */
  readonly title: string
  /** When the first event of the session was recorded. */
  readonly startedAt: Date
  /** The working directory the session ran in. */
  readonly cwd: string
}

/** What the resume command needs; the index implements it over a folder. */
export interface SessionSource {
  /** Every resumable session, newest first. */
  list(): readonly SessionSummary[]
  /** The recorded events of one session, oldest first; empty for an unknown id. */
  history(id: string): readonly AgentEvent[]
}

/** The default when no folder is wired: nothing to resume. */
export const NO_SESSIONS: SessionSource = { list: () => [], history: () => [] }

/** A title longer than this is cut, like a heading in the Org transcript. */
const TITLE_LENGTH = 72

/** Every event type the log may carry; a line with another type is not an event. */
const KNOWN_TYPES: Readonly<Record<AgentEvent['type'], true>> = {
  started: true,
  'user-text': true,
  'assistant-text': true,
  'assistant-thinking': true,
  'tool-use': true,
  'tool-result': true,
  'turn-end': true,
  error: true,
  stopped: true,
  'permission-request': true,
  'question-answered': true,
  'permission-answered': true,
  notice: true,
  'context-usage': true,
  nudge: true,
  'permission-mode': true,
  evidence: true,
}

interface LogEntry {
  readonly at: Date | null
  readonly event: AgentEvent
}

/**
 * The lines of a log as entries, in order. A line that is not an event, a
 * torn last line after a crash for one, is skipped rather than fatal: the
 * rest of the session is still worth showing.
 */
function readLog(text: string): LogEntry[] {
  const entries: LogEntry[] = []
  for (const line of text.split('\n')) {
    if (line.trim().length === 0) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) continue
    const record = parsed as Record<string, unknown>
    const type = record['type']
    if (typeof type !== 'string' || !(type in KNOWN_TYPES)) continue
    const event = Object.fromEntries(Object.entries(record).filter(([key]) => key !== 'ts'))
    const ts = record['ts']
    const at = typeof ts === 'string' ? new Date(ts) : null
    entries.push({
      at: at !== null && !Number.isNaN(at.getTime()) ? at : null,
      event: event as unknown as AgentEvent,
    })
  }
  return entries
}

/** The events of one log, without the timestamps the recorder added. */
export function parseEventLog(text: string): AgentEvent[] {
  return readLog(text).map((entry) => entry.event)
}

/** One session's summary from its log, or null when the log never named a session. */
export function summarizeLog(id: string, text: string): SessionSummary | null {
  let startedAt: Date | null = null
  let title: string | null = null
  let cwd: string | null = null
  for (const entry of readLog(text)) {
    startedAt ??= entry.at
    if (entry.event.type === 'user-text' && title === null) title = excerpt(entry.event.text)
    if (entry.event.type === 'started' && cwd === null) cwd = entry.event.cwd
    if (title !== null && cwd !== null) break
  }
  if (cwd === null) return null
  return { id, title: title ?? '(no prompt)', startedAt: startedAt ?? new Date(0), cwd }
}

/** The first non-empty line of the prompt, cut to fit a palette row. */
function excerpt(text: string): string {
  const line = text
    .split('\n')
    .map((candidate) => candidate.trim())
    .find((candidate) => candidate.length > 0)
  if (line === undefined) return '(empty prompt)'
  const squeezed = line.replace(/\s+/g, ' ')
  return squeezed.length > TITLE_LENGTH ? `${squeezed.slice(0, TITLE_LENGTH - 3)}...` : squeezed
}

/** The date a palette row shows beside the title: local time, to the minute. */
export function formatSessionDate(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** A session id names a folder directly under the sessions dir, nothing else. */
function isFolderName(id: string): boolean {
  return id.length > 0 && id !== '.' && id !== '..' && !/[/\\]/.test(id)
}

export interface SessionIndexOptions {
  /** The sessions folder from the settings; it may not exist yet. */
  readonly sessionsDir: string
}

export class SessionIndex implements SessionSource {
  private readonly sessionsDir: string

  constructor(options: SessionIndexOptions) {
    this.sessionsDir = options.sessionsDir
  }

  list(): readonly SessionSummary[] {
    const summaries: SessionSummary[] = []
    for (const name of this.folders()) {
      const text = this.readLogOf(name)
      if (text === null) continue
      const summary = summarizeLog(name, text)
      if (summary !== null) summaries.push(summary)
    }
    return summaries.sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())
  }

  history(id: string): readonly AgentEvent[] {
    if (!isFolderName(id)) return []
    const text = this.readLogOf(id)
    return text === null ? [] : parseEventLog(text)
  }

  private folders(): string[] {
    try {
      return readdirSync(this.sessionsDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
    } catch {
      // No sessions folder yet: nothing has been recorded.
      return []
    }
  }

  /** The log text, or null when the folder has none or it cannot be read. */
  private readLogOf(name: string): string | null {
    try {
      return readFileSync(join(this.sessionsDir, name, EVENT_LOG_FILE), 'utf8')
    } catch {
      return null
    }
  }
}
