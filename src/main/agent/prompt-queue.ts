import type {
  PromptInsert,
  PromptQueueState,
  PromptReceipt,
  PromptState,
  QueuedPrompt,
} from '../../shared/agent'
import { MAX_PROMPT_LENGTH } from '../../shared/agent'
import { CommandError } from '../commands/registry'
import {
  assertImageFits,
  imageBlock,
  imageMarker,
  MAX_IMAGES_PER_PROMPT,
  type ClipboardImage,
  type PromptImage,
} from './images'
import type { AgentSession } from './session'

/**
 * The main-process half of the prompt buffer (#61): the prompts waiting for
 * the agent, the history of the prompts sent, and the draft being typed. All
 * of it lives here, per session, so a reload of the window or a failed send
 * loses no text; the prompt buffer in the renderer is a view of this state.
 *
 * One prompt goes to the agent at a time. The SDK would take a second user
 * message mid-turn, but the cockpit wants to show what waits and in what
 * order, so the queue is held here and advanced when a turn ends. Only
 * `steer` (#194) sends mid-turn, on purpose, past what waits.
 *
 * Images attached to the prompt being composed (#83) wait here too, as PNG
 * bytes behind a marker line in the text. The send takes the images whose
 * marker is still in the prompt, as content blocks next to the text; a
 * marker deleted from the prompt drops its image. The state the window
 * sees, the history and the draft carry the text alone.
 *
 * Plain data, no Electron types, like src/main/buffers.ts: the unit tests
 * drive it with a fake session and the bridge wires it to the window.
 */

/** How many sent prompts `M-p` can walk back through. */
const HISTORY_LIMIT = 100

export type PromptQueueListener = (state: PromptQueueState) => void

export type PromptInsertListener = (insert: PromptInsert) => void

/** What the queue needs from a session: send, and say when a turn is over. */
export type PromptTarget = Pick<AgentSession, 'send' | 'on'>

/** A queued prompt with the images that go with it; the window sees the text only. */
interface PendingPrompt extends QueuedPrompt {
  readonly images: readonly PromptImage[]
}

export class PromptQueue {
  private readonly session: PromptTarget
  private readonly listeners = new Set<PromptQueueListener>()
  private readonly insertListeners = new Set<PromptInsertListener>()
  private readonly queued: PendingPrompt[] = []
  private readonly sent: string[] = []
  private attachedImages: PromptImage[] = []
  private draftText = ''
  private busy = false
  /** The prompt whose send is under way: still at the head, but no longer to be edited. */
  private sending: string | null = null
  private counter = 0

  constructor(session: PromptTarget) {
    this.session = session
    session.on((event) => {
      if (event.type === 'turn-end' || event.type === 'error' || event.type === 'stopped') {
        this.advance().catch((error: unknown) => {
          // The name of the failure is safe to print; the prompt text is not.
          console.error('Could not send the next queued prompt:', describe(error))
        })
      }
    })
  }

  /** The text being typed, as the renderer last parked it. */
  get draft(): string {
    return this.draftText
  }

  saveDraft(text: string): void {
    this.draftText = text
  }

  /** Sent prompts, oldest first, without consecutive repeats. */
  history(): readonly string[] {
    return [...this.sent]
  }

  /**
   * The prompts of a resumed session become the history (#104), oldest
   * first, so `M-p` walks back across a restart. What was sent in this
   * window before the resume belonged to the session that was dropped and
   * goes with it; the same limit and the same repeat rule apply.
   */
  seedHistory(prompts: readonly string[]): void {
    this.sent.splice(0)
    for (const text of prompts) this.remember(text)
  }

  state(): PromptQueueState {
    return { busy: this.busy, queued: this.queued.map(({ id, text }) => ({ id, text })) }
  }

  promptState(): PromptState {
    return { draft: this.draftText, history: this.history(), queue: this.state() }
  }

  /** The images attached to the prompt being composed, in order (#83). */
  attached(): readonly PromptImage[] {
    return [...this.attachedImages]
  }

  /**
   * Attaches an image to the prompt being composed (#83): kept here as PNG,
   * its marker line put in the prompt, where it stands for the image until
   * the send. Refuses an image over the cap and a fifth image.
   */
  attachImage(image: ClipboardImage): PromptImage {
    assertImageFits(image)
    if (this.attachedImages.length >= MAX_IMAGES_PER_PROMPT) {
      throw new CommandError(
        `${MAX_IMAGES_PER_PROMPT} images are already attached; a prompt carries ${MAX_IMAGES_PER_PROMPT} at most`,
      )
    }
    const index = this.attachedImages.length + 1
    const attached: PromptImage = { ...image, index, marker: imageMarker(index, image) }
    this.attachedImages.push(attached)
    this.insert(attached.marker)
    return attached
  }

  /**
   * Sends the prompt now when the agent is idle, otherwise queues it. Rejects
   * when the send itself fails, with the prompt dropped from the queue, so the
   * renderer keeps the text and nothing is lost. The images whose marker is
   * in the text go with it; the rest are dropped with their markers.
   */
  async submit(text: string): Promise<PromptReceipt> {
    this.counter += 1
    const images = this.attachedImages.filter((image) => text.includes(image.marker))
    this.attachedImages = []
    const prompt: PendingPrompt = { id: `p${this.counter}`, text, images }
    this.queued.push(prompt)
    this.remember(text)
    if (this.busy) {
      this.announce()
    } else {
      try {
        await this.advance()
      } catch (error) {
        this.forget(prompt.id)
        // The text stays in the editor, so its images stay attached to it.
        this.attachedImages = [...images]
        this.announce()
        throw error
      }
    }
    const position = this.queued.findIndex((entry) => entry.id === prompt.id) + 1
    return position === 0
      ? { id: prompt.id, status: 'sent', position: 0 }
      : { id: prompt.id, status: 'queued', position }
  }

  /**
   * Sends the prompt into the running turn (#194), past the queue, with the
   * SDK's `next` priority: the turn takes it after the tool call under way.
   * With no turn running it is an ordinary submit. The images whose marker
   * is in the text go with it; a failed send keeps them attached.
   */
  async steer(text: string): Promise<PromptReceipt> {
    if (!this.busy) return this.submit(text)
    this.counter += 1
    const images = this.attachedImages.filter((image) => text.includes(image.marker))
    this.attachedImages = []
    try {
      await this.session.send(text, images.map(imageBlock), 'next')
    } catch (error) {
      this.attachedImages = [...images]
      throw error
    }
    this.remember(text)
    return { id: `p${this.counter}`, status: 'sent', position: 0 }
  }

  /**
   * Takes a queued prompt back out of the queue (#193): its text and its
   * images, which keep the markers they were queued with.
   */
  take(id: string): { readonly text: string; readonly images: readonly PromptImage[] } {
    const { index, prompt } = this.waiting(id)
    this.queued.splice(index, 1)
    this.announce()
    return { text: prompt.text, images: prompt.images }
  }

  /** Drops a queued prompt and its images (#193). */
  remove(id: string): void {
    this.take(id)
  }

  /**
   * Takes a queued prompt back into the editor (#193): its images join the
   * ones attached to the draft, renumbered after them, and its text goes
   * after the draft, so nothing typed is lost. Refused, with the prompt left
   * in the queue, when the images would pass the cap.
   */
  edit(id: string): void {
    const { images } = this.waiting(id).prompt
    if (this.attachedImages.length + images.length > MAX_IMAGES_PER_PROMPT) {
      throw new CommandError(
        `The draft and the queued prompt carry ${this.attachedImages.length + images.length} images; a prompt carries ${MAX_IMAGES_PER_PROMPT} at most`,
      )
    }
    const restored = renumber([this.take(id)], this.attachedImages.length)
    this.attachedImages.push(...restored.images)
    this.insert(restored.texts.join(''))
  }

  /**
   * Makes every waiting prompt one (#193), in order, separated by a blank
   * line, with every image, renumbered so no two markers are the same. The
   * merged prompt takes the place of the first. Returns how many prompts
   * were merged; refused when the images would pass the cap.
   */
  mergeAll(): number {
    const start = this.queued.findIndex((entry) => entry.id !== this.sending)
    if (start === -1) return 0
    const waiting = this.queued.slice(start)
    const [first] = waiting
    if (first === undefined || waiting.length < 2) return waiting.length
    const count = waiting.reduce((sum, entry) => sum + entry.images.length, 0)
    if (count > MAX_IMAGES_PER_PROMPT) {
      throw new CommandError(
        `The queued prompts carry ${count} images; a prompt carries ${MAX_IMAGES_PER_PROMPT} at most`,
      )
    }
    const merged = renumber(waiting, 0)
    this.queued.splice(start, waiting.length, {
      id: first.id,
      text: merged.texts.join('\n\n'),
      images: merged.images,
    })
    this.announce()
    return waiting.length
  }

  /** The IPC bridge subscribes, so the renderer shows what waits. */
  subscribe(listener: PromptQueueListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /**
   * Adds text to the prompt being composed (#81). The editor in the window
   * holds the draft and appends it there, or puts it at the point for a
   * file mention (#83); the draft parked here follows when the editor parks
   * it again, so nothing typed since is overwritten.
   */
  insert(text: string, at?: 'point' | 'all', sent?: string): void {
    const insert: PromptInsert =
      at === undefined ? { text } : sent === undefined ? { text, at } : { text, at, sent }
    for (const listener of [...this.insertListeners]) listener(insert)
  }

  /** The IPC bridge subscribes, so the renderer appends what a command adds. */
  onInsert(listener: PromptInsertListener): () => void {
    this.insertListeners.add(listener)
    return () => {
      this.insertListeners.delete(listener)
    }
  }

  /**
   * Sends the oldest queued prompt, or goes idle when nothing waits. A prompt
   * whose send fails stays at the head of the queue, so it is not lost and the
   * next submit tries it again, in order.
   */
  private async advance(): Promise<void> {
    const next = this.queued[0]
    if (next === undefined) {
      this.setBusy(false)
      return
    }
    this.setBusy(true)
    this.sending = next.id
    try {
      await this.session.send(next.text, next.images.map(imageBlock))
    } catch (error) {
      this.setBusy(false)
      throw error
    } finally {
      this.sending = null
    }
    this.queued.shift()
    this.announce()
  }

  private remember(text: string): void {
    if (this.sent[this.sent.length - 1] === text) return
    this.sent.push(text)
    if (this.sent.length > HISTORY_LIMIT) this.sent.shift()
  }

  /** A waiting prompt and where it is; the one being sent is not waiting any more. */
  private waiting(id: string): { index: number; prompt: PendingPrompt } {
    const index = this.queued.findIndex((entry) => entry.id === id)
    const prompt = this.queued[index]
    if (prompt === undefined || id === this.sending) {
      throw new CommandError('That prompt is no longer in the queue')
    }
    return { index, prompt }
  }

  private forget(id: string): void {
    const index = this.queued.findIndex((entry) => entry.id === id)
    if (index !== -1) this.queued.splice(index, 1)
  }

  private setBusy(busy: boolean): void {
    this.busy = busy
    this.announce()
  }

  private announce(): void {
    const snapshot = this.state()
    for (const listener of this.listeners) listener(snapshot)
  }
}

/**
 * Gives the images of several prompts fresh numbers after `after`, in
 * order, and rewrites each marker in its own prompt's text to match, in
 * one pass so a new marker is never mistaken for an old one.
 */
function renumber(
  prompts: readonly { readonly text: string; readonly images: readonly PromptImage[] }[],
  after: number,
): { texts: string[]; images: PromptImage[] } {
  const images: PromptImage[] = []
  const texts = prompts.map(({ text, images: own }) => {
    if (own.length === 0) return text
    const markers = new Map<string, string>()
    for (const image of own) {
      const index = after + images.length + 1
      const { png, width, height } = image
      const fresh: PromptImage = { png, width, height, index, marker: imageMarker(index, image) }
      images.push(fresh)
      markers.set(image.marker, fresh.marker)
    }
    const pattern = new RegExp([...markers.keys()].map(escapeRegExp).join('|'), 'g')
    return text.replace(pattern, (marker) => markers.get(marker) ?? marker)
  })
  return { texts, images }
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Validates a prompt that came over IPC. Shape only, no trust. */
export function parsePromptText(payload: unknown): string {
  const text = parseDraft(payload)
  if (text.trim().length === 0) throw new TypeError('Prompt is empty')
  return text
}

/** Validates a draft that came over IPC. A draft may be empty; a prompt may not. */
export function parseDraft(payload: unknown): string {
  if (typeof payload !== 'string') throw new TypeError('Prompt is not a string')
  if (payload.length > MAX_PROMPT_LENGTH) throw new TypeError('Prompt is too long')
  return payload
}
