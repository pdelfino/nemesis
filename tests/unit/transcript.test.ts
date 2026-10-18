import { foldedRanges } from '@codemirror/language'
import { EditorState } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import type { AgentEvent } from '../../src/shared/agent'
import {
  lineWithText,
  transactionFor,
  transcriptExtensions,
  transcriptField,
} from '../../src/renderer/transcript-doc'

// The transcript is a document first (#62): these tests drive the append path
// over a bare EditorState, no window, the way the renderer dispatches it.

function empty(): EditorState {
  return EditorState.create({ extensions: transcriptExtensions() })
}

function append(state: EditorState, ...events: readonly AgentEvent[]): EditorState {
  for (const event of events) {
    const spec = transactionFor(state, event)
    if (spec !== null) state = state.update(spec).state
  }
  return state
}

function folds(state: EditorState): string[] {
  const out: string[] = []
  foldedRanges(state).between(0, state.doc.length, (from, to) => {
    out.push(state.sliceDoc(from, to))
  })
  return out
}

const user: AgentEvent = { type: 'user-text', text: 'hello' }
const reply: AgentEvent = { type: 'assistant-text', text: 'You said: hello' }
const turnEnd: AgentEvent = {
  type: 'turn-end',
  isError: false,
  result: 'You said: hello',
  durationMs: 1,
  numTurns: 1,
}

describe('the transcript document', () => {
  it('appends each turn as a header line and a body, separated by a blank line', () => {
    const state = append(empty(), user, reply)
    expect(state.doc.toString()).toBe('You\nhello\n\nClaude\nYou said: hello')
    expect(state.field(transcriptField).blocks.map((block) => block.kind)).toEqual([
      'user',
      'assistant',
    ])
  })

  it('decorates header and body lines with their role', () => {
    const state = append(empty(), user, reply)
    const seen: string[] = []
    state.field(transcriptField).decorations.between(0, state.doc.length, (from, _to, deco) => {
      const spec = deco.spec as { class: string; attributes: { 'data-role': string } }
      seen.push(`${state.doc.lineAt(from).number} ${spec.class} ${spec.attributes['data-role']}`)
    })
    expect(seen).toEqual([
      '1 tr-header user',
      '2 tr-body user',
      '4 tr-header assistant',
      '5 tr-body assistant',
    ])
  })

  it('streams consecutive assistant text into one block until the turn ends', () => {
    const more: AgentEvent = { type: 'assistant-text', text: 'and more' }
    const state = append(empty(), user, reply, more)
    expect(state.doc.toString()).toBe('You\nhello\n\nClaude\nYou said: hello\nand more')
    expect(state.field(transcriptField).blocks).toHaveLength(2)

    const next = append(state, turnEnd, more)
    expect(next.doc.toString().endsWith('\n\nClaude\nand more')).toBe(true)
    expect(next.field(transcriptField).blocks).toHaveLength(3)
  })

  it('moves the point with the stream only while it sits at the end', () => {
    const following = append(empty(), user)
    expect(following.selection.main.head).toBe(following.doc.length)

    // Reading an earlier turn: the point stays where it is.
    const reading = following.update({ selection: { anchor: 2 } }).state
    const after = append(reading, reply)
    expect(after.selection.main.head).toBe(2)
    expect(after.doc.length).toBeGreaterThan(reading.doc.length)
  })

  it('refuses any change that is not an append from the session', () => {
    const state = append(empty(), user)
    const typed = state.update({ changes: { from: 0, insert: 'typed' } }).state
    expect(typed.doc.toString()).toBe(state.doc.toString())
    expect(state.readOnly).toBe(true)
  })

  it('folds thinking at once and tool blocks only when they are long', () => {
    const thinking: AgentEvent = { type: 'assistant-thinking', text: 'out loud' }
    const use: AgentEvent = {
      type: 'tool-use',
      toolUseId: 't1',
      name: 'Read',
      input: { path: '/mock/notes.txt' },
    }
    const short: AgentEvent = { type: 'tool-result', toolUseId: 't1', isError: false, text: 'ok' }
    const long: AgentEvent = {
      type: 'tool-result',
      toolUseId: 't1',
      isError: true,
      text: Array.from({ length: 8 }, (_unused, index) => `line ${index + 1}`).join('\n'),
    }
    const state = append(empty(), thinking, use, short, long)
    expect(state.doc.toString()).toContain('Tool: Read\n{\n  "path": "/mock/notes.txt"\n}')
    expect(state.doc.toString()).toContain('Result: Read\nok')
    expect(state.doc.toString()).toContain('Result: Read (error)\nline 1')
    expect(folds(state)).toEqual(['\nout loud', `\n${long.text}`])
  })

  it('notes a nudge and shows nothing for the context meter, which the mode line draws (#80)', () => {
    const state = append(
      empty(),
      user,
      { type: 'context-usage', usedTokens: 2000, windowTokens: 200_000 },
      { type: 'nudge', text: '2 corrections in a row' },
      { type: 'permission-mode', mode: 'plan' },
    )
    expect(state.doc.toString()).toBe(
      ['You', 'hello', '', '2 corrections in a row', '', 'Permission mode: plan'].join('\n'),
    )
    expect(
      transactionFor(state, { type: 'context-usage', usedTokens: 1, windowTokens: 2 }),
    ).toBeNull()
  })

  it('notes the session and a failed turn, and nothing for a good one', () => {
    const started: AgentEvent = {
      type: 'started',
      sessionId: 's',
      model: 'claude-mock-1',
      permissionMode: 'default',
      cwd: '/tmp/x',
      tools: [],
    }
    const failed: AgentEvent = { ...turnEnd, isError: true, result: 'boom' }
    const state = append(empty(), started, user, reply, turnEnd, failed)
    expect(state.doc.toString()).toBe(
      [
        'Session started: claude-mock-1, default mode, in /tmp/x',
        '',
        'You',
        'hello',
        '',
        'Claude',
        'You said: hello',
        '',
        'Turn failed: boom',
      ].join('\n'),
    )
    expect(transactionFor(state, turnEnd)?.changes).toBeUndefined()
  })

  it('shows a permission request with the tool, its arguments and the keys, then the answer (#63)', () => {
    const asked: AgentEvent = {
      type: 'permission-request',
      requestId: 'r1',
      toolUseId: 't1',
      toolName: 'Bash',
      input: { command: 'ls' },
    }
    const answered: AgentEvent = {
      type: 'permission-answered',
      requestId: 'r1',
      toolName: 'Bash',
      outcome: 'allow-session',
    }
    const state = append(empty(), asked, answered)
    expect(state.doc.toString()).toBe(
      [
        'Permission: Bash',
        '{',
        '  "command": "ls"',
        '}',
        'y allow once, n deny, a allow Bash for this session',
        '',
        'Allowed Bash for this session',
      ].join('\n'),
    )
    expect(state.field(transcriptField).blocks.map((block) => block.kind)).toEqual([
      'request',
      'note',
    ])
    // The SDK's own sentence heads the block when it supplied one.
    const titled = append(empty(), { ...asked, title: 'Claude wants to run ls' })
    expect(titled.doc.toString().startsWith('Claude wants to run ls\n{')).toBe(true)
    const denied = append(empty(), asked, { ...answered, outcome: 'deny', message: 'no' })
    expect(denied.doc.toString().endsWith('\n\nDenied Bash')).toBe(true)
  })

  it('numbers the options of a question and notes each answer (#63)', () => {
    const asked: AgentEvent = {
      type: 'permission-request',
      requestId: 'r1',
      toolUseId: 't1',
      toolName: 'AskUserQuestion',
      input: {},
      questions: [
        {
          question: 'Which one?',
          header: 'Choice',
          options: [
            { label: 'alpha', description: 'The first option.' },
            { label: 'beta', description: '' },
          ],
          multiSelect: false,
        },
      ],
    }
    const picked: AgentEvent = {
      type: 'question-answered',
      requestId: 'r1',
      index: 0,
      header: 'Choice',
      answer: 'beta',
    }
    const done: AgentEvent = {
      type: 'permission-answered',
      requestId: 'r1',
      toolName: 'AskUserQuestion',
      outcome: 'answered',
    }
    const state = append(empty(), asked, picked, done)
    expect(state.doc.toString()).toBe(
      [
        'Question: Choice',
        'Which one?',
        '1. alpha: The first option.',
        '2. beta',
        'Press a digit to choose, or type a reply in the prompt buffer and send it.',
        '',
        'Answered Choice: beta',
      ].join('\n'),
    )
    expect(transactionFor(state, done)).toBeNull()
  })
})

describe('the line a search match points at (#69)', () => {
  const state = append(
    empty(),
    user,
    { type: 'notice', text: 'Session started: claude-mock-1, default mode, in /work' },
    reply,
    turnEnd,
    { type: 'user-text', text: 'hello' },
    { type: 'assistant-text', text: 'You said: hello' },
    { type: 'assistant-text', text: 'and the tomatoes need sun' },
  )

  it('is the last line with that text, the resumed history being the newest part', () => {
    expect(state.doc.lines).toBe(14)
    expect(lineWithText(state.doc, 'You said: hello')?.number).toBe(13)
    expect(lineWithText(state.doc, 'hello')?.number).toBe(10)
  })

  it('finds a note without the dash the Org file gave it, then any line containing the text', () => {
    expect(
      lineWithText(state.doc, '- Session started: claude-mock-1, default mode, in /work')?.text,
    ).toBe('Session started: claude-mock-1, default mode, in /work')
    expect(lineWithText(state.doc, 'tomatoes')?.text).toBe('and the tomatoes need sun')
    expect(lineWithText(state.doc, 'nowhere')).toBeNull()
    expect(lineWithText(state.doc, '')).toBeNull()
  })
})
