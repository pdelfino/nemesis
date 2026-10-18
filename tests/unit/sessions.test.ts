import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentEvent } from '../../src/main/agent/events'
import {
  formatSessionDate,
  NO_SESSIONS,
  parseEventLog,
  SessionIndex,
  summarizeLog,
} from '../../src/main/sessions'
import { EVENT_LOG_FILE } from '../../src/main/transcripts'

// The index reads the sessions folder back from the logs the recorder writes
// (#67): one summary per folder a session was named in, newest first.

const started: AgentEvent = {
  type: 'started',
  sessionId: 'mock-session',
  model: 'claude-mock-1',
  permissionMode: 'default',
  cwd: '/work',
  tools: ['Read'],
}

function line(ts: string, event: AgentEvent): string {
  return `${JSON.stringify({ ts, ...event })}\n`
}

const FIRST_LOG =
  line('2026-10-17T12:30:45.000Z', { type: 'user-text', text: '\n  alpha   one\nsecond line' }) +
  line('2026-10-17T12:30:46.000Z', started) +
  line('2026-10-17T12:30:47.000Z', { type: 'assistant-text', text: 'You said: alpha one' }) +
  line('2026-10-17T12:30:47.000Z', {
    type: 'turn-end',
    isError: false,
    result: 'You said: alpha one',
    durationMs: 1,
    numTurns: 1,
  })

const SECOND_LOG =
  line('2026-10-18T09:00:00.000Z', { type: 'user-text', text: 'beta' }) +
  line('2026-10-18T09:00:01.000Z', { ...started, sessionId: 'mock-session-2', cwd: '/other' })

const folders: string[] = []

afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true })
})

function sessionsDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'nemesis-sessions-'))
  folders.push(dir)
  return dir
}

function writeLog(dir: string, name: string, text: string): void {
  mkdirSync(join(dir, name), { recursive: true })
  writeFileSync(join(dir, name, EVENT_LOG_FILE), text)
}

describe('reading one log', () => {
  it('summarizes a session by its first prompt, its first timestamp and its working directory', () => {
    expect(summarizeLog('mock-session', FIRST_LOG)).toEqual({
      id: 'mock-session',
      title: 'alpha one',
      startedAt: new Date('2026-10-17T12:30:45.000Z'),
      cwd: '/work',
    })
  })

  it('titles a named session by its latest name, whatever the first prompt was (#104)', () => {
    const named =
      FIRST_LOG +
      line('2026-10-17T12:31:00.000Z', { type: 'named', name: 'first name' }) +
      line('2026-10-17T12:32:00.000Z', { type: 'user-text', text: 'more' }) +
      line('2026-10-17T12:33:00.000Z', { type: 'named', name: '  nemesis   security\nreview ' })
    expect(summarizeLog('mock-session', named)).toMatchObject({
      id: 'mock-session',
      title: 'nemesis security review',
      startedAt: new Date('2026-10-17T12:30:45.000Z'),
    })
    // A name of blanks is not a name: the one before it stands.
    const blank = named + line('2026-10-17T12:34:00.000Z', { type: 'named', name: ' \t ' })
    expect(summarizeLog('mock-session', blank)?.title).toBe('nemesis security review')
    // The excerpt returns when a log carries no name.
    expect(summarizeLog('mock-session', FIRST_LOG)?.title).toBe('alpha one')
  })

  it('cuts a long first line to fit a palette row', () => {
    const long = 'x'.repeat(100)
    const summary = summarizeLog(
      'id',
      line('2026-10-17T12:30:45.000Z', { type: 'user-text', text: long }) +
        line('2026-10-17T12:30:46.000Z', started),
    )
    expect(summary?.title).toBe(`${'x'.repeat(69)}...`)
  })

  it('is null for a log that never named a session, so it cannot be resumed', () => {
    const unstarted =
      line('2026-10-17T12:30:45.000Z', { type: 'user-text', text: 'alpha' }) +
      line('2026-10-17T12:30:46.000Z', { type: 'error', message: 'boom' })
    expect(summarizeLog('unstarted-2026', unstarted)).toBeNull()
  })

  it('gives the events back without the timestamps, skipping lines that are not events', () => {
    const torn = `${FIRST_LOG}{"ts":"2026-10-17T12:30:48.000Z","type":"assist`
    const junk = '{"ts":"x","type":"not-an-event"}\n[1,2]\n\n'
    const named = line('2026-10-17T12:31:00.000Z', { type: 'named', name: 'review' })
    expect(parseEventLog(junk + named + torn)).toEqual([
      { type: 'named', name: 'review' },
      { type: 'user-text', text: '\n  alpha   one\nsecond line' },
      started,
      { type: 'assistant-text', text: 'You said: alpha one' },
      {
        type: 'turn-end',
        isError: false,
        result: 'You said: alpha one',
        durationMs: 1,
        numTurns: 1,
      },
    ])
  })

  it('formats the date a palette row shows in local time to the minute', () => {
    expect(formatSessionDate(new Date(2026, 9, 17, 9, 5))).toBe('2026-10-17 09:05')
  })
})

describe('the session index', () => {
  it('lists the named sessions newest first and leaves out folders with nothing to resume', () => {
    const dir = sessionsDir()
    writeLog(dir, 'mock-session', FIRST_LOG)
    writeLog(dir, 'mock-session-2', SECOND_LOG)
    writeLog(
      dir,
      'unstarted-2026-10-17T12-00-00-000Z',
      line('2026-10-17T12:00:00.000Z', { type: 'error', message: 'boom' }),
    )
    mkdirSync(join(dir, 'empty'))
    writeFileSync(join(dir, 'stray.txt'), 'not a session')

    const index = new SessionIndex({ sessionsDir: dir })
    expect(index.list()).toEqual([
      {
        id: 'mock-session-2',
        title: 'beta',
        startedAt: new Date('2026-10-18T09:00:00.000Z'),
        cwd: '/other',
      },
      {
        id: 'mock-session',
        title: 'alpha one',
        startedAt: new Date('2026-10-17T12:30:45.000Z'),
        cwd: '/work',
      },
    ])
  })

  it('reads the history of one session by id, and nothing for an id that is not a folder name', () => {
    const dir = sessionsDir()
    writeLog(dir, 'mock-session', FIRST_LOG)
    const index = new SessionIndex({ sessionsDir: dir })
    expect(index.history('mock-session').map((event) => event.type)).toEqual([
      'user-text',
      'started',
      'assistant-text',
      'turn-end',
    ])
    expect(index.history('missing')).toEqual([])
    expect(index.history('../mock-session')).toEqual([])
    expect(index.history('')).toEqual([])
  })

  it('is empty before the first session was recorded', () => {
    const index = new SessionIndex({ sessionsDir: join(sessionsDir(), 'not-yet') })
    expect(index.list()).toEqual([])
    expect(index.history('mock-session')).toEqual([])
    expect(NO_SESSIONS.list()).toEqual([])
  })
})
