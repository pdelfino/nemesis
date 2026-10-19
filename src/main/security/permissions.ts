import type { Session, WebContents } from 'electron'
import type { AgentNoticeEvent } from '../agent/events'
import { warnLimited } from './warn-limited'

/**
 * Site permissions and device access, denied by default (#49, SECURITY.org
 * T6). Camera, microphone, geolocation, notifications, clipboard read, MIDI,
 * USB, HID, serial and Bluetooth: a page gets none of them unless the user
 * said yes for that origin, in this run of the app.
 *
 * One `PermissionPolicy` holds the three handlers Electron offers a session
 * (`setPermissionRequestHandler`, `setPermissionCheckHandler`,
 * `setDevicePermissionHandler`), the chooser events that would otherwise
 * pick a device on their own, and the in-memory allow set they consult.
 * `apply()` installs the handlers on a session once, so the app can call it
 * from `web-contents-created` for whatever partition a WebContents uses and
 * never miss one; `watch()` does the same for the one chooser that lives on
 * the WebContents (#48 set the pattern).
 *
 * Electron's own default, with no handler installed, is to grant. That is
 * why a session without this policy is a bug, not a stricter state.
 *
 * Nothing here is persisted: the allow set is a Map that dies with the
 * process, and `clear()` empties it early on quit.
 */

/** The permission names Electron hands the request and check handlers. */
export type ElectronPermission = Parameters<
  NonNullable<Parameters<Session['setPermissionRequestHandler']>[0]>
>[1]

/**
 * What a page asks for, in the words the user reads: Electron's `media` is
 * `camera`, `microphone` or both, and the rest keep Electron's name.
 */
export type PermissionName = Exclude<ElectronPermission, 'media'> | 'camera' | 'microphone'

/** What the request and check handlers know about the asking frame. */
export interface RequestDetails {
  readonly isMainFrame?: boolean | undefined
  readonly requestingUrl?: string | undefined
  readonly mediaTypes?: readonly ('video' | 'audio')[] | undefined
  readonly mediaType?: 'video' | 'audio' | 'unknown' | undefined
}

/** The names a permission string stands for. Pure, for the unit tests. */
export function permissionNames(
  permission: ElectronPermission,
  details: RequestDetails = {},
): readonly PermissionName[] {
  if (permission !== 'media') return [permission]
  const types = details.mediaTypes ?? (details.mediaType === undefined ? [] : [details.mediaType])
  const names: PermissionName[] = []
  if (types.includes('video')) names.push('camera')
  if (types.includes('audio')) names.push('microphone')
  // A media request that names no type asks for both: deny or allow it as both.
  return names.length === 0 ? ['camera', 'microphone'] : names
}

/**
 * Scheme and host, port included, of the asking page, or null when the URL
 * does not parse. Spelled out instead of `URL.origin`, which is the string
 * "null" for file: and for the internal scheme. Never the path or query: an
 * origin is what the allow set is keyed on and what the log may carry.
 */
export function originOf(url: string | undefined): string | null {
  if (url === undefined || url === '') return null
  try {
    const parsed = new URL(url)
    return `${parsed.protocol}//${parsed.host}`
  } catch {
    return null
  }
}

/** The permissions Chromium checks, rather than requests, when a page asks for a device. */
const DEVICE_PERMISSIONS: readonly ElectronPermission[] = ['hid', 'serial', 'usb']

/** The minimum of a Session the policy installs on; a fake satisfies it in the unit tests. */
export type PermissionSurface = Pick<
  Session,
  'setPermissionRequestHandler' | 'setPermissionCheckHandler' | 'setDevicePermissionHandler' | 'on'
>

/** The minimum of a WebContents the Bluetooth chooser listener needs. */
export type ChooserSurface = Pick<WebContents, 'on' | 'getURL'>

export type NoticeListener = (event: AgentNoticeEvent) => void

export class PermissionPolicy {
  /** Allowed permission names by origin, for this run of the app only. */
  private readonly allowed = new Map<string, Set<PermissionName>>()
  /** `origin permission` pairs already announced, so a page in a loop makes one line, not a flood. */
  private readonly announced = new Set<string>()
  private readonly listeners = new Set<NoticeListener>()
  private readonly sessions = new WeakSet<PermissionSurface>()
  private readonly contents = new WeakSet<ChooserSurface>()

  /**
   * Whether `origin` may have `permission` now. A request from a subframe is
   * never allowed, whatever the frame's origin: the user said yes to a site,
   * not to what it embeds.
   */
  decide(
    permission: ElectronPermission,
    origin: string | null,
    details: RequestDetails = {},
  ): boolean {
    if (origin === null || details.isMainFrame === false) return false
    const names = this.allowed.get(origin)
    if (names === undefined) return false
    return permissionNames(permission, details).every((name) => names.has(name))
  }

  /** Allows `name` for `origin` until `clear()` or quit. The command that asks the user calls this. */
  allow(origin: string, name: PermissionName): void {
    const names = this.allowed.get(origin) ?? new Set<PermissionName>()
    names.add(name)
    this.allowed.set(origin, names)
    this.announced.delete(`${origin} ${name}`)
  }

  /** What `origin` may do, for a mode line or a test. */
  allowedFor(origin: string): readonly PermissionName[] {
    return [...(this.allowed.get(origin) ?? [])]
  }

  /** Forgets every decision. Called on quit; the Map would die with the process anyway. */
  clear(): void {
    this.allowed.clear()
    this.announced.clear()
  }

  /** The transcript subscribes: every first denial per origin and permission is one line there. */
  on(listener: NoticeListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** Installs the three handlers and the device choosers on a session, once. */
  apply(session: PermissionSurface): void {
    if (this.sessions.has(session)) return
    this.sessions.add(session)

    session.setPermissionRequestHandler((_contents, permission, callback, details) => {
      const origin = originOf(details.requestingUrl)
      const granted = this.decide(permission, origin, details)
      if (!granted) this.deny(permissionNames(permission, details), origin, 'request')
      callback(granted)
    })

    // A check is a query, not an ask: Chromium runs it on every read of
    // `Notification.permission`, every paste, every media enumeration. It is
    // refused silently, and the request that follows a real ask gets the
    // line. The device permissions are the exception: for USB, HID and
    // serial the check is the gate `requestDevice` stops at, so a refusal
    // there is the user's only sign the page asked.
    session.setPermissionCheckHandler((_contents, permission, requestingOrigin, details) => {
      const origin = originOf(details.requestingUrl) ?? originOf(requestingOrigin)
      const granted = this.decide(permission, origin, details)
      if (!granted && DEVICE_PERMISSIONS.includes(permission)) {
        this.deny([permission], origin, 'check')
      }
      return granted
    })

    // Device access has no allow path in version 1: every USB, HID and serial
    // device is refused, and so is the chooser that would list them.
    session.setDevicePermissionHandler((details) => {
      this.deny([details.deviceType], originOf(details.origin), 'device')
      return false
    })
    session.on('select-hid-device', (event, details, callback) => {
      event.preventDefault()
      this.deny(['hid'], originOf(details.frame?.url), 'chooser')
      callback(null)
    })
    session.on('select-usb-device', (event, details, callback) => {
      event.preventDefault()
      this.deny(['usb'], originOf(details.frame?.url), 'chooser')
      callback()
    })
    session.on('select-serial-port', (event, _ports, contents, callback) => {
      event.preventDefault()
      this.deny(['serial'], originOf(contents.getURL()), 'chooser')
      callback('')
    })
  }

  /**
   * The Bluetooth chooser is an event on the WebContents, not the session,
   * and without `preventDefault` Electron picks the first device it finds.
   */
  watch(contents: ChooserSurface): void {
    if (this.contents.has(contents)) return
    this.contents.add(contents)
    contents.on('select-bluetooth-device', (event, _devices, callback) => {
      event.preventDefault()
      this.deny(['bluetooth'], originOf(contents.getURL()), 'chooser')
      callback('')
    })
  }

  /** One stderr line per refusal, origin only, bounded per permission (#100); one transcript line per origin and permission. */
  private deny(names: readonly string[], origin: string | null, how: string): void {
    const site = origin ?? 'an unknown origin'
    for (const name of names) {
      warnLimited(`permissions ${name}`, `permissions: denied ${name} (${how}) for ${site}`)
      const key = `${site} ${name}`
      if (this.announced.has(key)) continue
      this.announced.add(key)
      const event: AgentNoticeEvent = {
        type: 'notice',
        text: `Denied ${name} for ${site}: permissions are off by default (SECURITY.org, T6)`,
      }
      for (const listener of this.listeners) listener(event)
    }
  }
}
