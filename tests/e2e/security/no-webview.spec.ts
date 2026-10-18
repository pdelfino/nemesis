import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { expect, test } from '@playwright/test'
import { HARDENED_WEB_PREFERENCES } from '../../../src/main/security/web-preferences'
import { fixtureServer, launchNemesis } from './_harness'

/**
 * SECURITY.org, non-negotiables row 3: "No `webview` tag, no `allowpopups`",
 * asserted the way the table asks, `will-attach-webview` rejects and a markup
 * scan of the internal pages finds neither (#48, threat T1).
 *
 * The webview fixture puts a `<webview allowpopups nodeintegration>` in its
 * markup and appends another by script. With `webviewTag` off the tag is an
 * unknown element and nothing attaches; the `will-attach-webview` guard is
 * installed on every WebContents all the same, for the day a preference slips.
 */

interface WebviewWindow {
  readonly __webview?: { readonly tags: number; readonly attached: number }
}

/** The page is written in the page's own terms: the specs compile with no DOM library. */
interface WebviewElement {
  setAttribute(name: string, value: string): void
  remove(): void
  getWebContentsId?: unknown
}

interface DocumentWindow {
  readonly document?: {
    createElement(tag: string): WebviewElement
    readonly body: { appendChild(node: WebviewElement): void }
  }
}

const RENDERER = resolve(__dirname, '../../../src/renderer')

/** The types that hold app or web content, the ones the app configures itself. */
const OURS = ['window', 'browserView', 'webview', 'offscreen']

test('no page attaches a webview, and the internal pages carry none', async () => {
  const fixtures = await fixtureServer()
  const nemesis = await launchNemesis()
  try {
    const buffer = await nemesis.openPageBuffer(fixtures.url('webview.html'))
    expect(buffer.loadError).toBeNull()
    await expect(buffer.page).toHaveTitle('webview')

    // Two tags asked, none attached: the fixture's own count, computed in the page.
    await expect(buffer.page.locator('#result')).toHaveText('2 tags, 0 attached')
    expect(await buffer.page.evaluate(() => (globalThis as WebviewWindow).__webview)).toEqual({
      tags: 2,
      attached: 0,
    })
    // The guest page never loaded: the fixture server was never asked for it by the tag.
    expect(fixtures.requested).toEqual(['/webview.html'])

    // The cockpit cannot grow one either.
    expect(
      await nemesis.window.evaluate(() => {
        const { document } = globalThis as DocumentWindow
        if (document === undefined) return 'no document'
        const view = document.createElement('webview')
        view.setAttribute('src', 'https://example.test/')
        view.setAttribute('allowpopups', '')
        document.body.appendChild(view)
        const attached = typeof view.getWebContentsId
        view.remove()
        return attached
      }),
    ).toBe('undefined')

    // No WebContents of type webview exists, and every one of ours has the guard.
    const contents = await nemesis.app.evaluate(({ webContents }) =>
      webContents.getAllWebContents().map((one) => ({
        id: one.id,
        type: one.getType(),
        guards: one.listenerCount('will-attach-webview'),
      })),
    )
    expect(contents.filter((one) => one.type === 'webview')).toEqual([])
    const ours = contents.filter((one) => OURS.includes(one.type))
    expect(ours.length).toBeGreaterThanOrEqual(2)
    for (const one of ours) {
      expect(
        one.guards,
        `WebContents ${one.id} (${one.type}) has no will-attach-webview guard`,
      ).toBeGreaterThan(0)
    }

    // The markup scan: no internal page carries a webview tag or allowpopups.
    const pages = readdirSync(RENDERER).filter((name) => name.endsWith('.html'))
    expect(pages).toContain('index.html')
    for (const name of pages) {
      const markup = readFileSync(join(RENDERER, name), 'utf8').toLowerCase()
      expect(markup, `${name} carries a webview tag`).not.toContain('<webview')
      expect(markup, `${name} carries allowpopups`).not.toContain('allowpopups')
    }

    // The preference the control rests on (#47).
    expect(HARDENED_WEB_PREFERENCES.webviewTag).toBe(false)

    await buffer.close()
  } finally {
    await nemesis.close()
    await fixtures.close()
  }
})
