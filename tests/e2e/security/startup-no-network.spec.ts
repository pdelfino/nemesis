import { expect, test } from '@playwright/test'
import {
  EPHEMERAL_PARTITION,
  PERSISTENT_PARTITION,
  WEBRTC_POLICY,
} from '../../../src/main/security/partitions'
import { launchNemesis } from './_harness'

/**
 * SECURITY.org, non-negotiables row "No network traffic the user did not ask
 * for" (#54, threat T7). No telemetry, crash reporting or update check
 * exists in version 1, and this spec is the proof rather than a promise.
 *
 * Under NODE_ENV=test the main process installs a `webRequest.onBeforeRequest`
 * logger on the default session and on both partitions before the cockpit
 * window loads, and keeps the scheme and host of every request, never the
 * path. From launch to idle, the partitions record nothing at all, and the
 * default session records only the app's own files. Nothing goes to http,
 * https, ws or wss. The same run reads the WebRTC policy back from every
 * WebContents that exists.
 */

/** The main-process global the app fills under test; the name is set in src/main/index.ts. */
const REQUEST_LOG = '__nemesisRequests'

interface RequestRecord {
  readonly partition: string
  readonly origin: string
}

/** The cockpit is served from nemesis://app (#50); its files come off disk through file:. */
const OWN_SCHEMES = /^(file|nemesis|devtools):/

const NETWORK_SCHEMES = /^(https?|wss?):/

test('the app makes no network request from launch to idle, on any session', async () => {
  const nemesis = await launchNemesis()
  try {
    // Idle: the cockpit is up and its mode line is drawn, then one more
    // second for anything deferred to the next tick, a timer or a worker.
    await expect(nemesis.window.locator('#transcript')).toBeVisible()
    await nemesis.window.waitForTimeout(1_000)

    const log = await nemesis.app.evaluate(
      (_electron, key) =>
        (globalThis as Record<string, unknown>)[key] as readonly RequestRecord[] | undefined,
      REQUEST_LOG,
    )
    // The logger exists and saw the cockpit load: a spec that read an empty
    // list from a logger that was never installed would prove nothing.
    expect(log).toBeDefined()
    const records = log ?? []
    expect(records.some((one) => one.partition === 'default')).toBe(true)

    // Both partitions exist, with nothing on the wire.
    const partitions = await nemesis.app.evaluate(
      ({ session }, names) => names.map((name) => session.fromPartition(name).isPersistent()),
      [PERSISTENT_PARTITION, EPHEMERAL_PARTITION],
    )
    expect(partitions).toEqual([true, false])
    expect(records.filter((one) => one.partition === PERSISTENT_PARTITION)).toEqual([])
    expect(records.filter((one) => one.partition === EPHEMERAL_PARTITION)).toEqual([])

    // The default session loaded the app's own files and nothing else.
    for (const one of records) {
      expect(one.origin, one.partition).toMatch(OWN_SCHEMES)
      expect(one.origin, one.partition).not.toMatch(NETWORK_SCHEMES)
    }

    // WebRTC on every WebContents that exists uses the public interface only.
    const policies = await nemesis.app.evaluate(({ webContents }) =>
      webContents.getAllWebContents().map((one) => one.getWebRTCIPHandlingPolicy()),
    )
    expect(policies.length).toBeGreaterThan(0)
    for (const policy of policies) expect(policy).toBe(WEBRTC_POLICY)
  } finally {
    await nemesis.close()
  }
})
