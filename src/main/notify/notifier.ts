import type { SessionAttentionEvent, SessionAttentionKind } from '../../shared/notify'
import type { NotifyToggles } from '../settings'
import { notificationText, type NotificationText } from './text'

/**
 * The notify module (#90): the attention stream in, one message per sink
 * out. A sink is a place a line can go, the macOS notification centre or a
 * phone push; it gets the text from the one builder and the event it came
 * from, so the native sink knows which buffer a click should show.
 *
 * Plain data and no Electron types: the native sink and the wiring live in
 * native.ts and install.ts, and the unit tests drive this with the null sink.
 */

export interface NotificationMessage extends NotificationText {
  readonly event: SessionAttentionEvent
  /** Play the system sound with it, where the sink can. */
  readonly sound: boolean
}

export interface NotificationSink {
  /** For the log line when a send fails; never a credential. */
  readonly name: string
  send(message: NotificationMessage): Promise<void>
}

/** Keeps what it was sent, for the tests. */
export class NullSink implements NotificationSink {
  readonly name = 'null'
  readonly sent: NotificationMessage[] = []

  send(message: NotificationMessage): Promise<void> {
    this.sent.push(message)
    return Promise.resolve()
  }
}

/** When "finished" is worth a notification: always, only when the window is not focused, never. */
export type FinishedPolicy = 'always' | 'unfocused' | 'off'

export interface NotifySettings {
  readonly finished: FinishedPolicy
  readonly needsYou: boolean
  readonly error: boolean
  readonly sound: boolean
}

/** On for "needs you" and "error"; "finished" only when the user is not looking. */
export const DEFAULT_NOTIFY_SETTINGS: NotifySettings = {
  finished: 'unfocused',
  needsYou: true,
  error: true,
  sound: false,
}

export interface NotifierOptions {
  readonly sinks: readonly NotificationSink[]
  readonly settings: NotifySettings
  /** True when a cockpit window has the focus. */
  readonly isFocused: () => boolean
  /** A sink failed; the reason names the sink and a status, nothing sent. */
  readonly onError?: ((reason: string) => void) | undefined
}

export class Notifier {
  private readonly options: NotifierOptions

  constructor(options: NotifierOptions) {
    this.options = options
  }

  /** Whether the settings want this event raised now. */
  wants(kind: SessionAttentionKind): boolean {
    const { settings } = this.options
    switch (kind) {
      case 'session-finished':
        return (
          settings.finished === 'always' ||
          (settings.finished === 'unfocused' && !this.options.isFocused())
        )
      case 'session-needs-you':
        return settings.needsYou
      case 'session-error':
        return settings.error
    }
  }

  /** Sends the event to every sink, each on its own; one failing stops none of the others. */
  async notify(event: SessionAttentionEvent): Promise<void> {
    if (!this.wants(event.type)) return
    const message: NotificationMessage = {
      ...notificationText(event),
      event,
      sound: this.options.settings.sound,
    }
    await Promise.all(
      this.options.sinks.map(async (sink) => {
        try {
          await sink.send(message)
        } catch (error) {
          this.options.onError?.(
            `Notification through ${sink.name} failed: ${error instanceof Error ? error.message : String(error)}`,
          )
        }
      }),
    )
  }
}

/**
 * The settings from the `notify` object of settings.json (#114). With no
 * such object `fallback` decides, the environment's for one release; the
 * file wins whenever it says anything.
 */
export function notifySettings(
  toggles: NotifyToggles | null,
  fallback: NotifySettings,
): NotifySettings {
  if (toggles === null) return fallback
  const finished: FinishedPolicy = !toggles.finished
    ? 'off'
    : toggles.finishedOnlyWhenUnfocused
      ? 'unfocused'
      : 'always'
  return { finished, needsYou: toggles.needsYou, error: toggles.error, sound: toggles.sound }
}

/** The environment variables the settings and the Telegram sink read at startup. */
export const NOTIFY_ENV = {
  finished: 'NEMESIS_NOTIFY_FINISHED',
  needsYou: 'NEMESIS_NOTIFY_NEEDS_YOU',
  error: 'NEMESIS_NOTIFY_ERROR',
  sound: 'NEMESIS_NOTIFY_SOUND',
  telegramToken: 'NEMESIS_TELEGRAM_BOT_TOKEN',
  telegramChat: 'NEMESIS_TELEGRAM_CHAT_ID',
} as const

/**
 * The settings from the environment (#90): `always`, `unfocused` or `off`
 * for finished, `on` or `off` for the rest. A value that is absent or not
 * one of those keeps the default, and the problem is reported, never thrown:
 * a typo in a variable must not stop the cockpit.
 */
export function notifySettingsFromEnv(
  env: Readonly<Record<string, string | undefined>>,
  report: (problem: string) => void = () => {},
): NotifySettings {
  const finishedValue = env[NOTIFY_ENV.finished]?.trim().toLowerCase()
  let finished = DEFAULT_NOTIFY_SETTINGS.finished
  if (finishedValue !== undefined && finishedValue.length > 0) {
    if (finishedValue === 'always' || finishedValue === 'unfocused' || finishedValue === 'off') {
      finished = finishedValue
    } else {
      report(`${NOTIFY_ENV.finished} is not always, unfocused or off; using ${finished}`)
    }
  }
  const flag = (name: string, fallback: boolean): boolean => {
    const value = env[name]?.trim().toLowerCase()
    if (value === undefined || value.length === 0) return fallback
    if (value === 'on') return true
    if (value === 'off') return false
    report(`${name} is not on or off; using ${fallback ? 'on' : 'off'}`)
    return fallback
  }
  return {
    finished,
    needsYou: flag(NOTIFY_ENV.needsYou, DEFAULT_NOTIFY_SETTINGS.needsYou),
    error: flag(NOTIFY_ENV.error, DEFAULT_NOTIFY_SETTINGS.error),
    sound: flag(NOTIFY_ENV.sound, DEFAULT_NOTIFY_SETTINGS.sound),
  }
}

/** The bot token and the chat id, both set, or null: half a pair sends nothing. */
export function telegramFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): { readonly token: string; readonly chatId: string } | null {
  const token = env[NOTIFY_ENV.telegramToken]?.trim() ?? ''
  const chatId = env[NOTIFY_ENV.telegramChat]?.trim() ?? ''
  return token.length > 0 && chatId.length > 0 ? { token, chatId } : null
}
