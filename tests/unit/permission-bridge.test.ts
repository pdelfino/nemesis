import { describe, expect, it } from 'vitest'
import type { AgentEvent, PermissionRequest } from '../../src/main/agent/events'
import {
  DENIED_BY_USER,
  parseQuestions,
  PermissionBridge,
  REQUEST_ELEMENT_ID,
} from '../../src/main/agent/permission-bridge'
import { createCockpitBuffers } from '../../src/main/buffers'
import { CommandError } from '../../src/main/commands/registry'

// The bridge is the permission handler answered from the keyboard (#63).
// These tests drive it with a bare buffer registry and the request shapes the
// session hands it, no window and no SDK.

function setup() {
  const buffers = createCockpitBuffers()
  const bridge = new PermissionBridge(buffers)
  const events: AgentEvent[] = []
  bridge.on((event) => events.push(event))
  return { buffers, bridge, events }
}

function request(
  toolName: string,
  options: { input?: Record<string, unknown>; signal?: AbortSignal; title?: string } = {},
): PermissionRequest {
  return {
    toolName,
    toolUseId: `use-${toolName}`,
    input: options.input ?? { path: '/mock/notes.txt' },
    signal: options.signal ?? new AbortController().signal,
    ...(options.title === undefined ? {} : { title: options.title }),
  }
}

const QUESTION_INPUT = {
  questions: [
    {
      question: 'Which one?',
      header: 'Choice',
      options: [
        { label: 'alpha', description: 'The first option.' },
        { label: 'beta', description: 'The second option.' },
        { label: 'gamma', description: 'The third option.' },
      ],
      multiSelect: false,
    },
  ],
}

/** Settles a microtask later, so a test can see the promise is still open. */
async function settled<T>(promise: Promise<T>): Promise<T | 'pending'> {
  return Promise.race([promise, Promise.resolve('pending' as const)])
}

describe('the permission bridge (#63)', () => {
  it('shows a request as a block and a buffer, and holds the decision until a key', async () => {
    const { buffers, bridge, events } = setup()
    const prompt = buffers.current
    const decision = bridge.requestPermission(request('Bash', { title: 'Claude wants to run ls' }))

    expect(await settled(decision)).toBe('pending')
    expect(events).toEqual([
      {
        type: 'permission-request',
        requestId: 'r1',
        toolUseId: 'use-Bash',
        toolName: 'Bash',
        input: { path: '/mock/notes.txt' },
        title: 'Claude wants to run ls',
      },
    ])
    expect(buffers.current).toMatchObject({
      kind: 'permission',
      title: 'Permission: Bash',
      elementId: REQUEST_ELEMENT_ID,
    })
    expect(bridge.pending.map((entry) => entry.toolName)).toEqual(['Bash'])

    bridge.allowOnce()
    expect(await decision).toEqual({ behavior: 'allow' })
    expect(events.at(-1)).toEqual({
      type: 'permission-answered',
      requestId: 'r1',
      toolName: 'Bash',
      outcome: 'allow',
    })
    // The buffer is gone and the point is back on the prompt.
    expect(buffers.list().map((buffer) => buffer.kind)).toEqual(['transcript', 'prompt'])
    expect(buffers.current?.id).toBe(prompt?.id)
    expect(bridge.pending).toEqual([])
  })

  it('denies with a message the agent can read, and the prompt gets the point for a reason', async () => {
    const { buffers, bridge, events } = setup()
    const decision = bridge.requestPermission(request('Write'))
    bridge.deny()
    expect(await decision).toEqual({ behavior: 'deny', message: DENIED_BY_USER })
    expect(events.at(-1)).toMatchObject({ type: 'permission-answered', outcome: 'deny' })
    expect(buffers.current?.kind).toBe('prompt')
  })

  it('allows a tool for the session: the next request for it never asks', async () => {
    const { buffers, bridge, events } = setup()
    const first = bridge.requestPermission(request('Bash'))
    bridge.allowForSession()
    expect(await first).toEqual({ behavior: 'allow' })
    expect(events.at(-1)).toMatchObject({ type: 'permission-answered', outcome: 'allow-session' })
    expect([...bridge.allowedTools]).toEqual(['Bash'])

    const count = events.length
    expect(await bridge.requestPermission(request('Bash'))).toEqual({ behavior: 'allow' })
    expect(events).toHaveLength(count)
    expect(buffers.list().some((buffer) => buffer.kind === 'permission')).toBe(false)
    // Another tool still asks.
    expect(await settled(bridge.requestPermission(request('Write')))).toBe('pending')
    bridge.deny()
  })

  it('answers a question with a digit, keyed by question text in the updated input', async () => {
    const { buffers, bridge, events } = setup()
    const decision = bridge.requestPermission(request('AskUserQuestion', { input: QUESTION_INPUT }))
    expect(events[0]).toMatchObject({
      type: 'permission-request',
      toolName: 'AskUserQuestion',
      questions: [{ question: 'Which one?', header: 'Choice' }],
    })
    expect(buffers.current?.title).toBe('Question: Choice')

    // y and a mean nothing to a question; the digit does.
    expect(() => bridge.allowOnce()).toThrow(CommandError)
    expect(() => bridge.allowForSession()).toThrow(CommandError)
    expect(() => bridge.choose(4)).toThrow(/no option 4/)
    bridge.choose(2)
    expect(await decision).toEqual({
      behavior: 'allow',
      updatedInput: { ...QUESTION_INPUT, answers: { 'Which one?': 'beta' } },
    })
    expect(events.slice(1)).toEqual([
      { type: 'question-answered', requestId: 'r1', index: 0, header: 'Choice', answer: 'beta' },
      {
        type: 'permission-answered',
        requestId: 'r1',
        toolName: 'AskUserQuestion',
        outcome: 'answered',
      },
    ])
  })

  it('takes free text as the answer to a question, and only to a question', async () => {
    const { bridge } = setup()
    expect(bridge.reply('nothing pending')).toBe(false)

    const tool = bridge.requestPermission(request('Bash'))
    expect(bridge.reply('a reason')).toBe(false)
    bridge.deny()
    await tool

    const question = bridge.requestPermission(request('AskUserQuestion', { input: QUESTION_INPUT }))
    expect(bridge.reply('delta, in my own words')).toBe(true)
    expect(await question).toMatchObject({
      behavior: 'allow',
      updatedInput: { answers: { 'Which one?': 'delta, in my own words' } },
    })
  })

  it('walks several questions in order and resolves after the last', async () => {
    const { bridge, events } = setup()
    const input = {
      questions: [
        ...QUESTION_INPUT.questions,
        {
          question: 'And then?',
          header: 'Next',
          options: [
            { label: 'stop', description: '' },
            { label: 'go', description: '' },
          ],
          multiSelect: true,
        },
      ],
    }
    const decision = bridge.requestPermission(request('AskUserQuestion', { input }))
    bridge.choose(3)
    expect(await settled(decision)).toBe('pending')
    expect(bridge.pending[0]?.answers).toEqual(['gamma'])
    bridge.choose(2)
    expect(await decision).toMatchObject({
      updatedInput: { answers: { 'Which one?': 'gamma', 'And then?': 'go' } },
    })
    expect(events.filter((event) => event.type === 'question-answered')).toHaveLength(2)
  })

  it('declines a question on n', async () => {
    const { bridge } = setup()
    const decision = bridge.requestPermission(request('AskUserQuestion', { input: QUESTION_INPUT }))
    bridge.deny()
    expect(await decision).toEqual({ behavior: 'deny', message: 'The user declined to answer.' })
  })

  it('asks y or n for an AskUserQuestion whose input has no questions', async () => {
    const { bridge, events } = setup()
    const decision = bridge.requestPermission(request('AskUserQuestion', { input: {} }))
    expect(events[0]).not.toHaveProperty('questions')
    bridge.allowOnce()
    expect(await decision).toEqual({ behavior: 'allow' })
  })

  it('queues a second request behind the first and moves the point along', async () => {
    const { buffers, bridge } = setup()
    const first = bridge.requestPermission(request('Bash'))
    const second = bridge.requestPermission(request('Write'))
    expect(bridge.pending.map((entry) => entry.toolName)).toEqual(['Bash', 'Write'])
    expect(buffers.current?.title).toBe('Permission: Bash')
    expect(buffers.list().map((buffer) => buffer.title)).toEqual([
      'Transcript',
      'Prompt',
      'Permission: Bash',
      'Permission: Write',
    ])

    bridge.allowOnce()
    expect(await first).toEqual({ behavior: 'allow' })
    expect(buffers.current?.title).toBe('Permission: Write')
    bridge.deny()
    expect(await second).toMatchObject({ behavior: 'deny' })
    expect(buffers.current?.kind).toBe('prompt')
  })

  it('withdraws a request the SDK aborted', async () => {
    const { buffers, bridge, events } = setup()
    const aborter = new AbortController()
    const decision = bridge.requestPermission(request('Bash', { signal: aborter.signal }))
    aborter.abort()
    expect(await decision).toMatchObject({ behavior: 'deny' })
    expect(events.at(-1)).toMatchObject({ type: 'permission-answered', outcome: 'aborted' })
    expect(buffers.list().some((buffer) => buffer.kind === 'permission')).toBe(false)
    expect(bridge.pending).toEqual([])

    // Already aborted when asked: no block, no buffer, a denial at once.
    const count = events.length
    expect(
      await bridge.requestPermission(request('Bash', { signal: aborter.signal })),
    ).toMatchObject({ behavior: 'deny' })
    expect(events).toHaveLength(count)
  })

  it('treats a killed request buffer as a denial', async () => {
    const { buffers, bridge } = setup()
    const decision = bridge.requestPermission(request('Bash'))
    buffers.kill()
    expect(await decision).toEqual({
      behavior: 'deny',
      message: 'The user killed the request buffer.',
    })
    expect(bridge.pending).toEqual([])
  })

  it('refuses an answer when nothing is pending', () => {
    const { bridge } = setup()
    expect(() => bridge.allowOnce()).toThrow(/No request is pending/)
    expect(() => bridge.deny()).toThrow(/No request is pending/)
    expect(() => bridge.choose(1)).toThrow(/No request is pending/)
  })
})

describe('parsing AskUserQuestion input', () => {
  it('reads the questions the tool documents', () => {
    expect(parseQuestions(QUESTION_INPUT)).toEqual([
      {
        question: 'Which one?',
        header: 'Choice',
        options: [
          { label: 'alpha', description: 'The first option.' },
          { label: 'beta', description: 'The second option.' },
          { label: 'gamma', description: 'The third option.' },
        ],
        multiSelect: false,
      },
    ])
  })

  it('gives up on any other shape rather than guess', () => {
    expect(parseQuestions({})).toBeNull()
    expect(parseQuestions({ questions: [] })).toBeNull()
    expect(parseQuestions({ questions: [{ question: 'x', options: [] }] })).toBeNull()
    expect(parseQuestions({ questions: [{ question: 'x', options: [{ label: 1 }] }] })).toBeNull()
    expect(parseQuestions({ questions: [{ question: 'x', options: [{ label: 'y' }] }] })).toEqual([
      {
        question: 'x',
        header: 'Question',
        options: [{ label: 'y', description: '' }],
        multiSelect: false,
      },
    ])
  })
})
