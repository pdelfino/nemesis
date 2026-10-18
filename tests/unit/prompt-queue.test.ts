import { describe, expect, it, vi } from 'vitest'
import type { AgentEvent, AgentEventListener } from '../../src/main/agent/events'
import { mockDriver } from '../../src/main/agent/mock'
import type { PromptTarget } from '../../src/main/agent/prompt-queue'
import { parseDraft, parsePromptText, PromptQueue } from '../../src/main/agent/prompt-queue'
import { createAgentSession } from '../../src/main/agent/session'
import { MAX_PROMPT_LENGTH } from '../../src/shared/agent'

// The queue is the main-process half of the prompt buffer (#61): one prompt
// to the agent at a time, the rest shown as queued, history and draft kept so
// a reload or a failed send loses nothing.

/** A session whose turns end when the test says so. */
class FakeSession implements PromptTarget {
  readonly sent: string[] = []
  private readonly listeners = new Set<AgentEventListener>()
  failNext: Error | null = null

  send(text: string): Promise<void> {
    if (this.failNext !== null) {
      const error = this.failNext
      this.failNext = null
      return Promise.reject(error)
    }
    this.sent.push(text)
    return Promise.resolve()
  }

  on(listener: AgentEventListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  emit(event: AgentEvent): void {
    for (const listener of this.listeners) listener(event)
  }

  endTurn(): void {
    this.emit({ type: 'turn-end', isError: false, result: '', durationMs: 1, numTurns: 1 })
  }
}

/** Lets the queue's own listener run after an event. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe('the prompt queue', () => {
  it('sends at once when the agent is idle and queues while it is busy', async () => {
    const session = new FakeSession()
    const queue = new PromptQueue(session)
    const states = vi.fn()
    queue.subscribe(states)

    expect(await queue.submit('first')).toEqual({ id: 'p1', status: 'sent', position: 0 })
    expect(session.sent).toEqual(['first'])
    expect(queue.state()).toEqual({ busy: true, queued: [] })

    expect(await queue.submit('second')).toEqual({ id: 'p2', status: 'queued', position: 1 })
    expect(await queue.submit('third')).toEqual({ id: 'p3', status: 'queued', position: 2 })
    expect(session.sent).toEqual(['first'])
    expect(queue.state()).toEqual({
      busy: true,
      queued: [
        { id: 'p2', text: 'second' },
        { id: 'p3', text: 'third' },
      ],
    })

    session.endTurn()
    await settle()
    expect(session.sent).toEqual(['first', 'second'])
    expect(queue.state()).toEqual({ busy: true, queued: [{ id: 'p3', text: 'third' }] })

    session.endTurn()
    await settle()
    session.endTurn()
    await settle()
    expect(session.sent).toEqual(['first', 'second', 'third'])
    expect(queue.state()).toEqual({ busy: false, queued: [] })
    expect(states).toHaveBeenCalled()
  })

  it('goes idle again when the stream errors or stops mid-turn', async () => {
    const session = new FakeSession()
    const queue = new PromptQueue(session)
    await queue.submit('hello')
    session.emit({ type: 'error', message: 'gone' })
    await settle()
    expect(queue.state().busy).toBe(false)

    await queue.submit('again')
    session.emit({ type: 'stopped', reason: 'ended' })
    await settle()
    expect(queue.state().busy).toBe(false)
  })

  it('rejects a send that fails and drops the prompt, so the renderer keeps the text', async () => {
    const session = new FakeSession()
    const queue = new PromptQueue(session)
    session.failNext = new Error('input closed')
    await expect(queue.submit('lost?')).rejects.toThrow('input closed')
    expect(queue.state()).toEqual({ busy: false, queued: [] })
    expect(session.sent).toEqual([])
    // The next send works as if nothing happened.
    expect(await queue.submit('retry')).toMatchObject({ status: 'sent' })
  })

  it('keeps a queued prompt whose send fails at the head of the queue', async () => {
    const session = new FakeSession()
    const queue = new PromptQueue(session)
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    await queue.submit('first')
    await queue.submit('second')
    session.failNext = new Error('input closed')
    session.endTurn()
    await settle()
    expect(queue.state()).toEqual({ busy: false, queued: [{ id: 'p2', text: 'second' }] })
    expect(errors).toHaveBeenCalledWith('Could not send the next queued prompt:', 'input closed')
    errors.mockRestore()

    // The next submit sends the stalled prompt first, in order.
    expect(await queue.submit('third')).toEqual({ id: 'p3', status: 'queued', position: 1 })
    expect(session.sent).toEqual(['first', 'second'])
  })

  it('remembers sent prompts oldest first, without consecutive repeats', async () => {
    const session = new FakeSession()
    const queue = new PromptQueue(session)
    await queue.submit('one')
    await queue.submit('two')
    await queue.submit('two')
    await queue.submit('one')
    expect(queue.history()).toEqual(['one', 'two', 'one'])
  })

  it('keeps the history to the last hundred prompts', async () => {
    const session = new FakeSession()
    const queue = new PromptQueue(session)
    for (let index = 0; index < 105; index += 1) await queue.submit(`prompt ${index}`)
    expect(queue.history()).toHaveLength(100)
    expect(queue.history()[0]).toBe('prompt 5')
  })

  it('parks the draft and hands everything back for a reload', async () => {
    const session = new FakeSession()
    const queue = new PromptQueue(session)
    await queue.submit('sent')
    await queue.submit('waiting')
    queue.saveDraft('half a thou')
    expect(queue.promptState()).toEqual({
      draft: 'half a thou',
      history: ['sent', 'waiting'],
      queue: { busy: true, queued: [{ id: 'p2', text: 'waiting' }] },
    })
  })

  it('hands text a command adds to the prompt to the window, leaving the parked draft alone (#81)', () => {
    const queue = new PromptQueue(new FakeSession())
    queue.saveDraft('typed so far')
    const inserts: string[] = []
    const off = queue.onInsert((insert) => inserts.push(insert.text))
    queue.insert('Example cases: a is b.')
    expect(inserts).toEqual(['Example cases: a is b.'])
    expect(queue.draft).toBe('typed so far')
    off()
    queue.insert('unheard')
    expect(inserts).toHaveLength(1)
  })

  it('drives the mock Agent SDK, answering queued prompts in order', async () => {
    const agent = createAgentSession({ cwd: '/tmp/nemesis-unit', driver: mockDriver() })
    const replies: string[] = []
    agent.on((event) => {
      if (event.type === 'assistant-text') replies.push(event.text)
    })
    const queue = new PromptQueue(agent)
    await queue.submit('alpha')
    await queue.submit('beta')
    await vi.waitFor(() => {
      expect(replies).toEqual(['You said: alpha', 'You said: beta'])
    })
    await vi.waitFor(() => {
      expect(queue.state()).toEqual({ busy: false, queued: [] })
    })
    await agent.stop()
  })
})

describe('what the main process accepts from a page', () => {
  it('validates the prompt payload', () => {
    expect(parsePromptText('hello')).toBe('hello')
    expect(() => parsePromptText('   \n')).toThrow(/empty/)
    expect(() => parsePromptText(42)).toThrow(/not a string/)
    expect(() => parsePromptText('x'.repeat(MAX_PROMPT_LENGTH + 1))).toThrow(/too long/)
  })

  it('accepts an empty draft but not a long one', () => {
    expect(parseDraft('')).toBe('')
    expect(() => parseDraft(null)).toThrow(/not a string/)
    expect(() => parseDraft('x'.repeat(MAX_PROMPT_LENGTH + 1))).toThrow(/too long/)
  })
})
