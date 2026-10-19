import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentEvent } from '../../src/main/agent/events'
import {
  escapeOrg,
  EVENT_LOG_FILE,
  orgTimestamp,
  OrgTranscript,
  SESSION_NAME_LENGTH,
  sessionName,
  SessionRecorder,
  TRANSCRIPT_FILE,
} from '../../src/main/transcripts'

// Local time, so the Org stamp is the same on every machine the suite runs on.
const NOON = new Date(2026, 9, 17, 12, 30, 45)
const now = (): Date => NOON

const started: AgentEvent = {
  type: 'started',
  sessionId: 'mock-session',
  model: 'claude-mock-1',
  permissionMode: 'default',
  cwd: '/work',
  tools: ['Read'],
}

function turnEnd(result: string): AgentEvent {
  return { type: 'turn-end', isError: false, result, durationMs: 1, numTurns: 1 }
}

function render(events: readonly AgentEvent[]): string {
  const transcript = new OrgTranscript(now)
  return (
    OrgTranscript.header('mock-session', NOON) + events.map((e) => transcript.append(e)).join('')
  )
}

describe('the Org rendering', () => {
  it('writes Org inactive timestamps in local time', () => {
    expect(orgTimestamp(NOON)).toBe('[2026-10-17 Sat 12:30]')
  })

  it('renders a turn as a heading with You and Claude under it, and the session note between', () => {
    const text = render([
      { type: 'user-text', text: 'alpha one' },
      started,
      { type: 'assistant-text', text: 'You said: alpha one' },
      turnEnd('You said: alpha one'),
    ])
    expect(text).toBe(
      [
        '#+title: Nemesis session mock-session',
        '#+date: [2026-10-17 Sat 12:30]',
        '',
        '* [2026-10-17 Sat 12:30] alpha one',
        '** You',
        'alpha one',
        '',
        '- Session started: claude-mock-1, default mode, in /work',
        '',
        '** Claude',
        'You said: alpha one',
        '',
      ].join('\n'),
    )
  })

  it('notes a nudge and writes nothing for the context meter, which the log keeps (#80)', () => {
    const text = render([
      { type: 'nudge', text: '2 corrections in a row' },
      { type: 'context-usage', usedTokens: 1, windowTokens: 2 },
      { type: 'permission-mode', mode: 'plan' },
    ])
    expect(text).toBe(
      [
        '#+title: Nemesis session mock-session',
        '#+date: [2026-10-17 Sat 12:30]',
        '',
        '- 2 corrections in a row',
        '',
        '- Permission mode: plan',
        '',
      ].join('\n'),
    )
  })

  it('renders a name as a file property, so the latest of an append-only file wins (#104)', () => {
    const text = render([
      { type: 'user-text', text: 'go' },
      { type: 'assistant-text', text: 'first' },
      { type: 'named', name: 'nemesis security review' },
      { type: 'assistant-text', text: 'second' },
      { type: 'named', name: '* not a heading' },
      { type: 'named', name: '\u0007' },
    ])
    expect(text).toContain(
      '** Claude\nfirst\n\n#+property: session_name nemesis security review\n\n** Claude\nsecond\n',
    )
    expect(text).toContain('\n#+property: session_name * not a heading\n')
    expect(text.match(/#\+property: session_name/g)).toHaveLength(2)
  })

  it('squeezes a name to one line of printable characters, cut at the cap (#104)', () => {
    expect(sessionName('  nemesis \n  security\treview  ')).toBe('nemesis security review')
    expect(sessionName('a\u0000b\u001bc')).toBe('abc')
    expect(sessionName(' \n\t ')).toBeNull()
    expect(sessionName('')).toBeNull()
    expect(sessionName('x'.repeat(SESSION_NAME_LENGTH + 5))).toBe('x'.repeat(SESSION_NAME_LENGTH))
    // Characters, not UTF-16 units: an emoji counts once.
    expect(sessionName('\u{1F600}'.repeat(SESSION_NAME_LENGTH + 1))).toBe(
      '\u{1F600}'.repeat(SESSION_NAME_LENGTH),
    )
  })

  it('joins consecutive assistant text into one Claude block until the turn ends', () => {
    const text = render([
      { type: 'user-text', text: 'go' },
      { type: 'assistant-text', text: 'first' },
      { type: 'assistant-text', text: 'second' },
      turnEnd('first\nsecond'),
      { type: 'user-text', text: 'again' },
      { type: 'assistant-text', text: 'third' },
    ])
    expect(text).toContain('** Claude\nfirst\nsecond\n\n* ')
    expect(text.match(/\*\* Claude/g)).toHaveLength(2)
  })

  it('renders tool calls as json source blocks and their output as example blocks', () => {
    const text = render([
      { type: 'user-text', text: 'tool: Read' },
      { type: 'tool-use', toolUseId: 't1', name: 'Read', input: { path: '/mock/notes.txt' } },
      { type: 'tool-result', toolUseId: 't1', isError: false, text: 'Read ran' },
      { type: 'tool-use', toolUseId: 't2', name: 'Bash', input: { command: 'ls' } },
      { type: 'tool-result', toolUseId: 't2', isError: true, text: '' },
    ])
    expect(text).toContain(
      '\n** Tool: Read\n#+begin_src json\n{\n  "path": "/mock/notes.txt"\n}\n#+end_src\n',
    )
    expect(text).toContain('\n** Result: Read\n#+begin_example\nRead ran\n#+end_example\n')
    expect(text).toContain(
      '\n** Result: Bash (error)\n#+begin_example\n(no output)\n#+end_example\n',
    )
  })

  it("heads a check as evidence, the verify key's with its exit code and duration (#81)", () => {
    const text = render([
      { type: 'tool-use', toolUseId: 't1', name: 'Bash', input: { command: 'npm test' } },
      { type: 'tool-result', toolUseId: 't1', isError: true, text: 'FAIL auth\nExit code 1' },
      {
        type: 'evidence',
        command: 'npm run gate',
        source: 'issue',
        exitCode: 0,
        signal: null,
        durationMs: 61_500,
        output: 'all green\n',
      },
    ])
    expect(text).toContain(
      '\n** Evidence: npm test (exit 1)\n#+begin_example\nFAIL auth\nExit code 1\n#+end_example\n',
    )
    expect(text).toContain(
      '\n** Evidence: npm run gate (exit 0, 61.5s)\n#+begin_example\nall green\n#+end_example\n',
    )
  })

  it('renders what happened inside a subagent under headings that say so (#85)', () => {
    const text = render([
      { type: 'user-text', text: 'Use subagents to investigate x' },
      { type: 'assistant-text', text: 'Looking.' },
      { type: 'tool-use', toolUseId: 'a1', name: 'Agent', input: { prompt: 'x' } },
      {
        type: 'tool-use',
        toolUseId: 'r1',
        name: 'Read',
        input: { path: '/x' },
        parentToolUseId: 'a1',
      },
      {
        type: 'tool-result',
        toolUseId: 'r1',
        isError: false,
        text: 'alpha',
        parentToolUseId: 'a1',
      },
      { type: 'assistant-text', text: 'Found it.', parentToolUseId: 'a1' },
      { type: 'tool-result', toolUseId: 'a1', isError: false, text: 'Summary.' },
      { type: 'assistant-text', text: 'Investigated.' },
    ])
    expect(text).toContain('\n** Tool: Agent\n')
    expect(text).toContain(
      '\n** Subagent tool: Read\n#+begin_src json\n{\n  "path": "/x"\n}\n#+end_src\n',
    )
    expect(text).toContain('\n** Subagent result: Read\n#+begin_example\nalpha\n#+end_example\n')
    expect(text).toContain('\n** Subagent: Claude\nFound it.\n')
    expect(text).toContain('\n** Result: Agent\n#+begin_example\nSummary.\n#+end_example\n')
    // The main thread's reply after the subagent opens a Claude block of its own.
    expect(text).toContain('\n** Claude\nInvestigated.\n')
  })

  it('renders thinking, questions and the permission notes the window showed', () => {
    const text = render([
      { type: 'user-text', text: 'ask: Which?' },
      { type: 'assistant-thinking', text: 'hmm' },
      {
        type: 'permission-request',
        requestId: 'r1',
        toolUseId: 't1',
        toolName: 'AskUserQuestion',
        input: {},
        questions: [
          {
            question: 'Which?',
            header: 'Choice',
            multiSelect: false,
            options: [
              { label: 'alpha', description: 'The first.' },
              { label: 'beta', description: '' },
            ],
          },
        ],
      },
      { type: 'question-answered', requestId: 'r1', index: 0, header: 'Choice', answer: 'beta' },
      {
        type: 'permission-answered',
        requestId: 'r1',
        toolName: 'AskUserQuestion',
        outcome: 'answered',
      },
      { type: 'permission-request', requestId: 'r2', toolUseId: 't2', toolName: 'Bash', input: {} },
      { type: 'permission-answered', requestId: 'r2', toolName: 'Bash', outcome: 'deny' },
      { type: 'error', message: 'boom' },
      { type: 'stopped', reason: 'ended' },
    ])
    expect(text).toContain('\n** Thinking\nhmm\n')
    expect(text).toContain('\n** Question: Choice\nWhich?\n1. alpha: The first.\n2. beta\n')
    expect(text).toContain('\n- Answered Choice: beta\n')
    expect(text).not.toContain('answered AskUserQuestion')
    expect(text).toContain('\n- Permission asked: Bash\n\n- Denied Bash\n')
    expect(text).toContain('\n- Error: boom\n\n- Session stopped (ended)\n')
  })

  it('escapes lines Org would read as headings or keywords, reversibly', () => {
    expect(escapeOrg('* not a heading\n#+end_src\n,* already\n*bold* stays\nplain')).toBe(
      ',* not a heading\n,#+end_src\n,,* already\n*bold* stays\nplain',
    )
    const text = render([
      { type: 'user-text', text: 'x' },
      { type: 'assistant-text', text: '* item\n#+begin_src sh\nrm -rf /\n#+end_src' },
    ])
    expect(text).toContain('\n** Claude\n,* item\n,#+begin_src sh\nrm -rf /\n,#+end_src\n')
  })

  it('cuts a long or multi-line prompt to one heading line', () => {
    const text = render([{ type: 'user-text', text: '\n\n  first   line\nsecond' }])
    expect(text).toContain('\n* [2026-10-17 Sat 12:30] first line\n** You\n')
    const long = render([{ type: 'user-text', text: 'a'.repeat(100) }])
    expect(long).toContain(`* [2026-10-17 Sat 12:30] ${'a'.repeat(69)}...\n`)
    expect(render([{ type: 'user-text', text: '  ' }])).toContain('(empty prompt)')
  })
})

describe('the session recorder', () => {
  let dir: string
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  function recorder(): SessionRecorder {
    dir = mkdtempSync(join(tmpdir(), 'nemesis-transcripts-'))
    return new SessionRecorder({ sessionsDir: join(dir, 'sessions'), now })
  }

  function lines(path: string): unknown[] {
    return readFileSync(path, 'utf8')
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as unknown)
  }

  it('holds the events until the session is named, then writes both files in order', () => {
    const rec = recorder()
    rec.record({ type: 'user-text', text: 'alpha one' })
    expect(rec.folder).toBeNull()
    expect(existsSync(join(dir, 'sessions'))).toBe(false)

    rec.record(started)
    const folder = join(dir, 'sessions', 'mock-session')
    expect(rec.folder).toBe(folder)
    rec.record({ type: 'assistant-text', text: 'You said: alpha one' })
    rec.record(turnEnd('You said: alpha one'))

    expect(readdirSync(folder).sort()).toEqual([EVENT_LOG_FILE, TRANSCRIPT_FILE])
    expect(lines(join(folder, EVENT_LOG_FILE))).toEqual([
      { ts: NOON.toISOString(), type: 'user-text', text: 'alpha one' },
      { ts: NOON.toISOString(), ...started },
      { ts: NOON.toISOString(), type: 'assistant-text', text: 'You said: alpha one' },
      { ts: NOON.toISOString(), ...turnEnd('You said: alpha one') },
    ])
    const org = readFileSync(join(folder, TRANSCRIPT_FILE), 'utf8')
    expect(org.startsWith('#+title: Nemesis session mock-session\n')).toBe(true)
    expect(org).toContain('** You\nalpha one\n')
    expect(org).toContain('** Claude\nYou said: alpha one\n')
    expect(org.endsWith('\n')).toBe(true)
    rec.close()
  })

  it('closes on stopped, appends on a restart under the same id, and opens a new folder for a new id', () => {
    const rec = recorder()
    rec.record({ type: 'user-text', text: 'one' })
    rec.record(started)
    rec.record({ type: 'stopped', reason: 'interrupted' })
    expect(rec.folder).toBeNull()

    rec.record({ type: 'user-text', text: 'two' })
    rec.record(started)
    const first = join(dir, 'sessions', 'mock-session')
    expect(rec.folder).toBe(first)
    const org = readFileSync(join(first, TRANSCRIPT_FILE), 'utf8')
    expect(org.match(/#\+title:/g)).toHaveLength(1)
    expect(org).toContain('- Session stopped (interrupted)\n\n* [2026-10-17 Sat 12:30] two\n')

    rec.record({ ...started, sessionId: 'other-session' })
    expect(rec.folder).toBe(join(dir, 'sessions', 'other-session'))
    expect(lines(join(first, EVENT_LOG_FILE))).toHaveLength(5)
    expect(lines(join(rec.folder ?? '', EVENT_LOG_FILE))).toHaveLength(1)
    rec.close()
  })

  it('keeps what it saw when the session dies before it is named', () => {
    const rec = recorder()
    rec.record({ type: 'user-text', text: 'hello' })
    rec.record({ type: 'error', message: 'the CLI is not installed' })
    rec.record({ type: 'stopped', reason: 'ended' })
    const folders = readdirSync(join(dir, 'sessions'))
    expect(folders).toHaveLength(1)
    expect(folders[0]).toMatch(/^unstarted-2026-10-17T/)
    const org = readFileSync(join(dir, 'sessions', folders[0] ?? '', TRANSCRIPT_FILE), 'utf8')
    expect(org).toContain('** You\nhello\n')
    expect(org).toContain('- Error: the CLI is not installed\n')
    expect(rec.folder).toBeNull()
  })

  it('reports a write failure once and records nothing more', () => {
    dir = mkdtempSync(join(tmpdir(), 'nemesis-transcripts-'))
    // A file where the sessions folder should be: mkdir fails.
    const blocked = join(dir, 'not-a-folder')
    const rec = new SessionRecorder({ sessionsDir: join(blocked, 'x'), now })
    writeFileSync(blocked, '')
    const errors: string[] = []
    const original = console.error
    console.error = (message: string) => void errors.push(message)
    try {
      rec.record({ type: 'user-text', text: 'secret prompt' })
      rec.record(started)
      rec.record(started)
    } finally {
      console.error = original
    }
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatch(/Could not write the session folder/)
    expect(errors[0]).not.toContain('secret prompt')
    expect(rec.folder).toBeNull()
  })
})
