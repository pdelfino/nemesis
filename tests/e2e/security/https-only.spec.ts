import { expect, test } from '../_test'
import { fixtureServer, launchNemesis, OFF_LOOPBACK_HOST } from './_harness'

/**
 * SECURITY.org, non-negotiables row 6: "HTTPS-only" (#52, threat T3): a
 * plain `http:` navigation off loopback never commits, a certificate error
 * is fatal, and neither asks the user anything.
 *
 * The fixture server listens on loopback, so the off-loopback case needs a
 * name: the harness maps `nemesis.test` to 127.0.0.1 through Chromium's host
 * resolver rules on the test launch, port kept. From a page, three
 * navigations:
 *
 * - `http://nemesis.test:<https port>/...` is cancelled and re-issued on
 *   `https:`, which lands on the HTTPS server: the upgraded URL commits, the
 *   plain one never does, and the plain server never hears of it.
 * - `http://nemesis.test:<http port>/...` is upgraded the same way, but the
 *   plain server speaks no TLS, so the upgraded load fails: the main process
 *   logs the failure by code, the transcript tells the user, and nothing
 *   falls back to `http:`.
 * - `http://127.0.0.1:<http port>/...` is loopback, the product rule's one
 *   allowance (Pedro, 2026-OCTOBER-18): it commits.
 *
 * Then a second launch without `NEMESIS_TEST_CA`: the HTTPS fixture, signed
 * by a certificate nothing trusts, fails to load with no dialog, and the
 * transcript names the host and the code. The first launch loads the same
 * fixture, which proves the anchor is what made the difference.
 */

interface NavigationWindow {
  readonly location?: { href: string }
}

/** The lines the main process writes for the transport, and the whole of them. */
const TRANSPORT = /^transport: (.+)$/gm

test('plain http off loopback is upgraded or refused, loopback http commits, and a certificate error is fatal', async () => {
  const fixtures = await fixtureServer()
  const nemesis = await launchNemesis()
  let stderr = ''
  nemesis.app.process().stderr?.on('data', (chunk: Buffer | string) => {
    stderr += String(chunk)
  })
  const transport = (): string[] =>
    Array.from(stderr.matchAll(TRANSPORT), (match) => match[1] ?? '')
  const notes = (): Promise<string[]> =>
    nemesis.window.locator('#transcript .cm-line').allTextContents()
  // The committed URL of every WebContents, from the main process: after the
  // app cancels a navigation, Playwright's own view of the page waits on it.
  const committed = (): Promise<string[]> =>
    nemesis.app.evaluate(({ webContents }) =>
      webContents.getAllWebContents().map((one) => one.getURL()),
    )
  const navigate = (
    page: { evaluate: (fn: (href: string) => void, arg: string) => Promise<void> },
    href: string,
  ) =>
    page.evaluate((target) => {
      const { location } = globalThis as NavigationWindow
      if (location) location.href = target
    }, href)
  try {
    const home = fixtures.secureUrl('node-probe.html')
    const buffer = await nemesis.openPageBuffer(home)
    expect(buffer.loadError).toBeNull()
    await expect(buffer.page).toHaveTitle('node probe')
    const windowsBefore = nemesis.app.windows().length
    const id = await nemesis.app.evaluate(
      ({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()
          .map((one) => one.webContents.id)
          .sort()
          .at(-1) ?? -1,
    )

    // 1. Upgraded, and the upgrade lands: the https URL commits, the http one never did.
    const upgradable = fixtures.upgradableUrl('permissions.html')
    const upgraded = upgradable.replace(/^http:/, 'https:')
    await navigate(buffer.page, upgradable)
    await expect.poll(transport).toContain(`upgraded http: navigation from page contents ${id}`)
    await expect.poll(committed).toContain(upgraded)
    expect(await committed()).not.toContain(upgradable)
    expect(fixtures.requested).toEqual(['/node-probe.html', '/permissions.html'])
    expect(await notes()).not.toContainEqual(expect.stringContaining('T3'))

    // 2. Upgraded, and the upgrade fails: a notice, a log line by code, and no fallback.
    const dead = fixtures.offLoopbackUrl('navigation.html')
    const requestedBefore = fixtures.requested.length
    await navigate(buffer.page, dead)
    await expect
      .poll(notes)
      .toContainEqual(
        expect.stringMatching(
          new RegExp(
            `^Could not load https://${OFF_LOOPBACK_HOST}:\\d+ after upgrading a plain http: navigation: ERR_[A-Z_]+; nothing falls back to http: \\(SECURITY\\.org, T3\\)$`,
          ),
        ),
      )
    expect(transport()).toContainEqual(
      expect.stringMatching(
        new RegExp(`^https: load failed with ERR_[A-Z_]+ in page contents ${id}$`),
      ),
    )
    expect(await committed()).not.toContain(dead)
    expect(fixtures.requested.slice(requestedBefore)).toEqual([])
    expect(nemesis.app.windows().length).toBe(windowsBefore)

    // 3. Loopback http is allowed: it commits, untouched by the transport.
    const loopback = fixtures.url('node-probe.html')
    const linesBefore = transport().length
    await navigate(buffer.page, loopback)
    await expect.poll(committed).toContain(loopback)
    expect(transport().length).toBe(linesBefore)

    // The log names schemes, codes and contents, never the host or a path.
    for (const line of transport()) {
      expect(line).not.toContain(OFF_LOOPBACK_HOST)
      expect(line).not.toContain('.html')
    }

    await buffer.close()
  } finally {
    await nemesis.close()
  }

  // The second launch: no anchor, so this run's certificate is one nothing trusts.
  const untrusting = await launchNemesis({ trustFixtures: false })
  try {
    const windowsBefore = untrusting.app.windows().length
    const refused = await untrusting.openPageBuffer(fixtures.secureUrl('node-probe.html'))
    expect(refused.loadError).toContain('ERR_CERT_AUTHORITY_INVALID')
    // One window for the buffer itself, and no dialog.
    expect(untrusting.app.windows().length).toBe(windowsBefore + 1)
    await expect
      .poll(() => untrusting.window.locator('#transcript .cm-line').allTextContents())
      .toContain(
        `Certificate error for ${new URL(fixtures.httpsOrigin).host}: net::ERR_CERT_AUTHORITY_INVALID; the page was not loaded (SECURITY.org, T3)`,
      )
    await refused.close()
  } finally {
    await untrusting.close()
    await fixtures.close()
  }
})
