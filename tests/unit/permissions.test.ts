import { describe, expect, it } from 'vitest'
import type { AgentNoticeEvent } from '../../src/main/agent/events'
import {
  originOf,
  PermissionPolicy,
  permissionNames,
  type ElectronPermission,
  type PermissionSurface,
} from '../../src/main/security/permissions'

/**
 * The decision behind the three session handlers and the device choosers
 * (#49, SECURITY.org T6), on plain values. The live handlers are exercised by
 * tests/e2e/security/permissions-denied.spec.ts; this is the table they
 * implement, plus the allow set a later command fills for one run.
 */

type RequestHandler = NonNullable<Parameters<PermissionSurface['setPermissionRequestHandler']>[0]>
type CheckHandler = NonNullable<Parameters<PermissionSurface['setPermissionCheckHandler']>[0]>
type DeviceHandler = NonNullable<Parameters<PermissionSurface['setDevicePermissionHandler']>[0]>

/** A session that records what was installed on it, and nothing more. */
interface FakeSession extends PermissionSurface {
  request: RequestHandler | null
  check: CheckHandler | null
  device: DeviceHandler | null
  readonly events: string[]
  installs: number
}

function fakeSession(): FakeSession {
  const session: FakeSession = {
    request: null,
    check: null,
    device: null,
    events: [],
    installs: 0,
    setPermissionRequestHandler(handler) {
      session.installs += 1
      session.request = handler
    },
    setPermissionCheckHandler(handler) {
      session.check = handler
    },
    setDevicePermissionHandler(handler) {
      session.device = handler
    },
    on(event: string) {
      session.events.push(event)
      return session as never
    },
  } as FakeSession
  return session
}

const contents = null as never

function ask(
  session: FakeSession,
  permission: ElectronPermission,
  requestingUrl: string,
  extra: Record<string, unknown> = {},
): boolean {
  if (session.request === null) throw new Error('no request handler installed')
  let answer: boolean | null = null
  session.request(
    contents,
    permission,
    (granted) => {
      answer = granted
    },
    { isMainFrame: true, requestingUrl, ...extra },
  )
  if (answer === null) throw new Error('the request handler did not answer')
  return answer
}

describe('permissionNames (SECURITY.org T6)', () => {
  it('splits a media request into camera and microphone, in the words the user reads', () => {
    expect(permissionNames('media', { mediaTypes: ['video'] })).toEqual(['camera'])
    expect(permissionNames('media', { mediaTypes: ['audio'] })).toEqual(['microphone'])
    expect(permissionNames('media', { mediaTypes: ['video', 'audio'] })).toEqual([
      'camera',
      'microphone',
    ])
    expect(permissionNames('media', { mediaType: 'audio' })).toEqual(['microphone'])
    expect(permissionNames('media')).toEqual(['camera', 'microphone'])
  })

  it('keeps every other permission under its own name', () => {
    expect(permissionNames('geolocation')).toEqual(['geolocation'])
    expect(permissionNames('clipboard-read')).toEqual(['clipboard-read'])
    expect(permissionNames('midiSysex')).toEqual(['midiSysex'])
  })
})

describe('originOf', () => {
  it('keeps scheme, host and port and drops path and query', () => {
    expect(originOf('https://example.test:8443/secret/path?token=1')).toBe(
      'https://example.test:8443',
    )
    expect(originOf('http://127.0.0.1:4000/permissions.html')).toBe('http://127.0.0.1:4000')
  })

  it('is null for nothing and for what is not a URL', () => {
    expect(originOf(undefined)).toBeNull()
    expect(originOf('')).toBeNull()
    expect(originOf('not a url')).toBeNull()
  })
})

describe('PermissionPolicy', () => {
  const page = 'https://example.test/app'
  const origin = 'https://example.test'

  it('denies every permission for every origin until told otherwise', () => {
    const policy = new PermissionPolicy()
    for (const permission of [
      'geolocation',
      'notifications',
      'clipboard-read',
      'midi',
      'midiSysex',
      'usb',
      'hid',
      'serial',
      'media',
      'fullscreen',
      'unknown',
    ] as const) {
      expect(policy.decide(permission, origin, { isMainFrame: true })).toBe(false)
    }
    expect(policy.allowedFor(origin)).toEqual([])
  })

  it('allows an origin exactly what it was allowed, for the top frame only', () => {
    const policy = new PermissionPolicy()
    policy.allow(origin, 'geolocation')
    expect(policy.decide('geolocation', origin, { isMainFrame: true })).toBe(true)
    expect(policy.decide('geolocation', origin, {})).toBe(true)
    expect(policy.decide('geolocation', origin, { isMainFrame: false })).toBe(false)
    expect(policy.decide('notifications', origin, { isMainFrame: true })).toBe(false)
    expect(policy.decide('geolocation', 'https://other.test', { isMainFrame: true })).toBe(false)
    expect(policy.decide('geolocation', null, { isMainFrame: true })).toBe(false)
    expect(policy.allowedFor(origin)).toEqual(['geolocation'])
  })

  it('needs every side of a media request allowed', () => {
    const policy = new PermissionPolicy()
    policy.allow(origin, 'microphone')
    expect(policy.decide('media', origin, { isMainFrame: true, mediaTypes: ['audio'] })).toBe(true)
    expect(policy.decide('media', origin, { isMainFrame: true, mediaTypes: ['video'] })).toBe(false)
    expect(
      policy.decide('media', origin, { isMainFrame: true, mediaTypes: ['video', 'audio'] }),
    ).toBe(false)
    policy.allow(origin, 'camera')
    expect(
      policy.decide('media', origin, { isMainFrame: true, mediaTypes: ['video', 'audio'] }),
    ).toBe(true)
  })

  it('forgets everything on clear', () => {
    const policy = new PermissionPolicy()
    policy.allow(origin, 'geolocation')
    policy.allow('https://other.test', 'camera')
    policy.clear()
    expect(policy.decide('geolocation', origin, { isMainFrame: true })).toBe(false)
    expect(policy.allowedFor(origin)).toEqual([])
    expect(policy.allowedFor('https://other.test')).toEqual([])
  })

  it('installs the three handlers and the device choosers on a session, once', () => {
    const policy = new PermissionPolicy()
    const session = fakeSession()
    policy.apply(session)
    policy.apply(session)
    expect(session.installs).toBe(1)
    expect(session.request).not.toBeNull()
    expect(session.check).not.toBeNull()
    expect(session.device).not.toBeNull()
    expect(session.events).toEqual(['select-hid-device', 'select-usb-device', 'select-serial-port'])
  })

  it('answers a request through the allow set and a check the same way', () => {
    const policy = new PermissionPolicy()
    const session = fakeSession()
    policy.apply(session)
    expect(ask(session, 'geolocation', page)).toBe(false)
    expect(ask(session, 'media', page, { mediaTypes: ['video'] })).toBe(false)
    expect(session.check?.(contents, 'geolocation', origin, { isMainFrame: true })).toBe(false)

    policy.allow(origin, 'geolocation')
    expect(ask(session, 'geolocation', page)).toBe(true)
    expect(ask(session, 'geolocation', page, { isMainFrame: false })).toBe(false)
    expect(
      session.check?.(contents, 'geolocation', origin, { isMainFrame: true, requestingUrl: page }),
    ).toBe(true)
    // A check with no document behind it (a worker) carries the origin alone.
    expect(session.check?.(contents, 'geolocation', origin, { isMainFrame: true })).toBe(true)
    expect(ask(session, 'notifications', page)).toBe(false)
  })

  it('refuses every device, whatever was allowed', () => {
    const policy = new PermissionPolicy()
    const session = fakeSession()
    policy.apply(session)
    policy.allow(origin, 'usb')
    expect(session.device?.({ deviceType: 'usb', origin: page, device: {} as never })).toBe(false)
  })

  it('announces the first denial per origin and permission, as one line, and no more', () => {
    const policy = new PermissionPolicy()
    const session = fakeSession()
    const notices: AgentNoticeEvent[] = []
    policy.on((event) => notices.push(event))
    policy.apply(session)

    ask(session, 'geolocation', `${page}?token=secret`)
    ask(session, 'geolocation', `${page}?token=secret`)
    ask(session, 'media', page, { mediaTypes: ['video', 'audio'] })
    ask(session, 'geolocation', 'https://other.test/')

    expect(notices.map((notice) => notice.type)).toEqual(['notice', 'notice', 'notice', 'notice'])
    expect(notices.map((notice) => notice.text)).toEqual([
      'Denied geolocation for https://example.test: permissions are off by default (SECURITY.org, T6)',
      'Denied camera for https://example.test: permissions are off by default (SECURITY.org, T6)',
      'Denied microphone for https://example.test: permissions are off by default (SECURITY.org, T6)',
      'Denied geolocation for https://other.test: permissions are off by default (SECURITY.org, T6)',
    ])
    for (const notice of notices) {
      expect(notice.text).not.toContain('\n')
      expect(notice.text).not.toContain('secret')
      expect(notice.text).not.toContain('/app')
    }
    // Allowing and then denying again is a new fact worth a new line.
    policy.allow(origin, 'geolocation')
    policy.clear()
    ask(session, 'geolocation', page)
    expect(notices).toHaveLength(5)
  })

  it('tells a transcript nothing on a silent check, and lets a listener leave', () => {
    const policy = new PermissionPolicy()
    const session = fakeSession()
    const notices: AgentNoticeEvent[] = []
    const stop = policy.on((event) => notices.push(event))
    policy.apply(session)
    session.check?.(contents, 'notifications', origin, { isMainFrame: true })
    session.check?.(contents, 'clipboard-read', origin, { isMainFrame: true })
    session.check?.(contents, 'media', origin, { isMainFrame: true, mediaType: 'audio' })
    expect(notices).toEqual([])
    stop()
    ask(session, 'notifications', page)
    expect(notices).toEqual([])
  })

  it('announces a refused device check, the gate requestDevice stops at', () => {
    const policy = new PermissionPolicy()
    const session = fakeSession()
    const notices: AgentNoticeEvent[] = []
    policy.on((event) => notices.push(event))
    policy.apply(session)
    for (const permission of ['usb', 'hid', 'serial'] as const) {
      expect(session.check?.(contents, permission, origin, { isMainFrame: true })).toBe(false)
      expect(session.check?.(contents, permission, origin, { isMainFrame: true })).toBe(false)
    }
    expect(notices.map((notice) => notice.text)).toEqual([
      'Denied usb for https://example.test: permissions are off by default (SECURITY.org, T6)',
      'Denied hid for https://example.test: permissions are off by default (SECURITY.org, T6)',
      'Denied serial for https://example.test: permissions are off by default (SECURITY.org, T6)',
    ])
  })
})
