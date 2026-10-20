import type { SessionAttentionEvent } from '../../shared/notify'
import type { AgentEvent } from './events'

/**
 * Reads the agent stream and says when the user is wanted (#90): a turn that
 * ended well is `session-finished`, one that ended in an error, or a stream
 * that failed, is `session-error`, and a permission request or an
 * AskUserQuestion is `session-needs-you`. A turn the user stopped with the
 * interrupt key ends in an error result, as the CLI ends it; that one is not
 * news to the user and raises nothing.
 *
 * It keeps only counts and times, never the text of an event, so what it
 * hands on carries nothing from the transcript.
 */

/** How many characters of a session name a notification carries. */
const NAME_LIMIT = 60

export class AttentionTracker {
  private readonly now: () => number
  private name: string | null = null
  private sessionId: string | null = null
  private turnStartedAt: number | null = null
  private toolCalls = 0
  private interrupting = false

  constructor(now: () => number = Date.now) {
    this.now = now
  }

  /** The user pressed the interrupt key: the turn's error ending is expected. */
  interrupted(): void {
    if (this.turnStartedAt !== null) this.interrupting = true
  }

  observe(event: AgentEvent): SessionAttentionEvent | null {
    switch (event.type) {
      case 'named':
        this.name = event.name
        return null
      case 'started':
        this.sessionId = event.sessionId
        return null
      case 'user-text':
        if (this.turnStartedAt === null) {
          this.turnStartedAt = this.now()
          this.toolCalls = 0
        }
        return null
      case 'tool-use':
        this.toolCalls += 1
        return null
      case 'permission-request':
        return this.raise('session-needs-you')
      case 'turn-end': {
        const quiet = this.interrupting
        const raised = this.raise(
          event.isError ? 'session-error' : 'session-finished',
          event.durationMs,
        )
        this.endTurn()
        return quiet ? null : raised
      }
      case 'error': {
        const raised = this.raise('session-error')
        this.endTurn()
        return raised
      }
      case 'stopped':
        this.endTurn()
        this.sessionId = null
        return null
      default:
        return null
    }
  }

  private raise(type: SessionAttentionEvent['type'], durationMs?: number): SessionAttentionEvent {
    const elapsed =
      this.turnStartedAt === null ? (durationMs ?? 0) : this.now() - this.turnStartedAt
    return {
      type,
      session: this.sessionName(),
      elapsedMs: Math.max(0, elapsed),
      toolCalls: this.toolCalls,
    }
  }

  private endTurn(): void {
    this.turnStartedAt = null
    this.toolCalls = 0
    this.interrupting = false
  }

  private sessionName(): string {
    return sessionLabel(this.name, this.sessionId)
  }
}

/**
 * How a session is named to the user outside its own window: the name it
 * was given (#104), else a short form of its id, else `Nemesis`. The
 * notifications (#90) and the `agents` buffer (#157) say it alike.
 */
export function sessionLabel(name: string | null, sessionId: string | null): string {
  const trimmed = (name ?? '').replace(/\s+/g, ' ').trim()
  if (trimmed.length > 0) {
    return trimmed.length > NAME_LIMIT ? `${trimmed.slice(0, NAME_LIMIT - 3)}...` : trimmed
  }
  return sessionId === null ? 'Nemesis' : `session ${sessionId.slice(0, 8)}`
}
