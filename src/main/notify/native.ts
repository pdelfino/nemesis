import { Notification } from 'electron'
import type { SessionAttentionEvent } from '../../shared/notify'
import type { NotificationMessage, NotificationSink } from './notifier'

/**
 * The macOS notification (#90), through Electron's own Notification. A click
 * brings the cockpit forward on the buffer the event is about. A development
 * run shows it under the Electron binary's identity; the packaged app needs
 * its bundle identifier and signing (M5).
 */
export class NativeSink implements NotificationSink {
  readonly name = 'macOS'
  /** Held until clicked or closed: a notification collected early loses its click. */
  private readonly live = new Set<Notification>()
  private readonly onClick: (event: SessionAttentionEvent) => void

  constructor(onClick: (event: SessionAttentionEvent) => void) {
    this.onClick = onClick
  }

  send(message: NotificationMessage): Promise<void> {
    if (!Notification.isSupported()) return Promise.resolve()
    const notification = new Notification({
      title: message.title,
      body: message.body,
      silent: !message.sound,
    })
    this.live.add(notification)
    notification.on('click', () => {
      this.live.delete(notification)
      this.onClick(message.event)
    })
    notification.on('close', () => this.live.delete(notification))
    notification.show()
    return Promise.resolve()
  }
}
