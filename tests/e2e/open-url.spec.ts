import { expect, test, type Page } from './_test'
import { launchApp } from './_launch'
import { fixtureServer } from './security/_harness'

/**
 * open-url over its sources (#124): the palette reads a URL, a search
 * engine's `kw query` or a refused scheme. A refused scheme is a notice in
 * the transcript and opens nothing; a typed fixture URL opens a page buffer;
 * a keyword search opens the engine's URL in the same page buffer, since the
 * current buffer is a page; open-url-in-new-buffer opens a second one. The
 * engine is a setting, here one on the harness's loopback fixture origin, so
 * no spec reaches the network.
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

/** The buffers as the main process holds them, and the current one. */
function buffers(
  page: Page,
): Promise<{ readonly pages: readonly BufferInfo[]; readonly current: BufferInfo | null }> {
  return page.evaluate(async () => {
    const list = await (globalThis as unknown as TestWindow).nemesis.buffers()
    return {
      pages: list.buffers.filter((buffer) => buffer.kind === 'page'),
      current: list.buffers.find((buffer) => buffer.id === list.currentId) ?? null,
    }
  })
}

/** Runs a command by name at M-x, waiting until it is the highlighted candidate. */
async function run(page: Page, command: string): Promise<void> {
  await page.keyboard.press('Alt+x')
  await expect(page.locator('#palette-input .cm-content')).toBeFocused()
  await page.keyboard.type(command)
  await expect
    .poll(() =>
      page
        .locator('#palette-candidates li[aria-selected="true"]')
        .evaluate((item) => item.firstChild?.textContent ?? ''),
    )
    .toBe(command)
  await page.keyboard.press('Enter')
}

/** Answers the URL read that is open with `text`. */
async function answer(page: Page, prompt: string, text: string): Promise<void> {
  await expect(page.locator('#palette-prompt')).toHaveText(prompt)
  await page.keyboard.type(text)
  await page.keyboard.press('Enter')
  await expect(page.locator('#palette')).toBeHidden()
}

test('open-url opens a typed URL, searches on a keyword, opens a new buffer, refuses a scheme', async () => {
  const fixtures = await fixtureServer()
  const engine = `${fixtures.url('node-probe.html')}?q=%s`
  const { app } = await launchApp('nemesis-open-url-', [], {
    searchEngines: [
      { keyword: 'fx', name: 'Fixture', url: engine },
      { keyword: 'ddg', name: 'DuckDuckGo', url: 'https://duckduckgo.com/?q=%s' },
    ],
  })
  try {
    const window = await app.firstWindow()
    await window.waitForLoadState('domcontentloaded')

    // The engines are candidates, the first doc naming it as the bare word's.
    await run(window, 'open-url')
    await expect(window.locator('#palette-prompt')).toHaveText('Open URL:')
    await expect(window.locator('#palette-candidates li')).toHaveCount(2)
    await expect(window.locator('#palette-candidates li').first()).toContainText('fx')

    // A refused scheme is a notice, naming the scheme only, and opens nothing.
    await window.keyboard.type('file:///etc/hosts')
    await window.keyboard.press('Enter')
    await expect(window.locator('#palette')).toBeHidden()
    await expect
      .poll(() => window.locator('#transcript .cm-line').allTextContents())
      .toContain(
        'Not opened: file: is not a page URL; a page buffer opens http: and https: only (SECURITY.org, T3)',
      )
    expect((await buffers(window)).pages).toHaveLength(0)

    // A typed fixture URL opens in a new page buffer, made current.
    const first = fixtures.url('node-probe.html')
    await run(window, 'open-url')
    await answer(window, 'Open URL:', first)
    await expect
      .poll(async () => (await buffers(window)).current)
      .toMatchObject({ kind: 'page', title: 'node probe', url: first })

    // A keyword search opens the engine's URL, in the same page buffer.
    await run(window, 'open-url')
    await answer(window, 'Open URL:', 'fx hello world')
    const searched = `${fixtures.url('node-probe.html')}?q=hello%20world`
    await expect.poll(async () => (await buffers(window)).current?.url).toBe(searched)
    expect((await buffers(window)).pages).toHaveLength(1)

    // open-url-in-new-buffer opens a second page buffer, made current.
    const second = fixtures.url('window-open.html')
    await run(window, 'open-url-in-new-buffer')
    await answer(window, 'Open URL in new buffer:', second)
    await expect
      .poll(async () => (await buffers(window)).current)
      .toMatchObject({ kind: 'page', title: 'window open', url: second })
    const { pages } = await buffers(window)
    expect(pages.map((page) => page.url)).toEqual([searched, second])
  } finally {
    await app.close()
    await fixtures.close()
  }
})
