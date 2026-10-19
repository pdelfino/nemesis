import type { NotificationMessage, NotificationSink } from './notifier'

/**
 * The phone push (#90): one Bot API sendMessage to one chat, through Node's
 * own fetch. Garmin Connect mirrors the iPhone's Telegram notifications, so
 * the watch gets the same line with no Garmin API.
 *
 * The token is part of the URL, so neither the URL nor fetch's own error
 * ever reaches a message: a failure says the status, or that the request
 * did not get through, and nothing else.
 */

export const TELEGRAM_ENDPOINT = 'https://api.telegram.org'

/** A push that has not answered by then is given up; the cockpit never waits on it. */
const TIMEOUT_MS = 10_000

export interface TelegramSinkOptions {
  readonly token: string
  readonly chatId: string
  /** The tests point this at a local HTTP fixture. */
  readonly endpoint?: string | undefined
}

export class TelegramSink implements NotificationSink {
  readonly name = 'Telegram'
  private readonly options: TelegramSinkOptions

  constructor(options: TelegramSinkOptions) {
    this.options = options
  }

  async send(message: NotificationMessage): Promise<void> {
    const endpoint = this.options.endpoint ?? TELEGRAM_ENDPOINT
    let response: Response
    try {
      response = await fetch(`${endpoint}/bot${this.options.token}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chat_id: this.options.chatId,
          text: `${message.title}\n${message.body}`,
          disable_notification: false,
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
    } catch {
      throw new Error('the request did not get through')
    }
    if (!response.ok) throw new Error(`Telegram answered ${response.status}`)
  }
}
