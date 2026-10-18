import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  describeMatch,
  excerptAround,
  MAX_MATCHES,
  searchTranscripts,
  TranscriptSearch,
  unescapeOrg,
} from '../../src/main/transcript-search'
import { TRANSCRIPT_FILE } from '../../src/main/transcripts'

// Search across transcripts (#69): every session.org under the sessions
// folder, streamed line by line, over three fixture folders the recorder
// could have written.

const GARDEN = `#+title: Nemesis session mock-session
#+date: [2026-10-15 Thu 10:00]

* [2026-10-15 Thu 10:00] plan the garden
** You
plan the garden

- Session started: claude-mock-1, default mode, in /work

** Claude
You said: plan the garden
Tomatoes need full sun.

* [2026-10-15 Thu 10:30] and the herbs
** You
and the herbs

** Claude
,* Basil next to the tomatoes.
`

const LOGIN = `#+title: Nemesis session mock-session-2
#+date: [2026-10-16 Fri 09:00]

* [2026-10-16 Fri 09:00] fix the login bug
** You
fix the login bug

** Claude
You said: fix the login bug
`

const SEEDS = `#+title: Nemesis session mock-session-3
#+date: [2026-10-17 Sat 08:00]

- Session resumed before any prompt

* [2026-10-17 Sat 08:00] shopping list
** You
shopping list

** Tool: Bash
#+begin_src json
{
  "command": "echo tomato"
}
#+end_src

** Claude
Buy tomato seeds before Sunday.
`

const folders: string[] = []

afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true })
})

function sessionsDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'nemesis-search-'))
  folders.push(dir)
  return dir
}

/** Writes one transcript and dates it, so the newest-first order is known. */
function writeTranscript(dir: string, name: string, text: string, modified: Date): void {
  mkdirSync(join(dir, name), { recursive: true })
  const path = join(dir, name, TRANSCRIPT_FILE)
  writeFileSync(path, text)
  utimesSync(path, modified, modified)
}

function fixtures(): string {
  const dir = sessionsDir()
  writeTranscript(dir, 'mock-session', GARDEN, new Date('2026-10-15T10:30:00Z'))
  writeTranscript(dir, 'mock-session-2', LOGIN, new Date('2026-10-16T09:00:00Z'))
  writeTranscript(dir, 'mock-session-3', SEEDS, new Date('2026-10-17T08:00:00Z'))
  // A folder with a log but no transcript yet is not a session to search.
  mkdirSync(join(dir, 'unstarted-2026'), { recursive: true })
  writeFileSync(join(dir, 'unstarted-2026', 'events.jsonl'), '{"type":"error"}\n')
  return dir
}

describe('searchTranscripts', () => {
  it('finds the lines that contain the query, case folded, newest session first', async () => {
    const matches = await searchTranscripts(fixtures(), 'TOMATO')
    expect(matches).toEqual([
      {
        sessionId: 'mock-session-3',
        title: 'shopping list',
        date: '2026-10-17 08:00',
        line: 13,
        text: '  "command": "echo tomato"',
        excerpt: '"command": "echo tomato"',
      },
      {
        sessionId: 'mock-session-3',
        title: 'shopping list',
        date: '2026-10-17 08:00',
        line: 18,
        text: 'Buy tomato seeds before Sunday.',
        excerpt: 'Buy tomato seeds before Sunday.',
      },
      {
        sessionId: 'mock-session',
        title: 'plan the garden',
        date: '2026-10-15 10:00',
        line: 12,
        text: 'Tomatoes need full sun.',
        excerpt: 'Tomatoes need full sun.',
      },
      {
        sessionId: 'mock-session',
        title: 'plan the garden',
        date: '2026-10-15 10:30',
        line: 19,
        text: '* Basil next to the tomatoes.',
        excerpt: '* Basil next to the tomatoes.',
      },
    ])
  })

  it('searches the prose and the notes, never the structure of the file', async () => {
    const dir = fixtures()
    // Every file has a "Claude" heading and a "You" heading; neither is a match.
    expect(await searchTranscripts(dir, '** Claude')).toEqual([])
    expect(await searchTranscripts(dir, 'Nemesis session')).toEqual([])
    expect(await searchTranscripts(dir, 'begin_src')).toEqual([])
    // A note before the first turn takes the file's date and the session's title.
    expect(await searchTranscripts(dir, 'before any prompt')).toEqual([
      {
        sessionId: 'mock-session-3',
        title: 'shopping list',
        date: '2026-10-17 08:00',
        line: 4,
        text: '- Session resumed before any prompt',
        excerpt: '- Session resumed before any prompt',
      },
    ])
  })

  it('matches nothing for an empty query, a missing folder or a folder without transcripts', async () => {
    const dir = fixtures()
    expect(await searchTranscripts(dir, '')).toEqual([])
    expect(await searchTranscripts(join(dir, 'nowhere'), 'tomato')).toEqual([])
    expect(await searchTranscripts(dir, 'unstarted')).toEqual([])
  })

  it('stops at the match cap', async () => {
    const dir = sessionsDir()
    const many = `#+title: x\n\n* [2026-10-17 Sat 08:00] p\n** Claude\n${'needle\n'.repeat(MAX_MATCHES + 50)}`
    writeTranscript(dir, 'big', many, new Date('2026-10-17T08:00:00Z'))
    writeTranscript(dir, 'small', '** Claude\nneedle\n', new Date('2026-10-16T08:00:00Z'))
    const matches = await searchTranscripts(dir, 'needle')
    expect(matches).toHaveLength(MAX_MATCHES)
    expect(matches.every((match) => match.sessionId === 'big')).toBe(true)
  })

  it('cuts a long line to a window around the match', () => {
    const line = `${'a'.repeat(60)} tomato ${'b'.repeat(60)}`
    const excerpt = excerptAround(line, line.indexOf('tomato'))
    expect(excerpt).toBe(`...${'a'.repeat(19)} tomato ${'b'.repeat(53)}...`)
    expect(excerptAround('  short  ', 2)).toBe('short')
    const start = `tomato ${'b'.repeat(100)}`
    expect(excerptAround(start, 0)).toBe(`tomato ${'b'.repeat(73)}...`)
  })

  it('undoes the Org comma escape and nothing else', () => {
    expect(unescapeOrg(',* heading-like prose')).toBe('* heading-like prose')
    expect(unescapeOrg(',#+keyword-like prose')).toBe('#+keyword-like prose')
    expect(unescapeOrg(',,* twice')).toBe(',* twice')
    expect(unescapeOrg(', not an escape')).toBe(', not an escape')
    expect(unescapeOrg('plain')).toBe('plain')
  })

  it('describes a match as title, date and excerpt', () => {
    expect(
      describeMatch({
        sessionId: 'x',
        title: 'plan the garden',
        date: '2026-10-15 10:00',
        line: 1,
        text: 't',
        excerpt: 'Tomatoes need full sun.',
      }),
    ).toBe('plan the garden · 2026-10-15 10:00 · Tomatoes need full sun.')
    expect(
      describeMatch({
        sessionId: 'x',
        title: '(no prompt)',
        date: '',
        line: 1,
        text: 't',
        excerpt: 't',
      }),
    ).toBe('(no prompt) · t')
  })
})

describe('TranscriptSearch', () => {
  it('keeps the last result and tells the window where to go', async () => {
    const search = new TranscriptSearch({ sessionsDir: fixtures() })
    expect(search.matches).toEqual([])
    const matches = await search.search('login')
    expect(matches.map((match) => match.text)).toEqual([
      'fix the login bug',
      'You said: fix the login bug',
    ])
    expect(search.matches).toBe(matches)
    const [first, second] = matches
    if (first === undefined || second === undefined) throw new Error('two matches expected')
    const seen = vi.fn()
    const off = search.on(seen)
    search.goTo(second)
    expect(seen).toHaveBeenCalledWith({ text: 'You said: fix the login bug' })
    off()
    search.goTo(first)
    expect(seen).toHaveBeenCalledTimes(1)
  })

  it('matches nothing when no folder is wired', async () => {
    const search = new TranscriptSearch({ sessionsDir: null })
    expect(await search.search('tomato')).toEqual([])
  })
})
