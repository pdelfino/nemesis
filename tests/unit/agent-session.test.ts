import { describe, expect, it, vi } from 'vitest'
import type { SDKAssistantMessage, SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { mockDriver } from '../../src/main/agent/mock'
import type { AgentSession } from '../../src/main/agent/session'
import {
  compactCommand,
  contextWindowOf,
  createAgentSession,
  denyEveryTool,
  eventsFromMessage,
  isCompactCommand,
  usedTokensOf,
} from '../../src/main/agent/session'
import type {
  AgentEvent,
  PermissionDecision,
  PermissionHandler,
  PermissionRequest,
} from '../../src/main/agent/events'

// The mock is the SDK in these tests, so the event mapping is exercised against
// the frame shapes the real session reads (#58).

function collect(session: AgentSession): AgentEvent[] {
  const events: AgentEvent[] = []
  session.on((event) => events.push(event))
  return events
}

function kinds(events: readonly AgentEvent[]): string[] {
  return events.map((event) => event.type)
}

function session(
  options: { permissionHandler?: PermissionHandler; resume?: string } = {},
): AgentSession {
  return createAgentSession({ cwd: '/tmp/nemesis-unit', driver: mockDriver(), ...options })
}

describe('the mock Agent SDK', () => {
  it('runs only under test', () => {
    const before = process.env['NODE_ENV']
    process.env['NODE_ENV'] = 'production'
    try {
      expect(() => mockDriver()).toThrow(/NODE_ENV is test/)
    } finally {
      process.env['NODE_ENV'] = before
    }
  })
})

describe('an agent session', () => {
  it('reports the session, the model and the permission mode when it starts', async () => {
    const agent = session()
    const events = collect(agent)
    await agent.send('hello')
    await agent.waitForTurn()

    // The user's turn is in the stream first; the session answers after it.
    expect(events[0]).toEqual({ type: 'user-text', text: 'hello' })
    const started = events[1]
    expect(started).toMatchObject({
      type: 'started',
      sessionId: 'mock-session',
      model: 'claude-mock-1',
      permissionMode: 'default',
      cwd: '/tmp/nemesis-unit',
    })
    expect(agent.sessionId).toBe('mock-session')
    expect(agent.model).toBe('claude-mock-1')
    expect(agent.permissionMode).toBe('default')
    await agent.stop()
  })

  it('streams the assistant reply and ends the turn', async () => {
    const agent = session()
    const events = collect(agent)
    await agent.send('hello')
    const turn = await agent.waitForTurn()

    expect(kinds(events)).toEqual([
      'user-text',
      'started',
      'assistant-text',
      'turn-end',
      'context-usage',
    ])
    expect(events[2]).toEqual({ type: 'assistant-text', text: 'You said: hello' })
    expect(turn).toMatchObject({ type: 'turn-end', isError: false, result: 'You said: hello' })
    await agent.stop()
  })

  it('maps a thinking block of its own', async () => {
    const agent = session()
    const events = collect(agent)
    await agent.send('think: out loud')
    await agent.waitForTurn()

    expect(events[2]).toEqual({ type: 'assistant-thinking', text: 'out loud' })
    await agent.stop()
  })

  it('asks the permission handler before a tool runs, and reports the result', async () => {
    const asked: PermissionRequest[] = []
    const agent = session({
      permissionHandler: {
        requestPermission(request): Promise<PermissionDecision> {
          asked.push(request)
          return Promise.resolve({ behavior: 'allow' })
        },
      },
    })
    const events = collect(agent)
    await agent.send('tool: Bash')
    await agent.waitForTurn()

    expect(kinds(events)).toEqual([
      'user-text',
      'started',
      'tool-use',
      'tool-result',
      'assistant-text',
      'turn-end',
      'context-usage',
    ])
    expect(asked).toHaveLength(1)
    expect(asked[0]).toMatchObject({ toolName: 'Bash', input: { path: '/mock/notes.txt' } })
    expect(events[2]).toMatchObject({ type: 'tool-use', name: 'Bash' })
    expect(events[3]).toMatchObject({ type: 'tool-result', isError: false, text: 'Bash ran' })
    await agent.stop()
  })

  it('denies every tool when no handler is installed', async () => {
    const agent = session()
    const events = collect(agent)
    await agent.send('tool: Bash')
    await agent.waitForTurn()

    expect(events[3]).toMatchObject({ type: 'tool-result', isError: true })
    expect(events[4]).toEqual({ type: 'assistant-text', text: 'Did not run Bash.' })
    await agent.stop()
  })

  it('carries a denial message from the handler into the transcript', async () => {
    const agent = session({
      permissionHandler: {
        requestPermission(): Promise<PermissionDecision> {
          return Promise.resolve({ behavior: 'deny', message: 'not on a page buffer' })
        },
      },
    })
    const events = collect(agent)
    await agent.send('tool: Write')
    await agent.waitForTurn()

    expect(events[3]).toEqual({
      type: 'tool-result',
      toolUseId: 'mock-tool-1',
      isError: true,
      text: 'not on a page buffer',
    })
    await agent.stop()
  })

  it('asks a question through the handler and reads the answer off the updated input', async () => {
    const asked: PermissionRequest[] = []
    const agent = session({
      permissionHandler: {
        requestPermission(request): Promise<PermissionDecision> {
          asked.push(request)
          const answers: Record<string, string> = {}
          const questions = request.input['questions'] as { question: string }[]
          for (const question of questions) answers[question.question] = 'beta'
          return Promise.resolve({
            behavior: 'allow',
            updatedInput: { ...request.input, answers },
          })
        },
      },
    })
    const events = collect(agent)
    await agent.send('ask: Which one?')
    await agent.waitForTurn()

    expect(asked[0]).toMatchObject({ toolName: 'AskUserQuestion' })
    expect(asked[0]?.input).toMatchObject({
      questions: [{ question: 'Which one?', header: 'Choice', multiSelect: false }],
    })
    expect(events[2]).toMatchObject({ type: 'tool-use', name: 'AskUserQuestion' })
    expect(events[3]).toMatchObject({ type: 'tool-result', isError: false, text: 'beta' })
    expect(events[4]).toEqual({ type: 'assistant-text', text: 'You chose: beta' })
    await agent.stop()
  })

  it('reports a declined question as an error result', async () => {
    const agent = session()
    const events = collect(agent)
    await agent.send('ask: Which one?')
    await agent.waitForTurn()

    expect(events[3]).toMatchObject({ type: 'tool-result', isError: true })
    expect(events[4]).toEqual({ type: 'assistant-text', text: 'No answer.' })
    await agent.stop()
  })

  it('resumes by session id', async () => {
    const agent = session({ resume: 'earlier-session' })
    const events = collect(agent)
    expect(agent.sessionId).toBe('earlier-session')
    await agent.send('hello again')
    await agent.waitForTurn()

    expect(events[1]).toMatchObject({ type: 'started', sessionId: 'earlier-session' })
    await agent.stop()
  })

  it('counts turns across messages on one session', async () => {
    const agent = session()
    await agent.send('one')
    expect((await agent.waitForTurn()).numTurns).toBe(1)
    await agent.send('two')
    expect((await agent.waitForTurn()).numTurns).toBe(2)
    await agent.stop()
  })

  it('stops, and says the stream was interrupted', async () => {
    const agent = session()
    const events = collect(agent)
    await agent.send('hello')
    await agent.waitForTurn()
    await agent.stop()

    expect(events.at(-1)).toEqual({ type: 'stopped', reason: 'interrupted' })
    expect(agent.running).toBe(false)
    await agent.stop()
  })

  it('refuses to start twice', async () => {
    const agent = session()
    await agent.start()
    await expect(agent.start()).rejects.toThrow(/already started/)
    await agent.stop()
  })

  // Course corrections (#84): the turn stops, the session stays.
  it('interrupts a streaming turn and keeps the session for the next prompt', async () => {
    const agent = session()
    const events = collect(agent)
    expect(await agent.interrupt()).toBe(false)
    await agent.send('stream: tick')
    await vi.waitFor(() => {
      expect(events.some((event) => event.type === 'assistant-text')).toBe(true)
    })
    expect(agent.busy).toBe(true)
    const turn = agent.waitForTurn()
    expect(await agent.interrupt()).toBe(true)
    expect(await turn).toMatchObject({ type: 'turn-end', isError: true, result: /Interrupted/ })
    expect(agent.busy).toBe(false)
    expect(kinds(events)).not.toContain('stopped')

    await agent.send('after')
    expect((await agent.waitForTurn()).result).toBe('You said: after')
    expect(kinds(events).filter((kind) => kind === 'started')).toHaveLength(1)
    await agent.stop()
  })

  it('opens one checkpoint per prompt, each naming the entry ahead of it', async () => {
    const agent = session()
    expect(agent.checkpoints()).toEqual([])
    await agent.send('one')
    await agent.waitForTurn()
    await agent.send('two\nmore')
    await agent.waitForTurn()

    const checkpoints = agent.checkpoints()
    expect(checkpoints.map((c) => [c.index, c.text])).toEqual([
      [1, 'one'],
      [2, 'two\nmore'],
    ])
    expect(checkpoints[0]?.before).toBeNull()
    // The second checkpoint keeps the conversation up to the reply to the first.
    expect(checkpoints[1]?.before).toMatch(/^00000000-0000-4000-8000-/)
    expect(checkpoints[0]?.uuid).not.toBe(checkpoints[1]?.uuid)
    await agent.stop()
  })

  it('remembers the tool calls of the latest turn only', async () => {
    const agent = session({
      permissionHandler: {
        requestPermission(): Promise<PermissionDecision> {
          return Promise.resolve({ behavior: 'allow' })
        },
      },
    })
    await agent.send('tool: Bash')
    await agent.waitForTurn()
    expect(agent.lastToolCalls()).toEqual([{ name: 'Bash', input: { path: '/mock/notes.txt' } }])
    await agent.send('plain')
    await agent.waitForTurn()
    expect(agent.lastToolCalls()).toEqual([])
    await agent.stop()
  })

  it('rewinds files through the SDK at a checkpoint', async () => {
    const agent = session()
    await agent.send('one')
    await agent.waitForTurn()
    const [checkpoint] = agent.checkpoints()
    if (checkpoint === undefined) throw new Error('no checkpoint')
    expect(await agent.rewindFiles(checkpoint)).toMatchObject({ canRewind: true, filesChanged: [] })
    await agent.stop()
  })
})

describe('the default permission handler', () => {
  it('denies, naming the tool', async () => {
    const decision = await denyEveryTool.requestPermission({
      toolName: 'Bash',
      toolUseId: 'tool-1',
      input: {},
      signal: new AbortController().signal,
    })
    expect(decision).toEqual({
      behavior: 'deny',
      message: 'No permission handler is installed, so Bash was denied.',
    })
  })
})

describe('the event mapping', () => {
  it('ignores a frame the cockpit has no use for', () => {
    // Partial frames arrive only when the session asks for them, and it does not.
    const partial = { type: 'stream_event', session_id: 'mock-session' } as unknown as SDKMessage
    expect(eventsFromMessage(partial)).toEqual([])
  })
})

// The context meter and the compaction (#80), over the mock's usage numbers:
// a turn adds 2000 tokens, `usage: N` sets the context, `/compact` brings it
// back down with a boundary frame the way the CLI does.
describe('the context meter and compaction (#80)', () => {
  it('reports the last request against the window once a turn, after the result', async () => {
    const agent = session()
    const events = collect(agent)
    await agent.send('hello')
    await agent.waitForTurn()
    expect(events.at(-1)).toEqual({
      type: 'context-usage',
      usedTokens: 2000,
      windowTokens: 200_000,
    })
    await agent.send('usage: 150000')
    await agent.waitForTurn()
    expect(kinds(events).slice(-3)).toEqual(['assistant-text', 'turn-end', 'context-usage'])
    expect(events.at(-1)).toEqual({
      type: 'context-usage',
      usedTokens: 150_000,
      windowTokens: 200_000,
    })
    await agent.stop()
  })

  it('compacts on /compact: a notice with the sizes, the context down, and no checkpoint', async () => {
    const agent = session()
    const events = collect(agent)
    await agent.send('usage: 150000')
    await agent.waitForTurn()
    await agent.send('/compact keep the file list')
    await agent.waitForTurn()
    expect(kinds(events).slice(-4)).toEqual(['user-text', 'notice', 'turn-end', 'context-usage'])
    expect(events.at(-3)).toEqual({
      type: 'notice',
      text: 'Compacted the conversation (manual): 152000 tokens before, 2000 after.',
    })
    expect(events.at(-1)).toMatchObject({ usedTokens: 2000 })
    // The compaction is a command to the CLI, not a prompt: nothing to rewind to.
    expect(agent.checkpoints().map((c) => c.text)).toEqual(['usage: 150000'])
    await agent.stop()
  })

  it('spells the compact command and knows it when it sees it', () => {
    expect(compactCommand('')).toBe('/compact')
    expect(compactCommand('  \n ')).toBe('/compact')
    expect(compactCommand(' focus on the API ')).toBe('/compact focus on the API')
    expect(isCompactCommand('/compact')).toBe(true)
    expect(isCompactCommand('  /compact now')).toBe(true)
    expect(isCompactCommand('/compacted')).toBe(false)
    expect(isCompactCommand('compact this')).toBe(false)
  })

  it('reads the window off the result and the used tokens off the reply', () => {
    const reply = {
      message: {
        usage: { input_tokens: 100, cache_read_input_tokens: 50, cache_creation_input_tokens: 25 },
      },
    } as unknown as SDKAssistantMessage
    expect(usedTokensOf(reply)).toBe(175)
    const nulls = {
      message: {
        usage: {
          input_tokens: 7,
          cache_read_input_tokens: null,
          cache_creation_input_tokens: null,
        },
      },
    } as unknown as SDKAssistantMessage
    expect(usedTokensOf(nulls)).toBe(7)

    const usage = (tokens: number, contextWindow: number) => ({
      inputTokens: tokens,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      webSearchRequests: 0,
      costUSD: 0,
      contextWindow,
      maxOutputTokens: 1,
    })
    // The session's own model first, then the model that carried the most.
    expect(contextWindowOf({ main: usage(10, 200), helper: usage(900, 50) }, 'main')).toBe(200)
    expect(contextWindowOf({ main: usage(10, 200), helper: usage(900, 50) }, 'other')).toBe(50)
    expect(contextWindowOf({ main: usage(10, 200) }, null)).toBe(200)
    expect(contextWindowOf({}, 'main')).toBeNull()
    expect(contextWindowOf({ main: usage(10, 0) }, 'main')).toBeNull()
  })

  it('forks a resumed session under a new id, so a side question writes nowhere near it', async () => {
    const driver = mockDriver()
    const first = createAgentSession({ cwd: '/tmp/nemesis-unit', driver })
    await first.send('one')
    await first.waitForTurn()
    const fork = createAgentSession({
      cwd: '/tmp/nemesis-unit',
      driver,
      resume: 'mock-session',
      fork: true,
    })
    await fork.send('aside')
    await fork.waitForTurn()
    expect(fork.sessionId).toBe('mock-session-2')
    expect(first.sessionId).toBe('mock-session')
    await fork.stop()
    await first.stop()
  })
})
