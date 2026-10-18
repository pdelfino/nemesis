import { describe, expect, it, vi } from 'vitest'
import { nudgeText } from '../../src/main/agent/corrections'
import type { AgentEvent } from '../../src/main/agent/events'
import { mockDriver } from '../../src/main/agent/mock'
import { PromptQueue } from '../../src/main/agent/prompt-queue'
import { denyEveryTool } from '../../src/main/agent/session'
import type { PermissionHandler } from '../../src/main/agent/events'
import {
  describeCheckpoints,
  describeRewindPreview,
  PLAN_MODE_REMINDER,
  rewindConversationQuestion,
  rewindFilesQuestion,
  SessionManager,
  turnsDropped,
  undoPrompt,
} from '../../src/main/agent/session-manager'

// The manager holds the current session and replaces it (#84): new-task,
// a conversation rewind. One subscription hears every session in turn.

function manager(permissionHandler: PermissionHandler = denyEveryTool): SessionManager {
  return new SessionManager({
    cwd: '/tmp/nemesis-unit',
    model: null,
    permissionHandler,
    driver: mockDriver(),
  })
}

/** Lets the mock's Edit through, so a rewind has a file to list (#99). */
const allowEveryTool: PermissionHandler = {
  requestPermission: () => Promise.resolve({ behavior: 'allow' }),
}

function notices(events: readonly AgentEvent[]): string[] {
  return events.flatMap((event) => (event.type === 'notice' ? [event.text] : []))
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

  it('names the session as one event down the stream, which the recorder appends (#104)', () => {
    const agent = manager()
    const events = collect(agent)
    agent.nameSession('nemesis security review')
    agent.nameSession('renamed')
    expect(events).toEqual([
      { type: 'named', name: 'nemesis security review' },
      { type: 'named', name: 'renamed' },
    ])
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

  // The dry run of #99: the preview lists the file and changes nothing, the
  // real rewind after it restores, and the next preview is empty.
  it('previews a file rewind without restoring, then the real rewind restores', async () => {
    const agent = manager(allowEveryTool)
    const events = collect(agent)
    for (const text of ['one', 'edit: beta changed']) {
      const turn = nextTurn(agent)
      await agent.send(text)
      await turn
    }
    const second = agent.checkpoints()[1]
    if (second === undefined) throw new Error('no second checkpoint')
    const expected = {
      canRewind: true,
      filesChanged: ['/mock/notes.txt'],
      insertions: 1,
      deletions: 1,
    }
    expect(await agent.previewRewind(second)).toEqual(expected)
    // Nothing moved: the same preview again, and no notice in the stream.
    expect(await agent.previewRewind(second)).toEqual(expected)
    expect(notices(events)).toEqual([])

    agent.declineRewind(second)
    expect(notices(events)).toEqual(['Rewind: checkpoint 2 left as is, nothing restored.'])
    expect(await agent.previewRewind(second)).toEqual(expected)

    await agent.rewind(second, 'code')
    expect(notices(events).at(-1)).toBe('Rewind: files restored to checkpoint 2, 1 file changed.')
    expect(await agent.previewRewind(second)).toEqual({
      canRewind: true,
      filesChanged: [],
      insertions: 0,
      deletions: 0,
    })
    expect(agent.sessionId).toBe('mock-session')
    await agent.stop()
  })

  it('a dry run the SDK refuses is a notice with its reason', async () => {
    const agent = manager()
    const events = collect(agent)
    for (const text of ['one', 'two']) {
      const turn = nextTurn(agent)
      await agent.send(text)
      await turn
    }
    const second = agent.checkpoints()[1]
    if (second === undefined) throw new Error('no second checkpoint')
    // The resumed mock query knows only the messages it read itself, so the
    // kept checkpoint is the SDK's refusal with a reason.
    await agent.rewind(second, 'conversation')
    const [first] = agent.checkpoints()
    if (first === undefined) throw new Error('no kept checkpoint')
    expect(await agent.previewRewind(first)).toEqual({
      canRewind: false,
      error: 'the mock query has no record of that message',
    })
    expect(notices(events).at(-1)).toBe(
      'Rewind: files cannot be restored to checkpoint 1: the mock query has no record of that message.',
    )
    await agent.stop()
  })

  it('refuses a checkpoint from another session', async () => {
    const agent = manager()
    const events = collect(agent)
    const turn = nextTurn(agent)
    await agent.send('one')
    await turn
    const foreign = { index: 9, uuid: 'nope', before: null, text: 'x', at: 0 }
    await agent.rewind(foreign, 'code')
    expect(events.at(-1)).toMatchObject({
      type: 'notice',
      text: /checkpoint 9 is not in this session/,
    })
    expect(await agent.previewRewind(foreign)).toEqual({
      canRewind: false,
      error: 'not in this session',
    })
    expect(notices(events)).toHaveLength(2)
    await agent.stop()
  })
})

describe('the rewind preview text (#99)', () => {
  const checkpoint = { index: 2, uuid: 'b', before: 'x', text: 'two', at: 0 }

  it('lists the files with the counts, and the turns dropped for a rewind of both', () => {
    const result = {
      canRewind: true,
      filesChanged: ['/work/a.ts', '/work/b.ts'],
      insertions: 3,
      deletions: 1,
    }
    expect(describeRewindPreview(checkpoint, result, null).split('\n')).toEqual([
      'Rewind to checkpoint 2: the files that would change.',
      '',
      '  /work/a.ts',
      '  /work/b.ts',
      '',
      '2 files, 3 insertions, 1 deletion.',
    ])
    expect(describeRewindPreview(checkpoint, result, 2).split('\n').at(-1)).toBe(
      'The conversation goes back to before the checkpoint as well: 2 turns dropped.',
    )
    expect(rewindFilesQuestion(checkpoint, result)).toBe('Restore 2 files to checkpoint 2?')
  })

  it('says so when no file changed', () => {
    const result = { canRewind: true, filesChanged: [], insertions: 0, deletions: 0 }
    expect(describeRewindPreview(checkpoint, result, null).split('\n')).toEqual([
      'Rewind to checkpoint 2: the files that would change.',
      '',
      'None: no file changed since the checkpoint.',
      '',
      '0 files, 0 insertions, 0 deletions.',
    ])
    expect(rewindFilesQuestion(checkpoint, result)).toBe('Restore 0 files to checkpoint 2?')
  })

  it('counts the turns a conversation rewind drops: the checkpoint and every later one', () => {
    const checkpoints = [
      { index: 1, uuid: 'a', before: null, text: 'one', at: 0 },
      checkpoint,
      { index: 3, uuid: 'c', before: 'y', text: 'three', at: 0 },
    ]
    expect(turnsDropped(checkpoints, checkpoint)).toBe(2)
    expect(rewindConversationQuestion(checkpoint, 2)).toBe(
      'Restore the conversation to before checkpoint 2, dropping 2 turns?',
    )
    expect(rewindConversationQuestion(checkpoints[2] ?? checkpoint, 1)).toBe(
      'Restore the conversation to before checkpoint 3, dropping 1 turn?',
    )
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

  it('asks a side question with every tool denied, whatever the session itself allows', async () => {
    const asked: string[] = []
    const agent = new SessionManager({
      cwd: '/tmp/nemesis-unit',
      model: null,
      permissionHandler: {
        requestPermission: (request) => {
          asked.push(request.toolName)
          return Promise.resolve({ behavior: 'allow' })
        },
      },
      driver: mockDriver(),
    })
    const turn = nextTurn(agent)
    await agent.send('tool: Read')
    await turn
    expect(asked).toEqual(['Read'])
    // The aside asks the same tool; the session's handler never hears of it.
    expect(await agent.sideQuestion('tool: Bash')).toBe('Did not run Bash.')
    expect(asked).toEqual(['Read'])
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
