import type { BrowserWindow } from 'electron'
import type { SessionAttentionEvent } from '../../shared/notify'
import type { PermissionBridge } from '../agent/permission-bridge'
import type { SessionManager } from '../agent/session-manager'
import type { BufferRegistry } from '../buffers'
import { NativeSink } from './native'
import {
  Notifier,
  notifySettingsFromEnv,
  telegramFromEnv,
  type NotificationMessage,
  type NotificationSink,
} from './notifier'
import { TelegramSink } from './telegram'

/**
 * The notifications wired to the cockpit (#90): the manager's attention
 * stream in, the macOS notification and, when its two variables are set,
 * the Telegram push out. Everything is read from the environment once, at
 * startup; the token is never logged, shown or written anywhere.
 *
 * Under test the native sink is a spy: the specs read what would have been
 * shown off the main process, the developer's desktop gets nothing, and no
 * push leaves the machine whatever the shell exports.
 */

export interface NotificationsOptions {
  /** The window the session belongs to (#70): its focus, and where a click lands. */
  readonly window: BrowserWindow
  readonly agent: SessionManager
  readonly permissions: PermissionBridge
  readonly buffers: BufferRegistry
  readonly env: Readonly<Record<string, string | undefined>>
}

/** What the native sink would have shown, for the smoke (#66). Main process only, under test only. */
export const NOTIFICATION_LOG = '__nemesisNotifications'

export interface NotificationRecord {
  readonly type: SessionAttentionEvent['type']
  readonly title: string
  readonly body: string
}

class SpySink implements NotificationSink {
  readonly name = 'spy'
  readonly shown: NotificationRecord[]

  constructor(shown: NotificationRecord[] = []) {
    this.shown = shown
  }

  send(message: NotificationMessage): Promise<void> {
    this.shown.push({ type: message.event.type, title: message.title, body: message.body })
    return Promise.resolve()
  }
}

export function installNotifications(options: NotificationsOptions): Notifier {
  const { window, agent, permissions, buffers, env } = options
  const report = (problem: string): void => console.error(problem)
  const sinks: NotificationSink[] = []
  if (env['NODE_ENV'] === 'test') {
    // One log for every window, so a second window's notifications join the first's.
    const log = globalThis as { [NOTIFICATION_LOG]?: NotificationRecord[] }
    const spy = new SpySink(log[NOTIFICATION_LOG])
    log[NOTIFICATION_LOG] = spy.shown
    sinks.push(spy)
  } else {
    sinks.push(new NativeSink((event) => focusOn(event, window, permissions, buffers)))
    const telegram = telegramFromEnv(env)
    if (telegram !== null) sinks.push(new TelegramSink(telegram))
  }
  const notifier = new Notifier({
    sinks,
    settings: notifySettingsFromEnv(env, report),
    isFocused: () => !window.isDestroyed() && window.isFocused(),
    onError: report,
  })
  agent.onAttention((event) => {
    void notifier.notify(event)
  })
  return notifier
}

/**
 * A click on the notification: the window comes forward, on the pending
 * request when the session needs an answer, on the transcript otherwise.
 */
function focusOn(
  event: SessionAttentionEvent,
  window: BrowserWindow,
  permissions: PermissionBridge,
  buffers: BufferRegistry,
): void {
  if (window.isDestroyed()) return
  if (window.isMinimized()) window.restore()
  window.show()
  window.focus()
  const pending = event.type === 'session-needs-you' ? permissions.pending[0] : undefined
  const target =
    pending?.bufferId ?? buffers.list().find((buffer) => buffer.kind === 'transcript')?.id
  if (target !== undefined && buffers.get(target) !== undefined) buffers.switchTo(target)
}
