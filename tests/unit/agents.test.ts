import { describe, expect, it } from 'vitest'
import {
  AgentsBuffers,
  AgentStatus,
  renderAgents,
  type AgentLine,
  type AgentsSource,
} from '../../src/main/agents'
import type { AgentEvent } from '../../src/main/agent/events'
import { createCockpitBuffers } from '../../src/main/buffers'
import { CommandError } from '../../src/main/commands/registry'
import type { AgentsContent } from '../../src/shared/agents'

// The agents buffer (#157): one session's state off its events and its
// attention stream, the rendered list, and the buffer that redraws it.

/** A clock the test moves by hand. */
function clock(start = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let at = start
  return {
    now: () => at,
    advance: (ms) => {
      at += ms
    },
  }
}

const userText: AgentEvent = { type: 'user-text', text: 'never kept' }
const toolUse = (id: string): AgentEvent => ({
  type: 'tool-use',
  toolUseId: id,
  name: 'Bash',
  input: { command: 'never kept either' },
})
const request = (id: string): AgentEvent => ({
  type: 'permission-request',
  requestId: id,
  toolUseId: `t-${id}`,
  toolName: 'Bash',
  input: {},
})
const answered = (id: string): AgentEvent => ({
  type: 'permission-answered',
  requestId: id,
  toolName: 'Bash',
  outcome: 'allow',
})
const turnEnd = (isError = false): AgentEvent => ({
  type: 'turn-end',
  isError,
  result: 'never kept',
  durationMs: 1,
  numTurns: 1,
})
const finished = { type: 'session-finished', session: 's', elapsedMs: 0, toolCalls: 0 } as const
const failed = { type: 'session-error', session: 's', elapsedMs: 0, toolCalls: 0 } as const

describe('AgentStatus', () => {
  it('is idle before any prompt, named after the session once it starts', () => {
    const status = new AgentStatus()
    expect(status.snapshot).toEqual({
      session: 'Nemesis',
      state: 'idle',
      turnStartedAt: null,
      lastTurnMs: null,
      toolCalls: 0,
    })
    status.observe({
      type: 'started',
      sessionId: '0123456789abcdef',
      model: 'm',
      permissionMode: 'default',
      cwd: '/tmp',
      tools: [],
    })
    expect(status.snapshot.session).toBe('session 01234567')
    status.observe({ type: 'named', name: '  fix   the login  ' })
    expect(status.snapshot.session).toBe('fix the login')
  })

  it('follows a turn: working with its tool calls, waits on you, working again, finished', () => {
    const time = clock()
    const status = new AgentStatus(time.now)
    status.observe(userText)
    expect(status.snapshot).toMatchObject({
      state: 'working',
      turnStartedAt: 1_000_000,
      toolCalls: 0,
    })
    status.observe(toolUse('a'))
    status.observe(toolUse('b'))
    status.observe(request('r1'))
    expect(status.snapshot).toMatchObject({ state: 'waits on you', toolCalls: 2 })
    status.observe(answered('r1'))
    expect(status.snapshot.state).toBe('working')
    time.advance(12_000)
    // The manager's listeners hear the turn's end before the attention stream does.
    status.observe(turnEnd())
    status.attend(finished)
    expect(status.snapshot).toEqual({
      session: 'Nemesis',
      state: 'finished',
      turnStartedAt: null,
      lastTurnMs: 12_000,
      toolCalls: 2,
    })
    // The next turn counts its own calls.
    status.observe(userText)
    expect(status.snapshot).toMatchObject({ state: 'working', toolCalls: 0 })
  })

  it('waits on you until every open request is answered', () => {
    const status = new AgentStatus()
    status.observe(userText)
    status.observe(request('r1'))
    status.observe(request('r2'))
    status.observe(answered('r1'))
    expect(status.snapshot.state).toBe('waits on you')
    status.observe(answered('r2'))
    expect(status.snapshot.state).toBe('working')
  })

  it('reads error on an error turn or a failed stream', () => {
    const status = new AgentStatus()
    status.observe(userText)
    status.observe(turnEnd(true))
    status.attend(failed)
    expect(status.snapshot.state).toBe('error')
    status.observe(userText)
    status.observe({ type: 'error', message: 'never kept' })
    expect(status.snapshot.state).toBe('error')
  })

  it('reads idle after a turn the user interrupted, which raises no attention', () => {
    const status = new AgentStatus()
    status.observe(userText)
    status.observe(turnEnd(true))
    expect(status.snapshot.state).toBe('idle')
  })

  it('reads idle after the session stops, its requests dropped', () => {
    const status = new AgentStatus()
    status.observe(userText)
    status.observe(request('r1'))
    status.observe({ type: 'stopped', reason: 'ended' })
    expect(status.snapshot).toMatchObject({ state: 'idle', turnStartedAt: null })
    status.observe(userText)
    expect(status.snapshot.state).toBe('working')
  })

  it('says when it changed, and not for events it ignores', () => {
    const status = new AgentStatus()
    let changes = 0
    const off = status.onChange(() => {
      changes += 1
    })
    status.observe(userText)
    status.observe({ type: 'assistant-text', text: 'never kept' })
    status.attend({ type: 'session-needs-you', session: 's', elapsedMs: 0, toolCalls: 0 })
    expect(changes).toBe(1)
    off()
    status.observe(toolUse('a'))
    expect(changes).toBe(1)
  })
})

function line(overrides: Partial<AgentLine> = {}): AgentLine {
  return {
    windowId: 1,
    windowName: 'Window 1',
    cwd: '/Users/me/projects/nemesis',
    targetBufferId: 'b2',
    background: false,
    run: null,
    session: 'Nemesis',
    state: 'idle',
    turnStartedAt: null,
    lastTurnMs: null,
    toolCalls: 0,
    ...overrides,
  }
}

describe('renderAgents', () => {
  it('lists every session with its window, folder, state and detail, here marked', () => {
    const text = renderAgents(
      [
        line(),
        line({
          windowId: 2,
          windowName: 'Window 2',
          cwd: '/elsewhere/repo',
          session: 'fix-login',
          state: 'waits on you',
          turnStartedAt: 1_000_000 - 125_000,
          toolCalls: 3,
        }),
        line({
          windowId: 3,
          windowName: 'Window 3',
          session: 'session 01234567',
          state: 'finished',
          lastTurnMs: 12_000,
          toolCalls: 1,
        }),
      ],
      { here: 1, home: '/Users/me', now: 1_000_000 },
    )
    expect(text).toBe(
      [
        'Agents: 3 sessions, 1 waits on you',
        '',
        'Window 1 (here)  Nemesis           idle',
        '                 ~/projects/nemesis',
        'Window 2         fix-login         waits on you, for 2m 05s, 3 tool calls',
        '                 /elsewhere/repo',
        'Window 3         session 01234567  finished, after 12s, 1 tool call',
        '                 ~/projects/nemesis',
        '',
      ].join('\n'),
    )
  })

  it('marks a background session in place of here (#158)', () => {
    const text = renderAgents(
      [line(), line({ windowId: 2, windowName: 'Window 2', background: true })],
      { here: 1, home: '', now: 0 },
    )
    expect(text.split('\n')[4]).toMatch(/^Window 2 \(background\) {2}Nemesis {2}idle$/)
  })

  it('groups a fan-out run under a heading with its counts, after the other sessions (#160)', () => {
    const text = renderAgents(
      [
        line({
          windowId: 2,
          windowName: 'Window 2',
          background: true,
          run: 'Fix it',
          state: 'finished',
        }),
        line(),
        line({
          windowId: 3,
          windowName: 'Window 3',
          background: true,
          run: 'Fix it',
          state: 'error',
        }),
      ],
      { here: 1, home: '/Users/me', now: 0 },
    ).split('\n')
    expect(text[2]).toMatch(/^Window 1 \(here\) +Nemesis {2}idle$/)
    expect(text[4]).toBe('')
    expect(text[5]).toBe('Fan-out "Fix it": 2 sessions, 1 finished, 0 waiting, 1 failed')
    expect(text[6]).toMatch(/^Window 2 \(background\) {2}Nemesis {2}finished$/)
    expect(text[8]).toMatch(/^Window 3 \(background\) {2}Nemesis {2}error$/)
  })

  it('counts the working sessions, and says so when there is none', () => {
    expect(
      renderAgents([line({ state: 'working', turnStartedAt: 0 })], { here: 1, home: '', now: 0 }),
    ).toMatch(/^Agents: 1 session, 1 working\n/)
    expect(renderAgents([], { here: 1, home: '', now: 0 })).toBe('Agents: 0 sessions\n')
  })
})

/** A source the test changes by hand. */
function source(lines: AgentLine[]): AgentsSource & { change: () => void; listeners: number } {
  const listeners = new Set<() => void>()
  return {
    list: () => lines,
    onChange: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    change: () => {
      for (const listener of listeners) listener()
    },
    get listeners() {
      return listeners.size
    },
  }
}

describe('AgentsBuffers', () => {
  it('shows the list in an agents buffer, takes the point, and reuses it', () => {
    const buffers = createCockpitBuffers()
    const lines = [line()]
    const agents = new AgentsBuffers(buffers, {
      source: source(lines),
      here: 1,
      home: '/Users/me',
      switchTo: () => {},
      tickMs: 0,
    })
    const shown: AgentsContent[] = []
    agents.onShown((content) => shown.push(content))
    const buffer = agents.show()
    expect(buffer).toMatchObject({ kind: 'agents', title: 'Agents', elementId: 'agents' })
    expect(buffers.current?.id).toBe(buffer.id)
    expect(shown).toEqual([{ bufferId: buffer.id, text: agents.text() }])
    expect(agents.show().id).toBe(buffer.id)
  })

  it('redraws once per burst of changes while open, and not at all once killed', async () => {
    const buffers = createCockpitBuffers()
    const lines = [line()]
    const feed = source(lines)
    const agents = new AgentsBuffers(buffers, {
      source: feed,
      here: 1,
      home: '',
      switchTo: () => {},
      tickMs: 0,
    })
    const shown: AgentsContent[] = []
    agents.onShown((content) => shown.push(content))
    feed.change()
    await Promise.resolve()
    expect(shown).toHaveLength(0)
    const buffer = agents.show()
    lines[0] = line({ state: 'working', turnStartedAt: 0 })
    feed.change()
    feed.change()
    await Promise.resolve()
    expect(shown).toHaveLength(2)
    expect(shown[1]?.text).toContain('working')
    buffers.kill(buffer.id)
    feed.change()
    await Promise.resolve()
    expect(shown).toHaveLength(2)
  })

  it('opens a session on its window and prompt buffer, and refuses a closed window', () => {
    const switched: Array<[number, string]> = []
    const agents = new AgentsBuffers(createCockpitBuffers(), {
      source: source([line({ windowId: 7, targetBufferId: 'b9' })]),
      here: 1,
      home: '',
      switchTo: (windowId, bufferId) => switched.push([windowId, bufferId]),
      tickMs: 0,
    })
    agents.open(7)
    expect(switched).toEqual([[7, 'b9']])
    expect(() => agents.open(8)).toThrow(CommandError)
  })

  it('lets go of the source when disposed', () => {
    const feed = source([])
    const agents = new AgentsBuffers(createCockpitBuffers(), {
      source: feed,
      here: 1,
      home: '',
      switchTo: () => {},
      tickMs: 0,
    })
    expect(feed.listeners).toBe(1)
    agents.dispose()
    expect(feed.listeners).toBe(0)
  })
})
