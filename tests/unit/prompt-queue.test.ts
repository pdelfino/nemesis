import { describe, expect, it, vi } from 'vitest'
import type { AgentEvent, AgentEventListener } from '../../src/main/agent/events'
import {
  formatKilobytes,
  imageMarker,
  MAX_IMAGE_BYTES,
  type ClipboardImage,
} from '../../src/main/agent/images'
import { mockDriver } from '../../src/main/agent/mock'
import type { PromptTarget } from '../../src/main/agent/prompt-queue'
import { parseDraft, parsePromptText, PromptQueue } from '../../src/main/agent/prompt-queue'
import { createAgentSession, type UserImageBlock } from '../../src/main/agent/session'
import { MAX_PROMPT_LENGTH } from '../../src/shared/agent'

// The queue is the main-process half of the prompt buffer (#61): one prompt
// to the agent at a time, the rest shown as queued, history and draft kept so
// a reload or a failed send loses nothing.

/** A session whose turns end when the test says so. */
class FakeSession implements PromptTarget {
  readonly sent: string[] = []
  /** The image blocks that came with each send, by position in `sent`. */
  readonly images: (readonly UserImageBlock[])[] = []
  private readonly listeners = new Set<AgentEventListener>()
  failNext: Error | null = null

  send(text: string, images: readonly UserImageBlock[] = []): Promise<void> {
    if (this.failNext !== null) {
      const error = this.failNext
      this.failNext = null
      return Promise.reject(error)
    }
    this.sent.push(text)
    this.images.push(images)
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

  it('takes the prompts of a resumed session as the history, in their place (#104)', async () => {
    const session = new FakeSession()
    const queue = new PromptQueue(session)
    await queue.submit('before the resume')
    queue.seedHistory(['one', 'two', 'two', 'three'])
    expect(queue.history()).toEqual(['one', 'two', 'three'])
    expect(queue.promptState().history).toEqual(['one', 'two', 'three'])
    // The newest prompts are the ones kept when the resumed session is long.
    queue.seedHistory(Array.from({ length: 120 }, (_, i) => `p${i}`))
    expect(queue.history()).toHaveLength(100)
    expect(queue.history()[0]).toBe('p20')
    expect(queue.history().at(-1)).toBe('p119')
    // A send after the seed goes on the end, as before.
    session.endTurn()
    await settle()
    await queue.submit('after')
    expect(queue.history().at(-1)).toBe('after')
    expect(queue.history()).toHaveLength(100)
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

/** A PNG signature and some bytes behind it: the queue reads the size, never the pixels. */
function png(bytes: number, width = 1280, height = 800): ClipboardImage {
  const data = new Uint8Array(bytes)
  data.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  return { png: data, width, height }
}

describe('images attached to the prompt (#83)', () => {
  it('spells the marker with the index, the pixels and whole kilobytes', () => {
    expect(formatKilobytes(245_760)).toBe('240 KB')
    expect(formatKilobytes(67)).toBe('1 KB')
    expect(imageMarker(1, png(245_760))).toBe('[image 1: 1280x800 png, 240 KB]')
    expect(imageMarker(3, png(2048, 32, 16))).toBe('[image 3: 32x16 png, 2 KB]')
  })

  it('keeps the image for the next prompt, puts its marker in the prompt, and sends it as a block next to the text', async () => {
    const session = new FakeSession()
    const queue = new PromptQueue(session)
    const inserts: string[] = []
    queue.onInsert((insert) => inserts.push(insert.text))

    const attached = queue.attachImage(png(2048))
    expect(attached).toMatchObject({ index: 1, marker: '[image 1: 1280x800 png, 2 KB]' })
    expect(inserts).toEqual(['[image 1: 1280x800 png, 2 KB]'])
    expect(queue.attached().map((image) => image.marker)).toEqual(inserts)

    await queue.submit('Compare this with the mock.\n\n[image 1: 1280x800 png, 2 KB]')
    expect(session.sent).toEqual(['Compare this with the mock.\n\n[image 1: 1280x800 png, 2 KB]'])
    expect(session.images[0]).toHaveLength(1)
    expect(session.images[0]?.[0]).toMatchObject({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png' },
    })
    const source = session.images[0]?.[0]?.source
    expect(source?.type === 'base64' ? Buffer.from(source.data, 'base64').byteLength : -1).toBe(
      2048,
    )
    // The next prompt starts with no image; the history and the state carry text only.
    expect(queue.attached()).toEqual([])
    expect(queue.history()).toEqual([
      'Compare this with the mock.\n\n[image 1: 1280x800 png, 2 KB]',
    ])
    expect(JSON.stringify(queue.promptState())).not.toContain('base64')
  })

  it('drops an image whose marker was deleted from the prompt, and numbers the rest as attached', async () => {
    const session = new FakeSession()
    const queue = new PromptQueue(session)
    queue.attachImage(png(1024, 10, 10))
    queue.attachImage(png(1024, 20, 20))
    await queue.submit('only the second: [image 2: 20x20 png, 1 KB]')
    expect(session.images[0]).toHaveLength(1)
    expect(queue.attached()).toEqual([])
  })

  it("keeps a queued prompt's images until its turn", async () => {
    const session = new FakeSession()
    const queue = new PromptQueue(session)
    await queue.submit('first')
    const second = queue.attachImage(png(512))
    await queue.submit(`second ${second.marker}`)
    expect(session.images).toEqual([[]])
    expect(queue.state()).toEqual({
      busy: true,
      queued: [{ id: 'p2', text: `second ${second.marker}` }],
    })
    session.endTurn()
    await settle()
    expect(session.sent).toEqual(['first', `second ${second.marker}`])
    expect(session.images[1]).toHaveLength(1)
  })

  it('refuses a fifth image and one over five megabytes', () => {
    const queue = new PromptQueue(new FakeSession())
    for (let n = 0; n < 4; n += 1) queue.attachImage(png(16))
    expect(() => queue.attachImage(png(16))).toThrow(/4 images are already attached/)
    expect(queue.attached()).toHaveLength(4)
    const fresh = new PromptQueue(new FakeSession())
    expect(() => fresh.attachImage(png(MAX_IMAGE_BYTES + 1))).toThrow(/5 MB at most/)
    expect(fresh.attached()).toEqual([])
    fresh.attachImage(png(MAX_IMAGE_BYTES))
    expect(fresh.attached()).toHaveLength(1)
  })

  it('keeps the images attached when the send itself fails, since the text stays in the editor', async () => {
    const session = new FakeSession()
    const queue = new PromptQueue(session)
    const image = queue.attachImage(png(64))
    session.failNext = new Error('input closed')
    await expect(queue.submit(`see ${image.marker}`)).rejects.toThrow('input closed')
    expect(queue.attached().map((attached) => attached.marker)).toEqual([image.marker])
    await queue.submit(`see ${image.marker}`)
    expect(session.images[0]).toHaveLength(1)
  })
})

describe('editing the queue (#193)', () => {
  /** A queue busy with a first prompt, then each prompt queued with its images. */
  async function queueBehindATurn(
    prompts: readonly { text: string; images?: readonly ClipboardImage[] }[],
  ): Promise<{ session: FakeSession; queue: PromptQueue; ids: string[] }> {
    const session = new FakeSession()
    const queue = new PromptQueue(session)
    await queue.submit('running')
    const ids: string[] = []
    for (const { text, images = [] } of prompts) {
      const markers = images.map((image) => queue.attachImage(image).marker)
      const receipt = await queue.submit([text, ...markers].join('\n'))
      ids.push(receipt.id)
    }
    return { session, queue, ids }
  }

  it('take returns the text and the images, and the queue shrinks and still advances', async () => {
    const { session, queue, ids } = await queueBehindATurn([
      { text: 'first', images: [png(2048)] },
      { text: 'second' },
    ])
    const states = vi.fn()
    queue.subscribe(states)

    const taken = queue.take(ids[0] ?? '')
    expect(taken.text).toBe('first\n[image 1: 1280x800 png, 2 KB]')
    expect(taken.images.map((image) => image.png.byteLength)).toEqual([2048])
    expect(queue.state().queued).toEqual([{ id: ids[1], text: 'second' }])
    expect(states).toHaveBeenLastCalledWith(queue.state())
    expect(() => queue.take(ids[0] ?? '')).toThrow(/no longer in the queue/)

    session.endTurn()
    await settle()
    expect(session.sent).toEqual(['running', 'second'])
  })

  it('remove drops one and the queue still advances', async () => {
    const { session, queue, ids } = await queueBehindATurn([
      { text: 'first' },
      { text: 'second' },
      { text: 'third' },
    ])
    queue.remove(ids[1] ?? '')
    expect(queue.state().queued.map((prompt) => prompt.text)).toEqual(['first', 'third'])

    session.endTurn()
    await settle()
    session.endTurn()
    await settle()
    expect(session.sent).toEqual(['running', 'first', 'third'])
  })

  it('merge gives one prompt in order with every image, renumbered, and the queue still advances', async () => {
    const { session, queue, ids } = await queueBehindATurn([
      { text: 'first', images: [png(2048)] },
      { text: 'second' },
      { text: 'third', images: [png(3072, 32, 16)] },
    ])
    expect(queue.mergeAll()).toBe(3)
    const merged =
      'first\n[image 1: 1280x800 png, 2 KB]\n\nsecond\n\nthird\n[image 2: 32x16 png, 3 KB]'
    expect(queue.state().queued).toEqual([{ id: ids[0], text: merged }])

    session.endTurn()
    await settle()
    expect(session.sent).toEqual(['running', merged])
    expect(session.images[1]).toHaveLength(2)
    const sizes = (session.images[1] ?? []).map((block) =>
      block.source.type === 'base64' ? Buffer.from(block.source.data, 'base64').byteLength : -1,
    )
    expect(sizes).toEqual([2048, 3072])
    session.endTurn()
    await settle()
    expect(queue.state()).toEqual({ busy: false, queued: [] })
  })

  it('merge leaves an empty queue and a single prompt as they are, and refuses past the image cap', async () => {
    const { queue } = await queueBehindATurn([{ text: 'only' }])
    expect(queue.mergeAll()).toBe(1)
    expect(queue.state().queued.map((prompt) => prompt.text)).toEqual(['only'])
    expect(new PromptQueue(new FakeSession()).mergeAll()).toBe(0)

    const crowded = await queueBehindATurn([
      { text: 'a', images: [png(10), png(10), png(10)] },
      { text: 'b', images: [png(10), png(10)] },
    ])
    expect(() => crowded.queue.mergeAll()).toThrow(/5 images/)
    expect(crowded.queue.state().queued).toHaveLength(2)
  })

  it('edit puts the text after the draft and re-attaches its images after those of the draft', async () => {
    const { session, queue, ids } = await queueBehindATurn([
      { text: 'queued', images: [png(2048)] },
    ])
    const inserts: string[] = []
    queue.onInsert((insert) => inserts.push(insert.text))
    queue.attachImage(png(4096))
    inserts.length = 0

    queue.edit(ids[0] ?? '')
    expect(inserts).toEqual(['queued\n[image 2: 1280x800 png, 2 KB]'])
    expect(queue.state().queued).toEqual([])
    expect(queue.attached().map((image) => image.marker)).toEqual([
      '[image 1: 1280x800 png, 4 KB]',
      '[image 2: 1280x800 png, 2 KB]',
    ])

    session.endTurn()
    await settle()
    await queue.submit(
      'draft\n[image 1: 1280x800 png, 4 KB]\n\nqueued\n[image 2: 1280x800 png, 2 KB]',
    )
    expect(session.images[1]).toHaveLength(2)
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
