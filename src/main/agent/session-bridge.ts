import { app, BrowserWindow } from 'electron'
import {
  AGENT_EVENT_CHANNEL,
  type AgentEvent,
  PROMPT_DRAFT_CHANNEL,
  PROMPT_QUEUE_CHANNEL,
  PROMPT_SEND_CHANNEL,
  PROMPT_STATE_CHANNEL,
} from '../../shared/agent'
import { handle, parseNothing } from '../ipc'
import type { SessionRecorder } from '../transcripts'
import type { PermissionBridge } from './permission-bridge'
import { parseDraft, parsePromptText, PromptQueue } from './prompt-queue'
import { createAgentSession } from './session'

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
 */

/** Anything that emits agent events the window and the recorder should see. */
export interface EventSource {
  on(listener: (event: AgentEvent) => void): () => void
}
export interface SessionBridgeOptions {
  /** The working directory the agent runs in: the folder the app was started in. */
  readonly cwd: string
  readonly permissions: PermissionBridge
  /** Writes the session folder. */
  readonly recorder: SessionRecorder
  /** The model from the settings; `null` leaves the choice to the CLI. */
  readonly model: string | null
  /** The cockpit's own notices, shown and recorded like any event. */
  readonly notices?: EventSource | undefined
}

export function installSessionBridge(options: SessionBridgeOptions): PromptQueue {
  const { permissions, recorder } = options
  const session = createAgentSession({
    cwd: options.cwd,
    permissionHandler: permissions,
    ...(options.model === null ? {} : { model: options.model }),
  })
  const queue = new PromptQueue(session)

  session.on((event) => {
    recorder.record(event)
    broadcast(AGENT_EVENT_CHANNEL, event)
  })
  permissions.on((event) => {
    recorder.record(event)
    broadcast(AGENT_EVENT_CHANNEL, event)
  })
  options.notices?.on((event) => {
    recorder.record(event)
    broadcast(AGENT_EVENT_CHANNEL, event)
  })
  queue.subscribe((state) => broadcast(PROMPT_QUEUE_CHANNEL, state))

  handle(PROMPT_SEND_CHANNEL, parsePromptText, (text) => {
    const question = permissions.pending[0]
    if (question !== undefined && permissions.reply(text)) {
      return { id: question.id, status: 'answered', position: 0 }
    }
    return queue.submit(text)
  })
  handle(PROMPT_DRAFT_CHANNEL, parseDraft, (draft) => queue.saveDraft(draft))
  handle(PROMPT_STATE_CHANNEL, parseNothing, () => queue.promptState())

  // The CLI under the SDK is a child process; it must not outlive the app.
  // Stopping emits the final event, which the recorder writes and closes on.
  app.once('before-quit', () => {
    void session.stop()
  })

  return queue
}

function broadcast(channel: string, payload: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(channel, payload)
  }
}
