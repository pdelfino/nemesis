import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The privacy baseline (#54, SECURITY.org T7) on fakes: the host resolver
 * is configured before any session exists, both partitions get the
 * permission handlers of #49, the WebRTC policy names the public interface
 * only, and the request log keeps scheme and host, never a path. The live
 * run is tests/e2e/security/startup-no-network.spec.ts.
 */

type Listener = (details: { url: string }, callback: (response: object) => void) => void

interface FakeSession {
  readonly name: string
  readonly handlers: string[]
  listener: Listener | null
  readonly webRequest: { onBeforeRequest: (listener: Listener) => void }
  setPermissionRequestHandler(handler: unknown): void
  setPermissionCheckHandler(handler: unknown): void
  setDevicePermissionHandler(handler: unknown): void
  on(event: string): FakeSession
}

const calls: string[] = []

function fakeSession(name: string): FakeSession {
  const one: FakeSession = {
    name,
    handlers: [],
    listener: null,
    webRequest: {
      onBeforeRequest(listener) {
        one.listener = listener
      },
    },
    setPermissionRequestHandler() {
      calls.push(`handlers ${name}`)
      one.handlers.push('request')
    },
    setPermissionCheckHandler() {
      one.handlers.push('check')
    },
    setDevicePermissionHandler() {
      one.handlers.push('device')
    },
    on() {
      return one
    },
  }
  return one
}

const sessions = new Map<string, FakeSession>()
const defaultSession = fakeSession('default')

vi.mock('electron', () => ({
  app: {
    configureHostResolver(options: unknown) {
      calls.push(`resolver ${JSON.stringify(options)}`)
    },
  },
  session: {
    defaultSession,
    fromPartition(name: string) {
      calls.push(`partition ${name}`)
      const existing = sessions.get(name)
      if (existing !== undefined) return existing
      const created = fakeSession(name)
      sessions.set(name, created)
      return created
    },
  },
}))

const { PermissionPolicy } = await import('../../src/main/security/permissions')
const {
  applyWebRTCPolicy,
  createPartitions,
  EPHEMERAL_PARTITION,
  PERSISTENT_PARTITION,
  recordRequests,
  WEBRTC_POLICY,
} = await import('../../src/main/security/partitions')

beforeEach(() => {
  calls.length = 0
  sessions.clear()
  defaultSession.handlers.length = 0
  defaultSession.listener = null
})

describe('createPartitions (SECURITY.org T7)', () => {
  it('turns DNS over HTTPS off before any session exists', () => {
    createPartitions(new PermissionPolicy())
    expect(calls[0]).toBe('resolver {"secureDnsMode":"off"}')
    expect(calls.indexOf(`partition ${PERSISTENT_PARTITION}`)).toBeGreaterThan(0)
  })

  it('creates a persistent default partition and an in-memory ephemeral one', () => {
    const partitions = createPartitions(new PermissionPolicy())
    expect(PERSISTENT_PARTITION).toBe('persist:default')
    expect(EPHEMERAL_PARTITION).toBe('ephemeral')
    expect(EPHEMERAL_PARTITION.startsWith('persist:')).toBe(false)
    expect((partitions.persistent as unknown as FakeSession).name).toBe(PERSISTENT_PARTITION)
    expect((partitions.ephemeral as unknown as FakeSession).name).toBe(EPHEMERAL_PARTITION)
  })

  it('installs the deny-by-default permission handlers on both partitions and the default session', () => {
    const partitions = createPartitions(new PermissionPolicy())
    for (const one of [partitions.persistent, partitions.ephemeral, defaultSession]) {
      expect((one as unknown as FakeSession).handlers).toEqual(['request', 'check', 'device'])
    }
  })

  it('shares the policy with web-contents-created: a second apply installs nothing twice', () => {
    const policy = new PermissionPolicy()
    const partitions = createPartitions(policy)
    policy.apply(partitions.persistent)
    policy.apply(partitions.ephemeral)
    expect(calls.filter((one) => one.startsWith('handlers'))).toHaveLength(3)
  })
})

describe('applyWebRTCPolicy (SECURITY.org T7)', () => {
  it('names the public interface only, on the WebContents', () => {
    const set: string[] = []
    applyWebRTCPolicy({
      setWebRTCIPHandlingPolicy(policy) {
        set.push(policy)
      },
    })
    expect(WEBRTC_POLICY).toBe('default_public_interface_only')
    expect(set).toEqual([WEBRTC_POLICY])
  })
})

describe('recordRequests (SECURITY.org T7)', () => {
  it('keeps the session and the scheme and host of a request, never the path or query', () => {
    const persistent = fakeSession(PERSISTENT_PARTITION)
    const log = recordRequests({ default: defaultSession, [PERSISTENT_PARTITION]: persistent })
    const answers: object[] = []
    const answer = (response: object): void => {
      answers.push(response)
    }
    defaultSession.listener?.(
      { url: 'file:///Users/someone/nemesis/out/renderer/index.html' },
      answer,
    )
    persistent.listener?.({ url: 'https://example.test/path?token=secret' }, answer)
    expect(log).toEqual([
      { partition: 'default', origin: 'file://' },
      { partition: PERSISTENT_PARTITION, origin: 'https://example.test' },
    ])
    expect(JSON.stringify(log)).not.toContain('secret')
    expect(JSON.stringify(log)).not.toContain('/path')
  })

  it('lets every request through: the log observes, it does not block', () => {
    recordRequests({ default: defaultSession })
    const answers: object[] = []
    defaultSession.listener?.({ url: 'https://example.test/' }, (response) => {
      answers.push(response)
    })
    expect(answers).toEqual([{}])
  })

  it('records a request whose URL does not parse without throwing', () => {
    const log = recordRequests({ default: defaultSession })
    defaultSession.listener?.({ url: 'not a url' }, () => undefined)
    expect(log).toEqual([{ partition: 'default', origin: 'an unparseable URL' }])
  })
})
