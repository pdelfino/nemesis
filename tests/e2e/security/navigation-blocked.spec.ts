import { expect, test } from '@playwright/test'
import { COCKPIT_URL } from '../../../src/main/security/internal-scheme'
import { INTERNAL_SCHEME } from '../../../src/main/security/navigation-policy'
import { HARDENED_WEB_PREFERENCES } from '../../../src/main/security/web-preferences'
import { fixtureServer, launchNemesis } from './_harness'

/**
 * SECURITY.org, non-negotiables row 5: "Navigation is controlled", asserted
 * the way the table asks, `will-navigate` blocks `file:`, `javascript:` and a
 * top-level `data:` URL (#48, threats T1 and T3).
 *
 * The navigation fixture sets `location` to each of the three from a page
 * buffer, and none commits: the URL, the title and a canary paragraph are what
 * they were. Chromium's renderer refuses all three from an http page before
 * the main process hears of them, so the live evidence that the policy is
 * installed and deciding on that WebContents is a fourth URL the renderer does
 * hand over, one on the internal scheme, which a page may never reach.
 *
 * The cockpit is an internal page on nemesis://app (#50), a standard and
 * secure origin, so Chromium's renderer refuses file:///etc/hosts from it
 * the way it does from an http page, before the main process hears of it;
 * the spec reads the renderer's own refusal from the console. An https:
 * navigation does reach the main process, and the policy refuses it as
 * `internal`. The main process logs every refusal by scheme and kind, never
 * by URL.
 */

interface NavigationWindow {
  readonly __navigation?: { readonly label: string; readonly url: string }
  readonly location?: { href: string }
  readonly document?: {
    readonly title: string
    readonly readyState: string
    getElementById(id: string): { readonly textContent: string | null } | null
  }
}

/** What the page says about itself, read in the page. */
interface PageState {
  readonly title: string
  readonly readyState: string
  readonly canary: string | null
  readonly pwned: boolean
  readonly appName: string | null
}

/**
 * Reads the page through `evaluate`, which does not wait on navigations.
 * After the main process cancels a navigation in `will-navigate`, Playwright
 * keeps waiting for that navigation to finish, so a locator or `toHaveTitle`
 * on the same page hangs although the document is untouched and the main
 * process reports nothing loading. Only the assertions that follow a cancelled
 * navigation read this way; the ones before use locators as the other specs do.
 */
function readState(page: { evaluate: <T>(fn: () => T) => Promise<T> }): Promise<PageState> {
  return page.evaluate(() => {
    const { document } = globalThis as NavigationWindow
    return {
      title: document?.title ?? '',
      readyState: document?.readyState ?? '',
      canary: document?.getElementById('canary')?.textContent ?? null,
      pwned: document?.getElementById('pwned') !== null,
      appName: document?.getElementById('app-name')?.textContent ?? null,
    }
  })
}

/** The line the main process writes for a refused navigation, and the whole of it. */
const BLOCKED = /^navigation: blocked (\S+) to (\S+) from (\S+) contents (\d+)$/gm

const CANARY = 'NEMESIS-NAVIGATION-CANARY'

test('a page cannot navigate itself or the app to file:, javascript: or a top-level data: URL', async () => {
  const fixtures = await fixtureServer()
  const nemesis = await launchNemesis()
  let stderr = ''
  nemesis.app.process().stderr?.on('data', (chunk: Buffer | string) => {
    stderr += String(chunk)
  })
  const blocked = (): string[][] =>
    Array.from(stderr.matchAll(BLOCKED), (match) => [
      match[1] ?? '',
      match[2] ?? '',
      match[3] ?? '',
    ])
  try {
    const url = fixtures.url('navigation.html')
    const buffer = await nemesis.openPageBuffer(url)
    expect(buffer.loadError).toBeNull()
    await expect(buffer.page).toHaveTitle('navigation')
    await expect(buffer.page.locator('#canary')).toHaveText(CANARY)

    // The three the row names, from the fixture's own buttons. Each one is
    // asked for (the fixture records it) and none commits.
    for (const [button, label] of [
      ['#go-file', 'file'],
      ['#go-data', 'data'],
      ['#go-javascript', 'javascript'],
    ] as const) {
      await buffer.page.click(button)
      await expect(buffer.page.locator('#result')).toHaveText(label)
      expect(
        (await buffer.page.evaluate(() => (globalThis as NavigationWindow).__navigation))?.label,
      ).toBe(label)
      expect(buffer.page.url()).toBe(url)
      await expect(buffer.page).toHaveTitle('navigation')
      await expect(buffer.page.locator('#canary')).toHaveText(CANARY)
      // The URL the fixture asked for would have put #pwned in a new document.
      await expect(buffer.page.locator('#pwned')).toHaveCount(0)
    }
    expect(fixtures.requested).toEqual(['/navigation.html'])

    // The policy is live on the page buffer: a URL the renderer does hand to
    // the main process is refused there, by this app's guard, and logged.
    await buffer.page.evaluate((internal) => {
      const page = globalThis as NavigationWindow
      if (page.location) page.location.href = `${internal}//app/`
    }, INTERNAL_SCHEME)
    await expect.poll(blocked).toContainEqual(['navigation', INTERNAL_SCHEME, 'page'])
    expect(buffer.page.url()).toBe(url)
    expect(await readState(buffer.page)).toEqual({
      title: 'navigation',
      readyState: 'complete',
      canary: CANARY,
      pwned: false,
      appName: null,
    })

    // The internal page: file:///etc/hosts is refused by the renderer, which
    // says so on the console, and https: is a page's place, not the
    // cockpit's, so the policy refuses it as `internal`. Neither commits.
    const cockpitUrl = nemesis.window.url()
    expect(cockpitUrl).toBe(COCKPIT_URL)
    const rendererConsole: string[] = []
    nemesis.window.on('console', (message) => rendererConsole.push(message.text()))
    for (const [target, refusal] of [
      ['file:///etc/hosts', 'renderer'],
      ['https://example.test/', 'policy'],
    ] as const) {
      await nemesis.window.evaluate((href) => {
        const page = globalThis as NavigationWindow
        if (page.location) page.location.href = href
      }, target)
      if (refusal === 'policy') {
        await expect.poll(blocked).toContainEqual(['navigation', 'https:', 'internal'])
      } else {
        await expect
          .poll(() => rendererConsole)
          .toContain(`Not allowed to load local resource: ${target}`)
        expect(blocked()).not.toContainEqual(['navigation', 'file:', 'internal'])
      }
      expect(nemesis.window.url()).toBe(cockpitUrl)
      expect(await readState(nemesis.window)).toMatchObject({
        title: 'Nemesis',
        readyState: 'complete',
        appName: 'Nemesis',
      })
    }
    // The main process agrees: nothing is loading anywhere.
    expect(
      await nemesis.app.evaluate(({ webContents }) =>
        webContents.getAllWebContents().map((one) => one.isLoading()),
      ),
    ).not.toContain(true)

    // The log never carries the URL: not the path, not the fixture's port.
    for (const line of stderr.split('\n').filter((one) => one.startsWith('navigation:'))) {
      expect(line).not.toContain('/etc/hosts')
      expect(line).not.toContain('example.test')
      expect(line).not.toContain(fixtures.httpOrigin)
    }

    // The drag-and-drop navigation (T2) is a creation-time preference (#47).
    expect(HARDENED_WEB_PREFERENCES.navigateOnDragDrop).toBe(false)

    await buffer.close()
  } finally {
    await nemesis.close()
    await fixtures.close()
  }
})
