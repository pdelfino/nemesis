import type { ElectronApplication } from '@playwright/test'
import { expect, test, type Page } from './_test'
import { launchApp } from './_launch'
import { fixtureServer } from './security/_harness'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * The first page on screen (#119): `C-x C-f` reads a URL in the palette and
 * opens it in a page buffer, a WebContentsView of the main process's laid
 * over the page section; the buffer list carries its title and committed
 * URL, the mode line shows the URL with a loopback `http` in red, the palette
 * hides the view while it is open, back and forward walk the page's history,
 * by command and by trackpad swipe (#31), `C-c S` hands the committed URL
 * and title to the share menu, a test seam in place of the native one (#34),
 * and `C-x k` destroys it. The fixture is the security harness's, on its
 * plain loopback origin, which the product rule allows (#52).
 */

interface BufferInfo {
  readonly id: string
  readonly kind: string
  readonly title: string
  readonly url?: string
}

interface TestWindow {
  readonly nemesis: {
    readonly buffers: () => Promise<{
      readonly buffers: readonly BufferInfo[]
      readonly currentId: string | null
    }>
  }
}

/** The current buffer as the main process holds it. */
async function current(page: Page): Promise<BufferInfo | null> {
  return page.evaluate(async () => {
    const list = await (globalThis as unknown as TestWindow).nemesis.buffers()
    return list.buffers.find((buffer) => buffer.id === list.currentId) ?? null
  })
}

/** The URLs of the page views attached to the cockpit window now. */
function attachedViews(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().flatMap((window) =>
      window.contentView.children.flatMap((child) =>
        'webContents' in child ? [(child as Electron.WebContentsView).webContents.getURL()] : [],
      ),
    ),
  )
}

/** The URLs of every live WebContents of the app, the cockpit's included. */
function liveContents(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(({ webContents }) =>
    webContents
      .getAllWebContents()
      .filter((contents) => !contents.isDestroyed())
      .map((contents) => contents.getURL()),
  )
}

/** Emits a trackpad `swipe` on every cockpit window, as macOS would (#31). */
function swipe(app: ElectronApplication, direction: 'left' | 'right'): Promise<void> {
  return app.evaluate(({ BrowserWindow }, to) => {
    for (const window of BrowserWindow.getAllWindows()) window.emit('swipe', {}, to)
  }, direction)
}

/** What share-page handed the share menu so far (#34). Main process, under test only. */
function shares(app: ElectronApplication): Promise<unknown> {
  return app.evaluate(() => (globalThis as { __nemesisShares?: unknown }).__nemesisShares)
}

/** The zoom factor of the page view showing `url`. */
function zoomFactor(app: ElectronApplication, url: string): Promise<number | undefined> {
  return app.evaluate(
    ({ webContents }, shown) =>
      webContents
        .getAllWebContents()
        .find((contents) => !contents.isDestroyed() && contents.getURL() === shown)
        ?.getZoomFactor(),
    url,
  )
}

/** Runs a command by name at M-x. */
async function run(page: Page, command: string): Promise<void> {
  await page.keyboard.press('Alt+x')
  await expect(page.locator('#palette')).toBeVisible()
  // The palette input has the keyboard before anything is typed into it.
  await expect(page.locator('#palette-input .cm-content')).toBeFocused()
  await page.keyboard.type(command)
  await page.keyboard.press('Enter')
  await expect(page.locator('#palette')).toBeHidden()
}

test('C-x C-f opens a page buffer; title, URL, back, forward and kill follow it', async () => {
  const fixtures = await fixtureServer()
  const scratch = mkdtempSync(join(tmpdir(), 'nemesis-page-'))
  const clipboardFile = join(scratch, 'clipboard.txt')
  const { app } = await launchApp('nemesis-e2e-', [], {}, { NEMESIS_CLIPBOARD_TEXT: clipboardFile })
  try {
    const window = await app.firstWindow()
    await window.waitForLoadState('domcontentloaded')
    const first = fixtures.url('node-probe.html')
    const second = fixtures.url('window-open.html')

    // From the transcript buffer, C-x C-f reads a URL in the palette.
    await window.keyboard.press('Control+x')
    await window.keyboard.press('b')
    await expect.poll(async () => (await current(window))?.kind).toBe('transcript')
    await window.keyboard.press('Control+x')
    await window.keyboard.press('Control+f')
    await expect(window.locator('#palette-prompt')).toHaveText('Open URL:')
    // The palette input has the keyboard before anything is typed into it.
    await expect(window.locator('#palette-input .cm-content')).toBeFocused()
    await window.keyboard.type(first)
    await window.keyboard.press('Enter')

    // The page buffer is current, titled by the page, at the committed URL.
    await expect
      .poll(() => current(window))
      .toMatchObject({ kind: 'page', title: 'node probe', url: first })
    await expect(window.locator('#modeline #buffer-list')).toContainText('[node probe]')
    await expect(window.locator('#modeline #page-url')).toHaveText(first)
    // Plain http on loopback is allowed, and marked: the scheme is red.
    await expect(window.locator('#modeline #page-url .insecure')).toHaveText('http')
    await expect(window.locator('#page')).toBeVisible()
    await expect(window.locator('#transcript')).toBeHidden()
    await expect.poll(() => attachedViews(app)).toEqual([first])

    // The page's own view, as Playwright sees it.
    await expect.poll(() => app.windows().map((one) => one.url())).toContain(first)
    const view = app.windows().find((one) => one.url() === first)
    if (view === undefined) throw new Error('no page view')
    await expect(view).toHaveTitle('node probe')

    // The page navigates itself; the buffer follows the committed URL.
    await view.evaluate((href) => {
      ;(globalThis as unknown as { location: { href: string } }).location.href = href
    }, second)
    await expect
      .poll(() => current(window))
      .toMatchObject({ kind: 'page', title: 'window open', url: second })
    await expect(window.locator('#modeline #page-url')).toHaveText(second)

    // The palette hides the view while it is open, and gives it back after.
    await window.keyboard.press('Alt+x')
    await expect(window.locator('#palette')).toBeVisible()
    // The palette input has the keyboard before anything is typed into it.
    await expect(window.locator('#palette-input .cm-content')).toBeFocused()
    await expect.poll(() => attachedViews(app)).toEqual([])
    await window.keyboard.press('Escape')
    await expect(window.locator('#palette')).toBeHidden()
    await expect.poll(() => attachedViews(app)).toEqual([second])

    // Back and forward walk the page's history.
    await run(window, 'go-back')
    await expect
      .poll(() => current(window))
      .toMatchObject({ kind: 'page', title: 'node probe', url: first })
    await run(window, 'go-forward')
    await expect
      .poll(() => current(window))
      .toMatchObject({ kind: 'page', title: 'window open', url: second })

    // A swipe left goes back and a swipe right forward, as the keys do (#31).
    await swipe(app, 'left')
    await expect
      .poll(() => current(window))
      .toMatchObject({ kind: 'page', title: 'node probe', url: first })
    await swipe(app, 'right')
    await expect
      .poll(() => current(window))
      .toMatchObject({ kind: 'page', title: 'window open', url: second })

    // C-c S shares the page: the seam gets its committed URL and its title (#34).
    await window.keyboard.press('Control+c')
    await window.keyboard.press('Shift+S')
    await expect.poll(() => shares(app)).toEqual([{ urls: [second], title: 'window open' }])

    // copy-url puts the committed URL on the clipboard, copy-title the title (#173).
    await run(window, 'copy-url')
    expect(readFileSync(clipboardFile, 'utf8')).toBe(second)
    await run(window, 'copy-title')
    expect(readFileSync(clipboardFile, 'utf8')).toBe('window open')

    // Zoom in twice, then reset: the factor is 1 again (#173).
    await run(window, 'zoom-in')
    await run(window, 'zoom-in')
    await expect.poll(() => zoomFactor(app, second)).toBeGreaterThan(1)
    await run(window, 'reset-page-zoom')
    await expect.poll(() => zoomFactor(app, second)).toBe(1)

    // Switching away hides the page; switching back shows the same one.
    await window.keyboard.press('Control+x')
    await window.keyboard.press('b')
    await expect.poll(async () => (await current(window))?.kind).toBe('transcript')
    await expect.poll(() => attachedViews(app)).toEqual([])
    await expect(window.locator('#modeline #page-url')).toHaveText('')
    await expect(window.locator('#transcript')).toBeVisible()
    // On a buffer that holds no page, a swipe does nothing.
    await swipe(app, 'left')
    await expect.poll(async () => (await current(window))?.kind).toBe('transcript')
    // ...and share-page is a notice: nothing reaches the share menu.
    await run(window, 'share-page')
    await expect.poll(async () => (await current(window))?.kind).toBe('help')
    expect(await shares(app)).toHaveLength(1)
    // ...and so is copy-url: the clipboard keeps the page's title.
    await run(window, 'copy-url')
    expect(readFileSync(clipboardFile, 'utf8')).toBe('window open')
    await window.keyboard.press('Control+x')
    await window.keyboard.press('b')
    await expect.poll(async () => (await current(window))?.kind).toBe('transcript')
    await window.keyboard.press('Control+x')
    await window.keyboard.press('b')
    await window.keyboard.press('Control+x')
    await window.keyboard.press('b')
    await expect.poll(async () => (await current(window))?.kind).toBe('page')
    await expect.poll(() => attachedViews(app)).toEqual([second])

    // C-x k kills the buffer and destroys the page with it.
    await window.keyboard.press('Control+x')
    await window.keyboard.press('k')
    await expect.poll(async () => (await current(window))?.kind).not.toBe('page')
    await expect.poll(() => attachedViews(app)).toEqual([])
    await expect.poll(() => liveContents(app)).not.toContain(second)
    await expect(window.locator('#page')).toBeHidden()
  } finally {
    await app.close()
    await fixtures.close()
    rmSync(scratch, { recursive: true, force: true })
  }
})
