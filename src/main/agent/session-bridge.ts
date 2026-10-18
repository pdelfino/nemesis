import { app, BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron'
import {
  AGENT_EVENT_CHANNEL,
  PROMPT_DRAFT_CHANNEL,
  PROMPT_QUEUE_CHANNEL,
  PROMPT_SEND_CHANNEL,
  PROMPT_STATE_CHANNEL,
} from '../../shared/agent'
import { isInternalSender } from '../commands/dispatcher'
import { parseDraft, parsePromptText, PromptQueue } from './prompt-queue'
import { createAgentSession } from './session'

/**
 * The cockpit's agent session meets the window here (#61). One session, one
 * queue; the renderer sends prompts and parks its draft through sender- and
 * shape-validated invoke handlers (SECURITY.org, T1), and every agent event
 * is pushed to the window unchanged, for the transcript (#62) and the
 * permission prompt (#63) to read.
 *
 * No permission handler is installed yet, so every tool call is denied
 * (SECURITY.org, T4); the policy is #55 and the prompt that asks is #63.
 */
export interface SessionBridgeOptions {
  /** The working directory the agent runs in: the folder the app was started in. */
  readonly cwd: string
}

export function installSessionBridge(options: SessionBridgeOptions): PromptQueue {
  const session = createAgentSession({ cwd: options.cwd })
  const queue = new PromptQueue(session)

  session.on((event) => broadcast(AGENT_EVENT_CHANNEL, event))
  queue.subscribe((state) => broadcast(PROMPT_QUEUE_CHANNEL, state))

  ipcMain.handle(PROMPT_SEND_CHANNEL, (event: IpcMainInvokeEvent, payload: unknown) => {
    assertInternal(event, PROMPT_SEND_CHANNEL)
    return queue.submit(parsePromptText(payload))
  })
  ipcMain.handle(PROMPT_DRAFT_CHANNEL, (event: IpcMainInvokeEvent, payload: unknown) => {
    assertInternal(event, PROMPT_DRAFT_CHANNEL)
    queue.saveDraft(parseDraft(payload))
  })
  ipcMain.handle(PROMPT_STATE_CHANNEL, (event: IpcMainInvokeEvent) => {
    assertInternal(event, PROMPT_STATE_CHANNEL)
    return queue.promptState()
  })

  // The CLI under the SDK is a child process; it must not outlive the app.
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

function assertInternal(event: IpcMainInvokeEvent, channel: string): void {
  if (!isInternalSender(event.senderFrame, process.env['ELECTRON_RENDERER_URL'])) {
    throw new Error(`Rejected ${channel} from a frame that is not an internal page`)
  }
}
