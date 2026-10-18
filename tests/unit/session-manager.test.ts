import { describe, expect, it, vi } from 'vitest'
import { nudgeText } from '../../src/main/agent/corrections'
import type { AgentEvent } from '../../src/main/agent/events'
import { mockDriver } from '../../src/main/agent/mock'
import { PromptQueue } from '../../src/main/agent/prompt-queue'
import { denyEveryTool } from '../../src/main/agent/session'
import {
  describeCheckpoints,
  PLAN_MODE_REMINDER,
  SessionManager,
  undoPrompt,
} from '../../src/main/agent/session-manager'

// The manager holds the current session and replaces it (#84): new-task,
// a conversation rewind. One subscription hears every session in turn.

function manager(): SessionManager {
  return new SessionManager({
    cwd: '/tmp/nemesis-unit',
    model: null,
    permissionHandler: denyEveryTool,
    driver: mockDriver(),
  })
}

function collect(agent: SessionManager): AgentEvent[] {
  const events: AgentEvent[] = []
  agent.on((event) => events.push(event))
  return events
}

function kinds(events: readonly AgentEvent[]): string[] {
  return events.map((event) => event.type)
}

/** Resolves with the next turn-end the manager relays. */
function nextTurn(agent: SessionManager): Promise<AgentEvent> {
  return new Promise((resolve) => {
    const off = agent.on((event) => {
      if (event.type === 'turn-end') {
        off()
        resolve(event)
      }
    })
  })
}

describe('the session manager', () => {
  it('starts a session on the first send and relays its events', async () => {
    const agent = manager()
    const events = collect(agent)
    const turn = nextTurn(agent)
    await agent.send('hello')
    await turn
    expect(kinds(events)).toEqual([
      'user-text',
      'started',
      'assistant-text',
      'turn-end',
      'context-usage',
    ])
    expect(agent.sessionId).toBe('mock-session')
    await agent.stop()
  })

  it('new-task stops the session and the next prompt gets a fresh id', async () => {
    const agent = manager()
    const events = collect(agent)
    let turn = nextTurn(agent)
    await agent.send('one')
    await turn
    expect(agent.checkpoints()).toHaveLength(1)

    await agent.newTask()
    expect(agent.sessionId).toBeNull()
    expect(agent.checkpoints()).toEqual([])
    expect(events.at(-2)).toEqual({ type: 'stopped', reason: 'interrupted' })
    expect(events.at(-1)).toMatchObject({ type: 'notice', text: /New task/ })

    turn = nextTurn(agent)
    await agent.send('two')
    await turn
    expect(agent.sessionId).toBe('mock-session-2')
    expect(agent.checkpoints().map((c) => c.text)).toEqual(['two'])
    const starts = events.filter((event) => event.type === 'started')
    expect(starts.map((event) => (event.type === 'started' ? event.sessionId : ''))).toEqual([
      'mock-session',
      'mock-session-2',
    ])
    await agent.stop()
  })

  it('resumes a past session: the history goes to the window stream only and the old id continues', async () => {
    const agent = manager()
    const events = collect(agent)
    const shown: (readonly AgentEvent[])[] = []
    agent.onHistory((history) => shown.push(history))
    let turn = nextTurn(agent)
    await agent.send('one')
    await turn
    await agent.newTask()
    turn = nextTurn(agent)
    await agent.send('two')
    await turn
    expect(agent.sessionId).toBe('mock-session-2')

    // What the first session's folder holds, as the index reads it back (#67).
    const history: AgentEvent[] = events.slice(0, 4)
    expect(kinds(history)).toEqual(['user-text', 'started', 'assistant-text', 'turn-end'])
    const before = events.length
    await agent.resume('mock-session', history)
    expect(shown).toEqual([history])
    await vi.waitFor(() =>
      expect(kinds(events.slice(before))).toEqual(['stopped', 'notice', 'started']),
    )
    expect(events.at(-2)).toEqual({
      type: 'notice',
      text: 'Resumed session mock-session: 1 earlier turn shown above; the next prompt continues it.',
    })
    expect(events.at(-1)).toMatchObject({ type: 'started', sessionId: 'mock-session' })
    expect(agent.sessionId).toBe('mock-session')
    expect(agent.checkpoints()).toEqual([])

    turn = nextTurn(agent)
    await agent.send('three')
    await turn
    expect(events.at(-3)).toEqual({ type: 'assistant-text', text: 'You said: three' })
    expect(agent.sessionId).toBe('mock-session')
    expect(agent.checkpoints().map((c) => [c.index, c.text])).toEqual([[1, 'three']])
    await agent.stop()
  })

  it('resumes with no session running, so nothing stops first', async () => {
    const agent = manager()
    const events = collect(agent)
    await agent.resume('mock-session', [])
    await vi.waitFor(() => expect(kinds(events)).toEqual(['notice', 'started']))
    expect(events[0]).toMatchObject({ type: 'notice', text: /0 earlier turns shown above/ })
    expect(agent.sessionId).toBe('mock-session')
    await agent.stop()
  })

  it('resuming the current session is a notice and nothing else', async () => {
    const agent = manager()
    const events = collect(agent)
    const shown: (readonly AgentEvent[])[] = []
    agent.onHistory((history) => shown.push(history))
    const turn = nextTurn(agent)
    await agent.send('one')
    await turn
    const before = events.length
    await agent.resume('mock-session', [])
    expect(shown).toEqual([])
    expect(events.slice(before)).toEqual([
      { type: 'notice', text: 'Resume: mock-session is already the current session.' },
    ])
    await agent.stop()
  })

  it('starts the session in the mode set before it, and tells the running one of a change (#82)', async () => {
    const agent = manager()
    const events = collect(agent)
    expect(agent.permissionMode).toBe('default')
    expect(await agent.togglePlanMode()).toBe('plan')
    expect(events).toEqual([
      { type: 'permission-mode', mode: 'plan' },
      { type: 'nudge', text: PLAN_MODE_REMINDER },
    ])
    let turn = nextTurn(agent)
    await agent.send('hello')
    await turn
    expect(events.find((event) => event.type === 'started')).toMatchObject({
      permissionMode: 'plan',
    })
    // Off again: the session is told, no second callout.
    expect(await agent.togglePlanMode()).toBe('default')
    expect(await agent.togglePlanMode()).toBe('plan')
    expect(events.filter((event) => event.type === 'nudge')).toHaveLength(1)
    // An approved plan goes back to the mode plan mode replaced.
    await agent.leavePlanMode()
    expect(agent.permissionMode).toBe('default')
    await agent.leavePlanMode()
    expect(
      events
        .filter((event) => event.type === 'permission-mode')
        .map((e) => (e.type === 'permission-mode' ? e.mode : '')),
    ).toEqual(['plan', 'default', 'plan', 'default'])
    // A fresh session owes the callout again.
    await agent.newTask()
    await agent.togglePlanMode()
    expect(events.filter((event) => event.type === 'nudge')).toHaveLength(2)
    turn = nextTurn(agent)
    await agent.send('again')
    await turn
    expect(events.filter((event) => event.type === 'started').at(-1)).toMatchObject({
      sessionId: 'mock-session-2',
      permissionMode: 'plan',
    })
    await agent.stop()
  })

  it('new-task with no session is a no-op', async () => {
    const agent = manager()
    const events = collect(agent)
    await agent.newTask()
    expect(events).toEqual([])
  })

  it('interrupts the running turn through the prompt queue and keeps the session', async () => {
    const agent = manager()
    const events = collect(agent)
    const queue = new PromptQueue(agent)
    expect(await agent.interrupt()).toBe(false)
    await queue.submit('stream: go')
    await vi.waitFor(() => {
      expect(events.some((event) => event.type === 'assistant-text')).toBe(true)
    })
    expect(agent.busy).toBe(true)
    const turn = nextTurn(agent)
    expect(await agent.interrupt()).toBe(true)
    await turn
    await vi.waitFor(() => expect(queue.state().busy).toBe(false))
    expect(kinds(events)).not.toContain('stopped')
    expect(agent.sessionId).toBe('mock-session')
    await agent.stop()
  })

  it('restores the conversation to a checkpoint by resuming the session cut before it', async () => {
    const agent = manager()
    const events = collect(agent)
    for (const text of ['one', 'two', 'three']) {
      const turn = nextTurn(agent)
      await agent.send(text)
      await turn
    }
    const third = agent.checkpoints()[2]
    if (third === undefined) throw new Error('no third checkpoint')

    await agent.rewind(third, 'conversation')
    // The resumed session keeps the id and the two checkpoints before the cut.
    expect(agent.sessionId).toBe('mock-session')
    expect(agent.checkpoints().map((c) => c.index)).toEqual([1, 2])
    expect(events.filter((event) => event.type === 'stopped')).toHaveLength(1)
    expect(events.at(-2)).toMatchObject({
      type: 'notice',
      text: /before checkpoint 3; 2 checkpoints kept/,
    })
    expect(events.at(-1)).toMatchObject({ type: 'started', sessionId: 'mock-session' })

    const turn = nextTurn(agent)
    await agent.send('four')
    await turn
    expect(agent.checkpoints().map((c) => [c.index, c.text])).toEqual([
      [1, 'one'],
      [2, 'two'],
      [3, 'four'],
    ])
    await agent.stop()
  })

  it('restores to the first checkpoint by starting over', async () => {
    const agent = manager()
    const events = collect(agent)
    const turn = nextTurn(agent)
    await agent.send('one')
    await turn
    const [first] = agent.checkpoints()
    if (first === undefined) throw new Error('no checkpoint')
    await agent.rewind(first, 'both')
    expect(
      events
        .filter((event) => event.type === 'notice')
        .map((e) => (e.type === 'notice' ? e.text : '')),
    ).toEqual([
      'Rewind: files restored to checkpoint 1, 0 files changed.',
      'Rewind: conversation restored to before checkpoint 1; the next prompt starts a fresh session.',
    ])
    expect(agent.checkpoints()).toEqual([])
    expect(agent.sessionId).toBe('mock-session-2')
    await agent.stop()
  })

  it('refuses a checkpoint from another session', async () => {
    const agent = manager()
    const events = collect(agent)
    const turn = nextTurn(agent)
    await agent.send('one')
    await turn
    await agent.rewind({ index: 9, uuid: 'nope', before: null, text: 'x', at: 0 }, 'code')
    expect(events.at(-1)).toMatchObject({
      type: 'notice',
      text: /checkpoint 9 is not in this session/,
    })
    await agent.stop()
  })
})

describe('the rewind buffer text', () => {
  it('explains what is unavailable when nothing was sent', () => {
    const text = describeCheckpoints([])
    expect(text).toContain('None yet')
    expect(text).toContain('Summarize from here: not available')
  })

  it('lists one line per checkpoint with the first line of the prompt', () => {
    const at = new Date(2026, 9, 18, 14, 3, 9).getTime()
    const lines = describeCheckpoints([
      { index: 1, uuid: 'a', before: null, text: 'alpha one', at },
      { index: 2, uuid: 'b', before: 'x', text: '\n  beta two\nmore', at },
    ]).split('\n')
    expect(lines[2]).toBe('1. 14:03:09  alpha one')
    expect(lines[3]).toBe('2. 14:03:09  beta two')
  })
})

describe('the undo prompt', () => {
  it("is the guide's sentence alone when the last turn ran no tool", () => {
    expect(undoPrompt([])).toBe('Undo that.')
  })

  it('quotes the tool calls as data in a fenced block, cut to a line each', () => {
    const text = undoPrompt([
      { name: 'Bash', input: { command: 'rm notes.txt' } },
      { name: 'Write', input: { content: 'x'.repeat(400) } },
    ])
    const lines = text.split('\n')
    expect(lines[0]).toBe('Undo that. The last tool calls were:')
    expect(lines[2]).toBe('```')
    expect(lines[3]).toBe('Bash {"command":"rm notes.txt"}')
    expect(lines[4]?.length).toBe('Write '.length + 200)
    expect(lines[4]?.endsWith('...')).toBe(true)
    expect(lines[5]).toBe('```')
  })
})

// The guide's context management (#80): the nudge at the second correction
// in a row, and the side question that leaves the session's history alone.
describe('the correction nudge and the side question (#80)', () => {
  it('nudges at the second correction in a row, after the turn, and starts over with the session', async () => {
    const agent = manager()
    const events = collect(agent)
    for (const text of ['build it', 'no, the other way']) {
      const turn = nextTurn(agent)
      await agent.send(text)
      await turn
    }
    expect(kinds(events)).not.toContain('nudge')
    expect(agent.correctionStreak).toBe(1)
    const turn = nextTurn(agent)
    await agent.send('wrong file')
    await turn
    const at = events.findIndex((event) => event.type === 'nudge')
    expect(events[at - 1]).toEqual({ type: 'user-text', text: 'wrong file' })
    expect(events[at]).toEqual({ type: 'nudge', text: nudgeText(2) })
    expect(kinds(events).filter((kind) => kind === 'nudge')).toHaveLength(1)

    // A turn that is not a correction ends the streak; `correct` says one in
    // advance, and the second one said that way nudges at once.
    const plain = nextTurn(agent)
    await agent.send('thanks')
    await plain
    expect(agent.correctionStreak).toBe(0)
    agent.markCorrection()
    expect(kinds(events).filter((kind) => kind === 'nudge')).toHaveLength(1)
    agent.markCorrection()
    expect(events.at(-1)).toEqual({ type: 'nudge', text: nudgeText(2) })

    await agent.newTask()
    expect(agent.correctionStreak).toBe(0)
    await agent.stop()
  })

  it('answers a side question from a fork and leaves the session, its events and its checkpoints alone', async () => {
    const agent = manager()
    const events = collect(agent)
    let turn = nextTurn(agent)
    await agent.send('one')
    await turn
    const before = events.length

    const answer = await agent.sideQuestion('what is two')
    expect(answer).toBe('You said: what is two')
    expect(events).toHaveLength(before)
    expect(agent.sessionId).toBe('mock-session')
    expect(agent.checkpoints().map((c) => c.text)).toEqual(['one'])

    // The next prompt continues the same session, not the fork.
    turn = nextTurn(agent)
    await agent.send('two')
    await turn
    expect(events.filter((event) => event.type === 'started')).toHaveLength(1)
    expect(events.at(-3)).toEqual({ type: 'assistant-text', text: 'You said: two' })
    await agent.stop()
  })

  it('answers a side question with no session running from a throwaway one', async () => {
    const agent = manager()
    const events = collect(agent)
    expect(await agent.sideQuestion('hi')).toBe('You said: hi')
    expect(events).toEqual([])
    expect(agent.sessionId).toBeNull()
  })
})
