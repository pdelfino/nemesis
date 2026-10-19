import { X509Certificate } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { isIP } from 'node:net'
import type { App, Session } from 'electron'
import type { AgentNoticeEvent } from '../agent/events'
import type { ContentsKind } from './navigation-policy'
import type { NoticeListener } from './permissions'
import { warnLimited } from './warn-limited'

/**
 * HTTPS-only with fatal certificate errors (#52, SECURITY.org T3).
 *
 * A plain `http:` page or a bad certificate is where a credential leaks, so
 * version 1 has no click-through. The scheme table stays the navigation
 * policy's (#48): `http:` and `https:` are the page schemes. This module
 * decides which `http:` hosts may commit.
 *
 * - On `will-navigate` and `will-redirect` of page contents, an `http:` URL
 *   off loopback is upgraded: the navigation is cancelled and re-issued on
 *   `https:` once, same host, same port, same path. If the upgraded load
 *   fails, a notice says so and nothing falls back to `http:`. A page that
 *   sends the upgraded load back to `http:` is refused, not upgraded again.
 * - Loopback `http:` (`127.0.0.1` and `localhost`, any port) stays allowed,
 *   because the cockpit's users run local dev servers; that is a product rule
 *   picked by Pedro on 2026-OCTOBER-18, not a test seam. The mode line that
 *   marks it `http` in red belongs to the page buffers of M4.
 * - A certificate error is fatal: the one `certificate-error` handler in the
 *   app answers `callback(false)`, which is also Electron's default, and
 *   writes a notice naming the host and the error code. A unit test greps
 *   `src/` and asserts nothing ever answers `true`.
 *
 * The one seam is a test-only trust anchor so the security specs can load a
 * page at all: when `NODE_ENV=test` and `NEMESIS_TEST_CA` names a PEM file,
 * every session the app creates gets a certificate verify proc that accepts a
 * leaf chaining to that one certificate, for the host it names, and defers to
 * Chromium's own verdict for everything else. Any other run never reads the
 * variable: `trustAnchorFrom` answers null before it looks at the path.
 *
 * `upgradeOf` is exported for the page URLs the app itself loads later (M4,
 * #73): `loadURL` does not raise `will-navigate`, so the buffer manager asks
 * the same question before it loads.
 */

/** The hosts plain `http:` may commit on: the developer's own machine, any port. */
export const LOOPBACK_HOSTS: readonly string[] = Object.freeze(['127.0.0.1', 'localhost'])

/** Electron's answers to a certificate verify proc. */
const VERIFY_ACCEPT = 0
const VERIFY_USE_CHROMIUM = -3

/** How many issuers above the leaf the chain walk reads before it gives up. */
const MAX_CHAIN_DEPTH = 5

export function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK_HOSTS.includes(hostname.toLowerCase())
}

/**
 * The `https:` URL a plain `http:` navigation is re-issued on, or null when
 * the URL is not transport's business: `https:` already, `http:` on loopback,
 * any other scheme (the navigation policy decides those), or no URL at all.
 */
export function upgradeOf(url: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== 'http:') return null
  if (isLoopbackHost(parsed.hostname)) return null
  parsed.protocol = 'https:'
  return parsed.href
}

/** The host of a URL as a notice names it, `host:port` when there is a port, or a placeholder. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return 'an unparseable URL'
  }
}

/** Reads the test-only anchor: null unless NODE_ENV is `test` and NEMESIS_TEST_CA names a file. */
export function trustAnchorFrom(
  env: Readonly<Record<string, string | undefined>> = process.env,
): X509Certificate | null {
  if (env['NODE_ENV'] !== 'test') return null
  const path = env['NEMESIS_TEST_CA']
  if (path === undefined || path.length === 0) return null
  return new X509Certificate(readFileSync(path))
}

/** The minimum of Electron's Certificate the chain walk reads: PEM data and the issuer above. */
export interface CertificateLink {
  readonly data: string
  readonly issuerCert?: CertificateLink | undefined
}

/** What the verify proc is asked about: the host, and the chain the server sent. */
export interface VerifyRequest {
  readonly hostname: string
  readonly certificate: CertificateLink
}

function withinValidity(certificate: X509Certificate, at: number): boolean {
  return (
    new Date(certificate.validFrom).getTime() <= at && at <= new Date(certificate.validTo).getTime()
  )
}

/** An IP literal is checked against the IP names, a DNS name against the DNS names; the two never match across. */
function namesHost(certificate: X509Certificate, hostname: string): boolean {
  try {
    return isIP(hostname) !== 0
      ? certificate.checkIP(hostname) !== undefined
      : certificate.checkHost(hostname) !== undefined
  } catch {
    return false
  }
}

/**
 * True when the leaf is valid now, names `hostname`, and either is the anchor
 * or chains to it through the issuers the server sent, each link signed by
 * the one above. Anything else is false, which the verify proc turns into
 * Chromium's own verdict, never into acceptance.
 */
export function chainsToAnchor(
  anchor: X509Certificate,
  request: VerifyRequest,
  now: () => number = () => Date.now(),
): boolean {
  let link: CertificateLink | undefined = request.certificate
  let current: X509Certificate
  try {
    current = new X509Certificate(link.data)
  } catch {
    return false
  }
  const at = now()
  if (!withinValidity(current, at) || !namesHost(current, request.hostname)) return false
  for (let depth = 0; depth <= MAX_CHAIN_DEPTH && link !== undefined; depth += 1) {
    if (current.raw.equals(anchor.raw)) return true
    if (current.checkIssued(anchor) && current.verify(anchor.publicKey)) return true
    link = link.issuerCert
    if (link === undefined) return false
    let issuer: X509Certificate
    try {
      issuer = new X509Certificate(link.data)
    } catch {
      return false
    }
    if (!current.checkIssued(issuer) || !current.verify(issuer.publicKey)) return false
    if (!withinValidity(issuer, at)) return false
    current = issuer
  }
  return false
}

/** The minimum of a Session the anchor installs on; a fake satisfies it in the unit tests. */
export type VerifySurface = Pick<Session, 'setCertificateVerifyProc'>

/** The minimum of a WebContents the transport guards need; a fake satisfies it in the unit tests. */
export interface TransportSurface {
  readonly id: number
  on(
    event: 'will-navigate' | 'will-redirect',
    listener: (event: { preventDefault(): void }, url: string) => void,
  ): unknown
  loadURL(url: string): Promise<void>
}

/** The minimum of `app` the certificate guard needs. */
export type CertificateErrors = Pick<App, 'on'>

export interface TransportPolicyOptions {
  /** `process.env` unless a test says otherwise; read once, at construction. */
  readonly env?: Readonly<Record<string, string | undefined>> | undefined
}

interface Watched {
  kind: ContentsKind
  /** The `https:` URL re-issued and not yet settled, so a bounce back to `http:` is refused. */
  pending: string | null
}

export class TransportPolicy {
  private readonly anchor: X509Certificate | null
  private readonly listeners = new Set<NoticeListener>()
  private readonly watched = new WeakMap<TransportSurface, Watched>()
  private readonly anchored = new WeakSet<VerifySurface>()
  private readonly noticed = new Set<string>()

  constructor(options: TransportPolicyOptions = {}) {
    this.anchor = trustAnchorFrom(options.env ?? process.env)
  }

  on(listener: NoticeListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /**
   * The test-only anchor on one session, or nothing at all outside a test
   * run: a session without the proc is verified by Chromium alone.
   */
  apply(one: VerifySurface): void {
    const anchor = this.anchor
    if (anchor === null || this.anchored.has(one)) return
    this.anchored.add(one)
    one.setCertificateVerifyProc((request, callback) => {
      callback(chainsToAnchor(anchor, request) ? VERIFY_ACCEPT : VERIFY_USE_CHROMIUM)
    })
  }

  /**
   * Certificate errors are fatal. The handler answers false, which is what
   * Electron does without a handler; it exists to tell the user which host
   * and which error, once per pair, in the transcript. Nothing here reads
   * `event`, so nothing can prevent its default, which is the only way an
   * answer of true would count.
   */
  guardCertificates(host: CertificateErrors): void {
    host.on('certificate-error', (_event, _contents, url, error, _certificate, callback) => {
      callback(false)
      warnLimited(`transport certificate ${error}`, `transport: certificate error ${error}`)
      const at = hostOf(url)
      const key = `${at} ${error}`
      if (this.noticed.has(key)) return
      this.noticed.add(key)
      this.notify(
        `Certificate error for ${at}: ${error}; the page was not loaded (SECURITY.org, T3)`,
      )
    })
  }

  /**
   * Installs the upgrade on `contents` as `kind`, or, when it is already
   * installed, records the new kind. Only page contents are upgraded: an
   * internal page's `http:` navigation is the navigation policy's to refuse
   * (#48, #96), and re-issuing it on `https:` would walk around that refusal.
   */
  watch(contents: TransportSurface, kind: ContentsKind): void {
    const existing = this.watched.get(contents)
    if (existing !== undefined) {
      existing.kind = kind
      return
    }
    const state: Watched = { kind, pending: null }
    this.watched.set(contents, state)

    const guard =
      (what: 'navigation' | 'redirect') =>
      (event: { preventDefault(): void }, url: string): void => {
        if (state.kind !== 'page') return
        const upgraded = upgradeOf(url)
        if (upgraded === null) return
        event.preventDefault()
        if (state.pending === upgraded) {
          // The upgraded load answered with a bounce back to http: on the same
          // URL. Once means once: refuse rather than loop.
          warnLimited(
            `transport refused ${what}`,
            `transport: refused http: ${what} from ${state.kind} contents ${contents.id}`,
          )
          this.notify(
            `Refused plain http: ${what} to ${hostOf(url)}: the https: load sent it back to http:, and nothing falls back (SECURITY.org, T3)`,
          )
          return
        }
        warnLimited(
          `transport upgraded ${what}`,
          `transport: upgraded http: ${what} from ${state.kind} contents ${contents.id}`,
        )
        state.pending = upgraded
        contents
          .loadURL(upgraded)
          .then(() => {
            if (state.pending === upgraded) state.pending = null
          })
          .catch((error: unknown) => {
            if (state.pending === upgraded) state.pending = null
            const code = errorCodeOf(error)
            // ERR_ABORTED is a load replaced by another navigation, which reports itself.
            if (code === 'ERR_ABORTED') return
            warnLimited(
              `transport failed ${code}`,
              `transport: https: load failed with ${code} in ${state.kind} contents ${contents.id}`,
            )
            this.notify(
              `Could not load https://${hostOf(upgraded)} after upgrading a plain http: ${what}: ${code}; nothing falls back to http: (SECURITY.org, T3)`,
            )
          })
      }

    contents.on('will-navigate', guard('navigation'))
    contents.on('will-redirect', guard('redirect'))
  }

  private notify(text: string): void {
    const event: AgentNoticeEvent = { type: 'notice', text }
    for (const listener of this.listeners) listener(event)
  }
}

/** Electron's load errors carry the Chromium code; anything else is named by its message. */
function errorCodeOf(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const code = (error as { code?: unknown }).code
    if (typeof code === 'string' && code.length > 0) return code
  }
  return error instanceof Error ? error.message : String(error)
}
