import type { ElectronApplication } from '@playwright/test'
import { expect, test, type Page } from './_test'
import { launchNemesis } from './_launch'
import { fixtureServer } from './security/_harness'

/**
 * Keys in a page buffer (#120): the cockpit's keymap is asked first, by a
 * `before-input-event` listener in the main process, for the page buffer
 * type and the page's modes. A chord the cockpit binds never reaches the
 * page, an unbound key does, `C-g` reaches the cockpit in `document` mode,
 * `C-z` puts the page in `passthrough` (shown in the mode line) where every
 * key but `C-z` is the page's, and the zoom keys zoom the origin with the
 * factor in the mode line. The fixture records every keydown it sees, and
 * the keys are typed through `sendInputEvent`, the path a real key takes.
 *
 * Focus is pinned by tests/unit/page-buffer.test.ts: a window under test
 * never holds the system's focus, so `isFocused()` cannot see it here.
 */

interface DispatchedKey {
  readonly chord: string
  readonly command: string
}

interface TestWindow {
  readonly nemesis: {
    readonly dispatchLog?: () => Promise<readonly DispatchedKey[]>
  }
}

/** The commands the main process dispatched, through the test-only door (#59). */
async function dispatched(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const log = (await (globalThis as unknown as TestWindow).nemesis.dispatchLog?.()) ?? []
    return log.map((record) => `${record.chord} ${record.command}`)
  })
}

/** The kind of the current buffer, as the main process holds it. */
function currentKind(page: Page): Promise<string | undefined> {
  return page.evaluate(async () => {
    const nemesis = (
      globalThis as unknown as {
        nemesis: {
          buffers: () => Promise<{
            buffers: readonly { id: string; kind: string }[]
            currentId: string | null
          }>
        }
      }
    ).nemesis
    const list = await nemesis.buffers()
    return list.buffers.find((buffer) => buffer.id === list.currentId)?.kind
  })
}

/**
 * Types one key into the page the way the system does, through the main
 * process: Playwright's own keys enter below `before-input-event`, which is
 * the listener under test, so they would never be asked about.
 */
async function type(
  app: ElectronApplication,
  url: string,
  keyCode: string,
  modifiers: readonly ('control' | 'alt' | 'shift')[] = [],
): Promise<void> {
  await app.evaluate(
    ({ webContents }, { url, keyCode, modifiers }) => {
      const page = webContents.getAllWebContents().find((one) => one.getURL() === url)
      if (page === undefined) throw new Error('no page contents')
      page.sendInputEvent({ type: 'keyDown', keyCode, modifiers: [...modifiers] })
      page.sendInputEvent({ type: 'keyUp', keyCode, modifiers: [...modifiers] })
    },
    { url, keyCode, modifiers },
  )
}

/** The keys the fixture page saw. */
function recorded(view: Page): Promise<string[]> {
  return view.evaluate(() => [...((globalThis as { __keys?: string[] }).__keys ?? [])])
}

test('a bound chord stays the cockpit, an unbound key reaches the page, C-z passes through', async () => {
  const fixtures = await fixtureServer()
  const app = await launchNemesis()
  try {
    const window = await app.firstWindow()
    await window.waitForLoadState('domcontentloaded')
    const url = fixtures.url('key-recorder.html')

    // C-x C-f is the transcript's and the page's; the prompt buffer starts current.
    await window.keyboard.press('Control+x')
    await window.keyboard.press('b')
    await expect.poll(() => currentKind(window)).toBe('transcript')
    // The renderer reads the buffer type off its focused section, which follows the switch.
    await expect(window.locator('#transcript:focus-within')).toHaveCount(1)
    await window.keyboard.press('Control+x')
    await window.keyboard.press('Control+f')
    await expect(window.locator('#palette-prompt')).toHaveText('Open URL:')
    await window.keyboard.type(url)
    await window.keyboard.press('Enter')
    await expect.poll(() => app.windows().map((one) => one.url())).toContain(url)
    const view = app.windows().find((one) => one.url() === url)
    if (view === undefined) throw new Error('no page view')
    await expect(view).toHaveTitle('key recorder')

    // An unbound key is the page's; a bound chord and C-g are the cockpit's.
    await type(app, url, 'a')
    await type(app, url, 'v', ['control'])
    await type(app, url, 'g', ['control'])
    await type(app, url, 'q')
    await expect.poll(() => recorded(view)).toEqual(['a', 'q'])
    await expect
      .poll(() => dispatched(window))
      .toEqual(expect.arrayContaining(['C-v scroll-page-down', 'C-g keyboard-quit']))
    // C-v scrolled the page, through Chromium and no script of the cockpit's.
    await expect
      .poll(() => view.evaluate(() => (globalThis as unknown as { scrollY: number }).scrollY))
      .toBeGreaterThan(0)

    // C-z: passthrough, in the mode line; every key but C-z reaches the page.
    await type(app, url, 'z', ['control'])
    await expect(window.locator('#modeline #page-state')).toHaveText('passthrough')
    await type(app, url, 'v', ['control'])
    await type(app, url, 'g', ['control'])
    await type(app, url, 'g')
    await expect.poll(() => recorded(view)).toEqual(['a', 'q', 'C-v', 'C-g', 'g'])
    await type(app, url, 'z', ['control'])
    await expect(window.locator('#modeline #page-state')).toHaveText('')
    await type(app, url, 'v', ['control'])
    await type(app, url, 'b')
    await expect.poll(() => recorded(view)).toEqual(['a', 'q', 'C-v', 'C-g', 'g', 'b'])

    // Zoom per origin, with the factor in the mode line while it is not 100.
    await type(app, url, 'Plus', ['control'])
    await expect(window.locator('#modeline #page-state')).toHaveText('110%')
    await type(app, url, '-', ['control'])
    await expect(window.locator('#modeline #page-state')).toHaveText('')
    expect(await recorded(view)).toEqual(['a', 'q', 'C-v', 'C-g', 'g', 'b'])

    // A cockpit chord typed in the page: M-x opens the palette, which takes the keyboard.
    await type(app, url, 'x', ['alt'])
    await expect(window.locator('#palette')).toBeVisible()
    await window.keyboard.press('Control+g')
    await expect(window.locator('#palette')).toBeHidden()
    expect(await recorded(view)).toEqual(['a', 'q', 'C-v', 'C-g', 'g', 'b'])
  } finally {
    await app.close()
    await fixtures.close()
  }
})
