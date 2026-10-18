import { app, session, type CallbackResponse, type Session, type WebContents } from 'electron'
import { originOf, type PermissionPolicy } from './permissions'

/**
 * The privacy baseline (#54, SECURITY.org T7): two session partitions, no IP
 * leak through WebRTC, DNS resolved by the system, and nothing on the wire
 * the user did not ask for.
 *
 * `persist:default` keeps the user's own browsing on disk, in the profile.
 * `ephemeral` has no `persist:` prefix, so Chromium keeps it in memory and
 * it is gone when the process is: wiped on close by construction, with no
 * cleanup step that could be skipped. Both get the deny-by-default
 * permission handlers of #49 at creation, so a page buffer that lands in
 * either (#73) is covered before its first request, and
 * `web-contents-created` applies the same policy again, which is a no-op.
 * The default session is treated the same way: the cockpit window lives on
 * it in M1, and so does the security harness's page buffer.
 *
 * WebRTC is told to use the public interface only, so a page cannot read
 * the machine's private addresses through an ICE candidate. Electron keeps
 * that setting on the WebContents, not on the session, so it is applied
 * from `web-contents-created` to every WebContents the moment it exists,
 * whatever partition it uses, the way #48 and #49 apply theirs. DNS over
 * HTTPS is off, so names resolve through the system and the hosts blocklist
 * applies; that is the user's rule, not a default to revisit.
 *
 * No telemetry, crash reporting or update check exists in version 1: the app
 * never loads `autoUpdater` or `crashReporter`, and
 * tests/e2e/security/startup-no-network.spec.ts proves the point by reading
 * every request each session makes from launch to idle, through
 * `recordRequests` below.
 */

export const PERSISTENT_PARTITION = 'persist:default'
export const EPHEMERAL_PARTITION = 'ephemeral'

/** Public interface only: no private address ever leaves in an ICE candidate. */
export const WEBRTC_POLICY = 'default_public_interface_only'

export interface Partitions {
  readonly persistent: Session
  readonly ephemeral: Session
}

/** The minimum of a WebContents the WebRTC policy sets on. */
export type WebRTCSurface = Pick<WebContents, 'setWebRTCIPHandlingPolicy'>

/** Public interface only, on one WebContents. Applied from `web-contents-created`. */
export function applyWebRTCPolicy(contents: WebRTCSurface): void {
  contents.setWebRTCIPHandlingPolicy(WEBRTC_POLICY)
}

/**
 * Creates both partitions with the permission handlers installed, after the
 * host resolver is configured, so no session exists before DNS over HTTPS
 * is off. Called once the app is ready; Electron has no sessions before that.
 */
export function createPartitions(policy: PermissionPolicy): Partitions {
  app.configureHostResolver({ secureDnsMode: 'off' })
  const persistent = session.fromPartition(PERSISTENT_PARTITION)
  const ephemeral = session.fromPartition(EPHEMERAL_PARTITION)
  for (const one of [session.defaultSession, persistent, ephemeral]) policy.apply(one)
  return { persistent, ephemeral }
}

/** One request a session made: which session, and the scheme and host it went to. */
export interface RequestRecord {
  readonly partition: string
  readonly origin: string
}

/** What the log reads of a request: the URL, and nothing else. */
export interface RequestDetails {
  readonly url: string
}

/** The minimum of a Session the request log installs on; a fake satisfies it in the unit tests. */
export interface RequestSurface {
  readonly webRequest: {
    onBeforeRequest(
      listener: (details: RequestDetails, callback: (response: CallbackResponse) => void) => void,
    ): void
  }
}

/**
 * Logs the scheme and host of every request each named session makes, from
 * the moment it is installed, and lets the request through. Never the path
 * or the query, which can carry a secret. Test-only: the main process
 * installs it under NODE_ENV=test for the no-network spec, before the
 * cockpit window loads, and nothing else may take `onBeforeRequest`, which
 * Electron gives to one listener per session.
 */
export function recordRequests(
  sessions: Readonly<Record<string, RequestSurface>>,
): readonly RequestRecord[] {
  const log: RequestRecord[] = []
  for (const [partition, one] of Object.entries(sessions)) {
    one.webRequest.onBeforeRequest((details, callback) => {
      log.push({ partition, origin: originOf(details.url) ?? 'an unparseable URL' })
      callback({})
    })
  }
  return log
}
