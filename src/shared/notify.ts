/**
 * The three moments the cockpit tells the user about when they walked away
 * (#90): the turn finished, the session needs an answer, the session hit an
 * error. The session manager derives them from the agent stream; the notify
 * module in the main process turns them into a macOS notification and a
 * phone push.
 *
 * The shape is the whole of what may leave the session: a name, the kind,
 * the elapsed time and the tool-call count. No prompt, no reply, no path, no
 * page content (SECURITY.org), so a sink cannot leak what it was never given.
 */

export type SessionAttentionKind = 'session-finished' | 'session-needs-you' | 'session-error'

export const SESSION_ATTENTION_KINDS: readonly SessionAttentionKind[] = [
  'session-finished',
  'session-needs-you',
  'session-error',
]

export interface SessionAttentionEvent {
  readonly type: SessionAttentionKind
  /** The name the user gave the session (#104), else a short form of its id. */
  readonly session: string
  /** Since the prompt that started the turn. */
  readonly elapsedMs: number
  /** Tool calls in the turn so far, subagents' included. */
  readonly toolCalls: number
}

export type SessionAttentionListener = (event: SessionAttentionEvent) => void
