import { describe, expect, it } from 'vitest'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { mockDriver } from '../../src/main/agent/mock'
import type { AgentSession } from '../../src/main/agent/session'
import { createAgentSession, denyEveryTool, eventsFromMessage } from '../../src/main/agent/session'
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

    expect(kinds(events)).toEqual(['user-text', 'started', 'assistant-text', 'turn-end'])
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
