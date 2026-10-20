import type { AgentEvent } from './agent/events'
import { defineCommand, type Command } from './commands/registry'
import type { HelpBuffers } from './help'

/**
 * The messages log (#170): every notice routed to a window, kept in memory
 * so list-messages can show them after the notice itself is gone, as Nyxt's
 * list-messages does for the echo area. A ring of the last 500, per window,
 * lost on quit; nothing is written to disk because a notice may carry a path
 * or a URL.
 */

/** How many messages a window keeps. */
export const MESSAGE_LIMIT = 500

/** Where a notice came from, when its source did not say. */
export const DEFAULT_MESSAGE_SOURCE = 'app'

export interface LoggedMessage {
  readonly time: Date
  readonly source: string
  readonly text: string
}

export class MessageLog {
  private readonly messages: LoggedMessage[] = []

  /** Appends a message, dropping the oldest past the limit. */
  record(text: string, source: string = DEFAULT_MESSAGE_SOURCE, time: Date = new Date()): void {
    this.messages.push({ time, source, text })
    if (this.messages.length > MESSAGE_LIMIT)
      this.messages.splice(0, this.messages.length - MESSAGE_LIMIT)
  }

  /** The messages, oldest first. */
  list(): readonly LoggedMessage[] {
    return [...this.messages]
  }

  /** Passes a window's events through, recording the notices. */
  watch(events: { on(listener: (event: AgentEvent) => void): () => void }): {
    on(listener: (event: AgentEvent) => void): () => void
  } {
    return {
      on: (listener) =>
        events.on((event) => {
          if (event.type === 'notice') this.record(event.text, event.source)
          listener(event)
        }),
    }
  }
}

const pad = (value: number): string => String(value).padStart(2, '0')

/** The text of list-messages: one line per message, newest last. */
export function renderMessages(messages: readonly LoggedMessage[]): string {
  if (messages.length === 0) return 'No messages yet in this window.'
  return messages
    .map((message) => {
      const { time } = message
      const clock = `${pad(time.getHours())}:${pad(time.getMinutes())}:${pad(time.getSeconds())}`
      return `${clock} [${message.source}] ${message.text}`
    })
    .join('\n')
}

export const MESSAGES_COMMAND_DOC =
  'Show every notice of this window, newest last, with its time and source.'

/** list-messages: the log in the help buffer. */
export function messagesCommands(log: MessageLog, help: HelpBuffers): readonly Command[] {
  return [
    defineCommand({
      name: 'list-messages',
      mcp: 'free',
      doc: MESSAGES_COMMAND_DOC,
      run: () => {
        help.show(renderMessages(log.list()))
      },
    }),
  ]
}
