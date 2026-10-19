import type { SessionAttentionEvent } from '../../shared/notify'

/**
 * The one place a notification's words are made (#90). It reads the four
 * fields of the event and nothing else, so whatever a sink shows or sends is
 * a session name, the moment, the elapsed time and the tool-call count:
 * never the prompt, the reply, a file path or page content (SECURITY.org).
 */

export interface NotificationText {
  /** "Nemesis: <session>", the line a watch shows first. */
  readonly title: string
  /** One line: what happened, after how long, with how many tool calls. */
  readonly body: string
}

const MOMENTS: Readonly<Record<SessionAttentionEvent['type'], string>> = {
  'session-finished': 'Finished',
  'session-needs-you': 'Needs you',
  'session-error': 'Error',
}

export function notificationText(event: SessionAttentionEvent): NotificationText {
  const calls = `${event.toolCalls} tool call${event.toolCalls === 1 ? '' : 's'}`
  return {
    title: `Nemesis: ${event.session}`,
    body: `${MOMENTS[event.type]} after ${formatElapsed(event.elapsedMs)}, ${calls}.`,
  }
}

/** `12s`, `2m 05s`, `1h 02m`: short enough for a watch face. */
export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  const pad = (n: number): string => String(n).padStart(2, '0')
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${pad(seconds % 60)}s`
  return `${Math.floor(minutes / 60)}h ${pad(minutes % 60)}m`
}
