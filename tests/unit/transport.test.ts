import { X509Certificate } from 'node:crypto'
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  chainsToAnchor,
  hostOf,
  isLoopbackHost,
  LOOPBACK_HOSTS,
  TransportPolicy,
  trustAnchorFrom,
  upgradeOf,
} from '../../src/main/security/transport'
import { selfSignedCertificate } from '../e2e/security/_certificate'

/**
 * HTTPS-only with fatal certificate errors (#52, SECURITY.org T3), on
 * strings and fakes: the upgrade table, the guards on a fake WebContents,
 * the test-only trust anchor, and the one certificate-error handler in the
 * tree, which never answers true. The live run is
 * tests/e2e/security/https-only.spec.ts.
 */

const SRC = resolve(__dirname, '../../src')

function filesUnder(dir: string): string[] {
  const found: string[] = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) found.push(...filesUnder(path))
    else found.push(path)
  }
  return found
}

type Listener = (event: { preventDefault(): void }, url: string) => void

interface FakeContents {
  readonly id: number
  readonly listeners: Map<string, Listener>
  readonly loaded: string[]
  loadOutcome: Promise<void>
  on(event: string, listener: Listener): FakeContents
  loadURL(url: string): Promise<void>
}

function fakeContents(id: number): FakeContents {
  const one: FakeContents = {
    id,
    listeners: new Map(),
    loaded: [],
    loadOutcome: Promise.resolve(),
    on(event, listener) {
      one.listeners.set(event, listener)
      return one
    },
    loadURL(url) {
      one.loaded.push(url)
      return one.loadOutcome
    },
  }
  return one
}

function fire(contents: FakeContents, event: string, url: string): boolean {
  let prevented = false
  const listener = contents.listeners.get(event)
  if (listener === undefined) throw new Error(`no listener for ${event}`)
  listener(
    {
      preventDefault: () => {
        prevented = true
      },
    },
    url,
  )
  return prevented
}

/** A load error the way Electron rejects `loadURL`: the Chromium code on the error. */
function loadError(code: string): Promise<void> {
  return Promise.reject(Object.assign(new Error(`${code} (-1) loading`), { code }))
}

const settle = (): Promise<void> => new Promise((done) => setTimeout(done, 0))

describe('upgradeOf (SECURITY.org T3)', () => {
  it('re-issues plain http off loopback on https, keeping host, port, path and query', () => {
    expect(upgradeOf('http://example.test/path?q=1#f')).toBe('https://example.test/path?q=1#f')
    expect(upgradeOf('http://example.test:8080/')).toBe('https://example.test:8080/')
    expect(upgradeOf('http://10.0.0.5/')).toBe('https://10.0.0.5/')
    expect(upgradeOf('http://localhost.example.test/')).toBe('https://localhost.example.test/')
  })

  it('leaves loopback http alone, any port, any case', () => {
    expect(LOOPBACK_HOSTS).toEqual(['127.0.0.1', 'localhost'])
    expect(upgradeOf('http://127.0.0.1/')).toBeNull()
    expect(upgradeOf('http://127.0.0.1:5173/node-probe.html')).toBeNull()
    expect(upgradeOf('http://localhost:3000/')).toBeNull()
    expect(upgradeOf('http://LOCALHOST/')).toBeNull()
    expect(isLoopbackHost('localhost')).toBe(true)
    expect(isLoopbackHost('127.0.0.1')).toBe(true)
    expect(isLoopbackHost('127.0.0.2')).toBe(false)
    expect(isLoopbackHost('[::1]')).toBe(false)
  })

  it('is not its business when the scheme is not plain http or the string is not a URL', () => {
    expect(upgradeOf('https://example.test/')).toBeNull()
    expect(upgradeOf('nemesis://app/')).toBeNull()
    expect(upgradeOf('file:///etc/hosts')).toBeNull()
    expect(upgradeOf('javascript:alert(1)')).toBeNull()
    expect(upgradeOf('not a url')).toBeNull()
  })

  it('names a host for a notice, with the port when there is one', () => {
    expect(hostOf('https://example.test:8443/a?b')).toBe('example.test:8443')
    expect(hostOf('https://example.test/')).toBe('example.test')
    expect(hostOf('nope')).toBe('an unparseable URL')
  })
})

describe('TransportPolicy.watch (SECURITY.org T3)', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  beforeEach(() => warn.mockClear())

  it('cancels a plain http navigation off loopback and re-issues it on https once', async () => {
    const policy = new TransportPolicy({ env: {} })
    const notices: string[] = []
    policy.on((event) => notices.push(event.text))
    const contents = fakeContents(7)
    policy.watch(contents, 'page')

    expect(fire(contents, 'will-navigate', 'http://example.test/login')).toBe(true)
    expect(contents.loaded).toEqual(['https://example.test/login'])
    await settle()
    expect(notices).toEqual([])
    expect(warn).toHaveBeenCalledWith('transport: upgraded http: navigation from page contents 7')
    // The log names the scheme and the contents, never the host.
    for (const call of warn.mock.calls) expect(String(call[0])).not.toContain('example.test')
  })

  it('lets loopback http and https through untouched', () => {
    const policy = new TransportPolicy({ env: {} })
    const contents = fakeContents(1)
    policy.watch(contents, 'page')
    expect(fire(contents, 'will-navigate', 'http://127.0.0.1:8080/')).toBe(false)
    expect(fire(contents, 'will-navigate', 'http://localhost:3000/')).toBe(false)
    expect(fire(contents, 'will-navigate', 'https://example.test/')).toBe(false)
    expect(fire(contents, 'will-redirect', 'http://localhost/')).toBe(false)
    expect(contents.loaded).toEqual([])
  })

  it('refuses a redirect to plain http off loopback the same way: upgraded once', () => {
    const policy = new TransportPolicy({ env: {} })
    const contents = fakeContents(2)
    policy.watch(contents, 'page')
    expect(fire(contents, 'will-redirect', 'http://example.test/next')).toBe(true)
    expect(contents.loaded).toEqual(['https://example.test/next'])
    expect(warn).toHaveBeenCalledWith('transport: upgraded http: redirect from page contents 2')
  })

  it('says so when the upgraded load fails, and nothing falls back to http', async () => {
    const policy = new TransportPolicy({ env: {} })
    const notices: string[] = []
    policy.on((event) => notices.push(event.text))
    const contents = fakeContents(3)
    contents.loadOutcome = loadError('ERR_SSL_PROTOCOL_ERROR')
    policy.watch(contents, 'page')
    fire(contents, 'will-navigate', 'http://example.test:8080/')
    await settle()
    expect(contents.loaded).toEqual(['https://example.test:8080/'])
    expect(notices).toEqual([
      'Could not load https://example.test:8080 after upgrading a plain http: navigation: ERR_SSL_PROTOCOL_ERROR; nothing falls back to http: (SECURITY.org, T3)',
    ])
    expect(warn).toHaveBeenCalledWith(
      'transport: https: load failed with ERR_SSL_PROTOCOL_ERROR in page contents 3',
    )
  })

  it('is quiet about a load another navigation replaced', async () => {
    const policy = new TransportPolicy({ env: {} })
    const notices: string[] = []
    policy.on((event) => notices.push(event.text))
    const contents = fakeContents(4)
    contents.loadOutcome = loadError('ERR_ABORTED')
    policy.watch(contents, 'page')
    fire(contents, 'will-navigate', 'http://example.test/')
    await settle()
    expect(notices).toEqual([])
  })

  it('refuses the bounce back to http while the upgraded load is pending, rather than loop', async () => {
    const policy = new TransportPolicy({ env: {} })
    const notices: string[] = []
    policy.on((event) => notices.push(event.text))
    const contents = fakeContents(5)
    contents.loadOutcome = new Promise(() => undefined)
    policy.watch(contents, 'page')
    fire(contents, 'will-navigate', 'http://example.test/')
    expect(fire(contents, 'will-redirect', 'http://example.test/')).toBe(true)
    expect(contents.loaded).toEqual(['https://example.test/'])
    expect(notices).toEqual([
      'Refused plain http: redirect to example.test: the https: load sent it back to http:, and nothing falls back (SECURITY.org, T3)',
    ])
    expect(warn).toHaveBeenCalledWith('transport: refused http: redirect from page contents 5')
    // A different URL is a new navigation, upgraded on its own.
    expect(fire(contents, 'will-navigate', 'http://example.test/other')).toBe(true)
    expect(contents.loaded).toEqual(['https://example.test/', 'https://example.test/other'])
  })

  it('never upgrades internal contents, whose http navigations are the navigation policy to refuse', () => {
    const policy = new TransportPolicy({ env: {} })
    const contents = fakeContents(6)
    policy.watch(contents, 'page')
    policy.watch(contents, 'internal')
    expect(fire(contents, 'will-navigate', 'http://evil.test/')).toBe(false)
    expect(contents.loaded).toEqual([])
    expect(contents.listeners.size).toBe(2)
  })
})

describe('the test-only trust anchor (SECURITY.org T3)', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nemesis-transport-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('is read only under NODE_ENV=test with NEMESIS_TEST_CA set', () => {
    const { certificate } = selfSignedCertificate()
    const path = join(dir, 'ca.pem')
    writeFileSync(path, certificate)
    expect(trustAnchorFrom({})).toBeNull()
    expect(trustAnchorFrom({ NEMESIS_TEST_CA: path })).toBeNull()
    expect(trustAnchorFrom({ NODE_ENV: 'production', NEMESIS_TEST_CA: path })).toBeNull()
    expect(trustAnchorFrom({ NODE_ENV: 'test' })).toBeNull()
    expect(trustAnchorFrom({ NODE_ENV: 'test', NEMESIS_TEST_CA: '' })).toBeNull()
    const anchor = trustAnchorFrom({ NODE_ENV: 'test', NEMESIS_TEST_CA: path })
    expect(anchor?.raw.equals(new X509Certificate(certificate).raw)).toBe(true)
  })

  it('accepts the anchor itself for the names it carries and nothing else', () => {
    const { certificate } = selfSignedCertificate()
    const anchor = new X509Certificate(certificate)
    const stranger = selfSignedCertificate('stranger').certificate
    expect(
      chainsToAnchor(anchor, { hostname: 'localhost', certificate: { data: certificate } }),
    ).toBe(true)
    expect(
      chainsToAnchor(anchor, { hostname: '127.0.0.1', certificate: { data: certificate } }),
    ).toBe(true)
    expect(
      chainsToAnchor(anchor, { hostname: 'example.test', certificate: { data: certificate } }),
    ).toBe(false)
    expect(chainsToAnchor(anchor, { hostname: 'localhost', certificate: { data: stranger } })).toBe(
      false,
    )
    expect(
      chainsToAnchor(anchor, {
        hostname: 'localhost',
        certificate: { data: stranger, issuerCert: { data: certificate } },
      }),
    ).toBe(false)
    expect(
      chainsToAnchor(anchor, { hostname: 'localhost', certificate: { data: 'garbage' } }),
    ).toBe(false)
    // Outside its validity, the anchor's own leaf is refused too.
    const later = () => Date.now() + 30 * 86400 * 1000
    expect(
      chainsToAnchor(anchor, { hostname: 'localhost', certificate: { data: certificate } }, later),
    ).toBe(false)
  })

  it('installs a verify proc per session with the anchor, and none without', () => {
    const { certificate } = selfSignedCertificate()
    const path = join(dir, 'ca.pem')
    writeFileSync(path, certificate)
    const stranger = selfSignedCertificate('stranger').certificate

    const procs: Array<(request: never, callback: (result: number) => void) => void> = []
    const one = {
      setCertificateVerifyProc: vi.fn((proc: (typeof procs)[number] | null) => {
        if (proc !== null) procs.push(proc)
      }),
    }

    new TransportPolicy({ env: { NODE_ENV: 'production', NEMESIS_TEST_CA: path } }).apply(one)
    expect(one.setCertificateVerifyProc).not.toHaveBeenCalled()

    const trusting = new TransportPolicy({ env: { NODE_ENV: 'test', NEMESIS_TEST_CA: path } })
    trusting.apply(one)
    trusting.apply(one)
    expect(one.setCertificateVerifyProc).toHaveBeenCalledTimes(1)
    const proc = procs[0]
    if (proc === undefined) throw new Error('no proc installed')
    const answers: number[] = []
    proc({ hostname: 'localhost', certificate: { data: certificate } } as never, (r) =>
      answers.push(r),
    )
    proc({ hostname: 'localhost', certificate: { data: stranger } } as never, (r) =>
      answers.push(r),
    )
    proc({ hostname: 'evil.test', certificate: { data: certificate } } as never, (r) =>
      answers.push(r),
    )
    // 0 accepts; -3 hands the decision back to Chromium, which is never acceptance.
    expect(answers).toEqual([0, -3, -3])
  })
})

describe('certificate errors are fatal (SECURITY.org T3)', () => {
  it('has one certificate-error handler in src/, and it never answers true', () => {
    const handlers = filesUnder(SRC).filter((path) =>
      readFileSync(path, 'utf8').includes('certificate-error'),
    )
    expect(handlers.map((path) => relative(SRC, path))).toEqual(['main/security/transport.ts'])
    const source = readFileSync(handlers[0] ?? '', 'utf8')
    expect(source.match(/'certificate-error'/g)?.length).toBe(1)
    // The handler: from the event name to the end of the method that installs it.
    const start = source.indexOf("'certificate-error'")
    const handler = source.slice(start, source.indexOf('\n  }\n', start))
    expect(handler).toContain('callback(false)')
    expect(handler).not.toMatch(/callback\(\s*true\s*\)/)
    expect(handler).not.toContain('preventDefault')
    // The handler never touches the event, so nothing can override the refusal.
    expect(handler).not.toMatch(/\bevent\./)
  })

  it('answers false and tells the user the host and the code, once per pair', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const policy = new TransportPolicy({ env: {} })
    const notices: string[] = []
    policy.on((event) => notices.push(event.text))
    let handler: ((...args: unknown[]) => void) | null = null
    policy.guardCertificates({
      on: ((event: string, listener: (...args: unknown[]) => void) => {
        if (event === 'certificate-error') handler = listener
      }) as never,
    })
    if (handler === null) throw new Error('no handler')
    const answers: boolean[] = []
    const callback = (trusted: boolean): void => {
      answers.push(trusted)
    }
    const fire = (url: string, code: string): void =>
      (handler as (...args: unknown[]) => void)(
        { preventDefault: () => undefined },
        {},
        url,
        code,
        {},
        callback,
        true,
      )
    fire('https://example.test:8443/login', 'net::ERR_CERT_AUTHORITY_INVALID')
    fire('https://example.test:8443/other', 'net::ERR_CERT_AUTHORITY_INVALID')
    fire('https://example.test:8443/', 'net::ERR_CERT_DATE_INVALID')
    expect(answers).toEqual([false, false, false])
    expect(notices).toEqual([
      'Certificate error for example.test:8443: net::ERR_CERT_AUTHORITY_INVALID; the page was not loaded (SECURITY.org, T3)',
      'Certificate error for example.test:8443: net::ERR_CERT_DATE_INVALID; the page was not loaded (SECURITY.org, T3)',
    ])
    expect(warn).toHaveBeenCalledWith(
      'transport: certificate error net::ERR_CERT_AUTHORITY_INVALID',
    )
    for (const call of warn.mock.calls) expect(String(call[0])).not.toContain('example.test')
    warn.mockRestore()
  })
})
