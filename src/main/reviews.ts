import type { BufferInfo } from '../shared/buffers'
import type { SessionDiff } from '../shared/diff'
import type { ReviewContent } from '../shared/review'
import type { AgentEvent, AgentEventListener } from './agent/events'
import type { BufferRegistry } from './buffers'
import { CommandError } from './commands/registry'
import { EXIT_PLAN_MODE, planText } from './plans'
import { reviewerPrompt, unifiedPatch, type ReviewIssue } from './review-prompt'

/**
 * The review buffers (#87): the guide's adversarial review step as buffers.
 * `review-diff` takes the writer's diff off the diff buffers of #68, the
 * attached issue and the last plan this session proposed, and builds the
 * reviewer's prompt here; a second window, a fresh session, runs it, and
 * its final text comes back to `show`, which opens it as a `review` buffer
 * in the writer's window, read-only, with the point. `review-apply` reads
 * the review of the current buffer, else the last one opened, and sends the
 * findings to the writer's session. A review buffer is killed like any
 * other; several may be open, each with its own text.
 *
 * Plain data, no Electron types, like the spec buffers: the unit tests drive
 * it with a bare registry, and the palette bridge pushes the content.
 */

/** The renderer element the review buffers show in (src/renderer/index.html). */
export const REVIEW_ELEMENT_ID = 'review'

export type ReviewShownListener = (content: ReviewContent) => void

/** A review open in a buffer. */
export interface ShownReview {
  readonly bufferId: string
  readonly reviewer: string
  readonly text: string
}

export class ReviewBuffers {
  private readonly buffers: BufferRegistry
  private readonly shownListeners = new Set<ReviewShownListener>()
  private readonly listeners = new Set<AgentEventListener>()
  private readonly shownReviews = new Map<string, ShownReview>()
  private lastShown: string | null = null
  /** The plan the session last asked to leave plan mode with, the reviewer's yardstick when no issue is attached. */
  private lastPlan: string | null = null
  private sessionId: string | null = null

  constructor(buffers: BufferRegistry) {
    this.buffers = buffers
    buffers.subscribe((list) => {
      for (const id of [...this.shownReviews.keys()]) {
        if (!list.buffers.some((buffer) => buffer.id === id)) this.shownReviews.delete(id)
      }
      if (this.lastShown !== null && !this.shownReviews.has(this.lastShown)) this.lastShown = null
    })
  }

  /** The bridge subscribes and pushes the content of a review buffer to the window. */
  onShown(listener: ReviewShownListener): () => void {
    this.shownListeners.add(listener)
    return () => {
      this.shownListeners.delete(listener)
    }
  }

  /** The session bridge subscribes: a notice is shown and recorded like any event. */
  on(listener: AgentEventListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** The plan the reviewer is given, or null. */
  get plan(): string | null {
    return this.lastPlan
  }

  /**
   * Reads the writer's events, live and resumed alike: the last plan the
   * session proposed is kept for the reviewer, and a session under a new id
   * forgets it.
   */
  observe(event: AgentEvent): void {
    if (event.type === 'started') {
      if (this.sessionId !== event.sessionId) {
        this.sessionId = event.sessionId
        this.lastPlan = null
      }
    } else if (event.type === 'tool-use' && event.name === EXIT_PLAN_MODE) {
      const plan = planText(event.input)
      if (plan.trim().length > 0) this.lastPlan = plan
    }
  }

  /**
   * The reviewer's first message for the writer's diffs. No diff yet is a
   * CommandError: there is nothing to review.
   */
  prompt(diffs: readonly SessionDiff[], issue: ReviewIssue | null): string {
    if (diffs.length === 0) {
      throw new CommandError('Nothing to review: the session has made no Edit or Write call')
    }
    return reviewerPrompt({ patch: unifiedPatch(diffs), issue, plan: this.lastPlan })
  }

  /** The reviews open in a buffer, oldest first. */
  list(): readonly ShownReview[] {
    return [...this.shownReviews.values()]
  }

  /** The review of the current buffer, else the last one opened, else null. */
  get current(): ShownReview | null {
    const current = this.buffers.current
    if (current !== null) {
      const own = this.shownReviews.get(current.id)
      if (own !== undefined) return own
    }
    return this.lastShown === null ? null : (this.shownReviews.get(this.lastShown) ?? null)
  }

  /** The review of `buffer`, for a test or a mode line. */
  shown(buffer: BufferInfo): ShownReview | null {
    return this.shownReviews.get(buffer.id) ?? null
  }

  /** The reviewer's final text opens as a review buffer with the point. */
  show(reviewer: string, text: string): ShownReview {
    const buffer = this.buffers.create({
      kind: 'review',
      title: `Review by ${reviewer}`,
      elementId: REVIEW_ELEMENT_ID,
    })
    const review: ShownReview = { bufferId: buffer.id, reviewer, text }
    this.shownReviews.set(buffer.id, review)
    this.lastShown = buffer.id
    this.notify(
      `Review by ${reviewer} is in: C-c C-c in the review buffer sends the findings to this session.`,
    )
    // The window gets the text before the point moves to it.
    for (const listener of [...this.shownListeners]) listener({ ...review })
    this.buffers.switchTo(buffer.id)
    return review
  }

  /** A notice in the writer's stream: the review started, or failed. */
  notify(text: string): void {
    const event: AgentEvent = { type: 'notice', text }
    for (const listener of [...this.listeners]) listener(event)
  }
}
