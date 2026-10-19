import { app, type WebContents } from 'electron'
import {
  AGENT_EVENT_CHANNEL,
  type AgentEvent,
  PROMPT_DRAFT_CHANNEL,
  PROMPT_INSERT_CHANNEL,
  PROMPT_QUEUE_CHANNEL,
  PROMPT_SEND_CHANNEL,
  PROMPT_STATE_CHANNEL,
} from '../../shared/agent'
import { handleIn, parseNothing } from '../ipc'
import type { SessionRecorder } from '../transcripts'
import type { PermissionBridge } from './permission-bridge'
import { parseDraft, parsePromptText, PromptQueue } from './prompt-queue'
import type { SessionManager } from './session-manager'

/**
 * The cockpit's agent session meets the window here (#61). One session, one
 * queue; the renderer sends prompts and parks its draft through `handle()`,
 * so the sender and the shape are validated first (SECURITY.org, T1; #53),
 * and every agent event is pushed to the window unchanged, for the
 * transcript (#62) and the permission prompt (#63) to read.
 *
 * The permission bridge (#63) is the session's handler: a tool the policy
 * asks about waits on a key, and what the bridge announces goes to the
 * window on the same channel as the session's own events. Text sent while
 * a question is pending answers the question instead of starting a turn.
 *
 * The same streams, in the same order, go to the recorder (#64), so the
 * session folder on disk holds what the window showed. A third, optional
 * stream carries the cockpit's own notices, a refused site permission (#49),
 * to both places the same way.
 *
 * The session itself is the manager's (#84): it replaces the session on
 * new-task and on a conversation rewind, and the queue, the recorder and the
 * window follow through the one subscription taken here. A resumed session's
 * recorded history (#67) goes to the window alone: the recorder already has
 * it, in the file it was read from. Its prompts seed the queue's history
 * (#104), so `M-p` in the window walks back into the resumed session; the
 * prompt buffer reads the state again when the resumed session starts.
 *
 * One bridge per window (#70): each window has its own session and queue,
 * its calls reach them through the sender, and its events go to it alone.
 */

/** Anything that emits agent events the window and the recorder should see. */
export interface EventSource {
  on(listener: (event: AgentEvent) => void): () => void
}
export interface SessionBridgeOptions {
  /** The window the session belongs to. */
  readonly contents: WebContents
  /** Holds the current session and replaces it on new-task or rewind (#84). */
  readonly agent: SessionManager
  readonly permissions: PermissionBridge
  /** Writes the session folder. */
  readonly recorder: SessionRecorder
  /** The cockpit's own notices, shown and recorded like any event. */
  readonly notices?: EventSource | undefined
  /** Runs a cleanup once, when the window goes: the cockpit's one hook (#136). */
  readonly onDestroyed: (dispose: () => void) => void
}

export function installSessionBridge(options: SessionBridgeOptions): PromptQueue {
  const { contents, agent, permissions, recorder, onDestroyed } = options
  const queue = new PromptQueue(agent)
  const broadcast = (channel: string, payload: unknown): void => {
    if (!contents.isDestroyed()) contents.send(channel, payload)
  }

  agent.on((event) => {
    recorder.record(event)
    broadcast(AGENT_EVENT_CHANNEL, event)
  })
  agent.onHistory((history) => {
    queue.seedHistory(history.flatMap((event) => (event.type === 'user-text' ? [event.text] : [])))
    for (const event of history) broadcast(AGENT_EVENT_CHANNEL, event)
  })
  permissions.on((event) => {
    recorder.record(event)
    broadcast(AGENT_EVENT_CHANNEL, event)
  })
  // The notices may outlive the window; the subscription does not.
  const offNotices = options.notices?.on((event) => {
    recorder.record(event)
    broadcast(AGENT_EVENT_CHANNEL, event)
  })
  if (offNotices !== undefined) onDestroyed(offNotices)
  queue.subscribe((state) => broadcast(PROMPT_QUEUE_CHANNEL, state))
  queue.onInsert((insert) => broadcast(PROMPT_INSERT_CHANNEL, insert))

  handleIn(contents, PROMPT_SEND_CHANNEL, parsePromptText, (text) => {
    const question = permissions.pending[0]
    if (question !== undefined && permissions.reply(text)) {
      return { id: question.id, status: 'answered', position: 0 }
    }
    return queue.submit(text)
  })
  handleIn(contents, PROMPT_DRAFT_CHANNEL, parseDraft, (draft) => queue.saveDraft(draft))
  handleIn(contents, PROMPT_STATE_CHANNEL, parseNothing, () => queue.promptState())

  // The CLI under the SDK is a child process; it must not outlive the app.
  // Stopping emits the final event, which the recorder writes and closes on.
  // Nor the window it belongs to.
  app.once('before-quit', () => {
    void agent.stop()
  })
  onDestroyed(() => {
    void agent.stop()
  })

  return queue
}
