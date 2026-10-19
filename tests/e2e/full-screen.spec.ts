import type { ElectronApplication } from '@playwright/test'
import { expect, test, type Page } from './_test'
import { launchNemesis } from './_launch'
import { fixtureServer } from './security/_harness'

/**
 * Full-screen (#32): `C-x 5 F` is `toggle-full-screen`. Going in and coming
 * out, the page view is laid out again at the page section's new rectangle,
 * which spans the window's content width, and coming out gives the window
 * its prior frame back. The Space itself is the system's.
 *
 * Full-screen is checked by what holds on any screen: the content area is
 * the display's. An earlier version waited for the content width to change,
 * which never happens when the window already fills its display, as on the
 * GitHub macOS runner's 1024x768 screen (PR #135, 2026-OCTOBER-19); the second
 * test starts from that case on every machine.
 */

interface Rect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

interface Frame {
  readonly fullScreen: boolean
  readonly bounds: Rect
  readonly content: Rect
  readonly views: readonly Rect[]
  /** The bounds of the display the window is on. */
  readonly display: Rect
}

/** The cockpit window's state, frame and content, and the bounds of its page views. */
function frame(app: ElectronApplication): Promise<Frame> {
  return app.evaluate(({ BrowserWindow, screen }) => {
    const window = BrowserWindow.getAllWindows()[0]
    if (window === undefined) throw new Error('no cockpit window')
    return {
      fullScreen: window.isFullScreen(),
      bounds: window.getBounds(),
      content: window.getContentBounds(),
      views: window.contentView.children.flatMap((child) =>
        'webContents' in child ? [child.getBounds()] : [],
      ),
      display: screen.getDisplayMatching(window.getBounds()).bounds,
    }
  })
}

/** The page section's box in the cockpit, rounded as the view's integer bounds are. */
function section(page: Page): Promise<Rect> {
  return page.evaluate(() => {
    const box = (
      globalThis as unknown as {
        document: { getElementById(id: string): { getBoundingClientRect(): Rect } }
      }
    ).document
      .getElementById('page')
      .getBoundingClientRect()
    return {
      x: Math.round(box.x),
      y: Math.round(box.y),
      width: Math.round(box.width),
      height: Math.round(box.height),
    }
  })
}

/** The one page view sits on the page section, and the section spans the content width. */
async function expectLaidOut(app: ElectronApplication, window: Page): Promise<void> {
  await expect
    .poll(async () => {
      const now = await frame(app)
      const box = await section(window)
      return (
        now.views.length === 1 &&
        JSON.stringify(now.views[0]) === JSON.stringify(box) &&
        box.width === now.content.width &&
        box.y + box.height <= now.content.height
      )
    })
    .toBe(true)
}

/** Opens a page buffer, toggles full-screen in and out, and checks the layout each way. */
async function fullScreenRoundTrip(fillDisplay: boolean): Promise<void> {
  const fixtures = await fixtureServer()
  const app = await launchNemesis()
  try {
    const window = await app.firstWindow()
    await window.waitForLoadState('domcontentloaded')

    // From the transcript buffer, as page.spec.ts opens one.
    await window.keyboard.press('Control+x')
    await window.keyboard.press('b')
    await expect(window.locator('#transcript')).toBeVisible()
    await window.keyboard.press('Control+x')
    await window.keyboard.press('Control+f')
    await expect(window.locator('#palette-prompt')).toHaveText('Open URL:')
    await window.keyboard.type(fixtures.url('node-probe.html'))
    await window.keyboard.press('Enter')
    await expect(window.locator('#page')).toBeVisible()
    if (fillDisplay) {
      // The runner's case: the window already as large as its display.
      await app.evaluate(({ BrowserWindow, screen }) => {
        const one = BrowserWindow.getAllWindows()[0]
        if (one !== undefined) one.setBounds(screen.getDisplayMatching(one.getBounds()).bounds)
      })
    }
    await expectLaidOut(app, window)
    const before = await frame(app)
    expect(before.fullScreen).toBe(false)

    // The page has the keyboard; the cockpit's own keys still reach the cockpit.
    await window.keyboard.press('Control+x')
    await window.keyboard.press('5')
    await window.keyboard.press('Shift+F')
    await expect.poll(async () => (await frame(app)).fullScreen, { timeout: 15_000 }).toBe(true)
    // In full-screen the content area is the display, whatever its size.
    await expect
      .poll(
        async () => {
          const now = await frame(app)
          return (
            now.content.width === now.display.width && now.content.height === now.display.height
          )
        },
        { timeout: 15_000 },
      )
      .toBe(true)
    await expectLaidOut(app, window)

    // By name too, and the window comes back to the frame it had.
    await window.keyboard.press('Alt+x')
    await expect(window.locator('#palette')).toBeVisible()
    await window.keyboard.type('toggle-full-screen')
    await window.keyboard.press('Enter')
    await expect(window.locator('#palette')).toBeHidden()
    await expect.poll(async () => (await frame(app)).fullScreen, { timeout: 15_000 }).toBe(false)
    await expect
      .poll(async () => (await frame(app)).bounds, { timeout: 15_000 })
      .toEqual(before.bounds)
    await expectLaidOut(app, window)
    expect((await frame(app)).views).toEqual(before.views)
  } finally {
    await app.close()
    await fixtures.close()
  }
}

test('C-x 5 F toggles full-screen; the page view follows the content area and the frame comes back', async () => {
  await fullScreenRoundTrip(false)
})

test('full-screen from a window that already fills its display, as on the GitHub runner', async () => {
  await fullScreenRoundTrip(true)
})
