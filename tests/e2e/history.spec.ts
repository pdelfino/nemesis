import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Page } from './_test'
import { launchApp } from './_launch'
import { fixtureServer } from './security/_harness'

/**
 * History and bookmarks (#125): two fixture pages visited in a persistent
 * page buffer are both in the history, a page in the ephemeral partition is
 * not and cannot be bookmarked; a page kept with `bookmark-page` is found by
 * its tag in `open-bookmark`, and `export-bookmarks` writes the Org file in
 * the sessions folder. The profile's database is closed at quit and read
 * again by the next launch on the same profile.
 */

interface BufferInfo {
  readonly id: string
  readonly kind: string
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

/** The test-only page door of src/main/index.ts, with the partition argument. */
interface PageDoor {
  open(
    url: string,
    partition?: 'persistent' | 'ephemeral',
  ): Promise<{ readonly loadError: string | null }>
}

/** The current buffer as the main process holds it. */
function current(page: Page): Promise<BufferInfo | null> {
  return page.evaluate(async () => {
    const list = await (globalThis as unknown as TestWindow).nemesis.buffers()
    return list.buffers.find((buffer) => buffer.id === list.currentId) ?? null
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

/** Answers the read that is open with `text`. */
async function answer(page: Page, prompt: string, text: string): Promise<void> {
  await expect(page.locator('#palette-prompt')).toHaveText(prompt)
  await page.keyboard.type(text)
  await page.keyboard.press('Enter')
  await expect(page.locator('#palette')).toBeHidden()
}

const help = (page: Page) => page.locator('#help-editor .cm-content')

test('history records persistent pages only, and a bookmark is found by its tag', async () => {
  const fixtures = await fixtureServer()
  const first = fixtures.url('node-probe.html')
  const second = fixtures.url('window-open.html')
  const hidden = fixtures.url('navigation.html')
  const launched = await launchApp('nemesis-history-')
  const { userData, sessionsDir } = launched
  try {
    const window = await launched.app.firstWindow()
    await window.waitForLoadState('domcontentloaded')

    // Two fixture pages in one persistent page buffer.
    await run(window, 'open-url')
    await answer(window, 'Open URL:', first)
    await expect.poll(async () => (await current(window))?.url).toBe(first)
    await run(window, 'open-url')
    await answer(window, 'Open URL:', second)
    await expect.poll(async () => (await current(window))?.url).toBe(second)

    // One page in the ephemeral partition, loaded to the end.
    const opened = await launched.app.evaluate(
      (_electron, url) =>
        (globalThis as unknown as { __nemesisPages: PageDoor }).__nemesisPages.open(
          url,
          'ephemeral',
        ),
      hidden,
    )
    expect(opened.loadError).toBeNull()
    await expect.poll(async () => (await current(window))?.url).toBe(hidden)

    // An ephemeral page is not bookmarked either.
    await run(window, 'bookmark-page')
    await expect(help(window)).toContainText('Not bookmarked: an ephemeral page')

    // Both persistent visits are in the history, the ephemeral page is not.
    await run(window, 'show-history')
    await expect(help(window)).toContainText(first)
    await expect(help(window)).toContainText(second)
    expect(await help(window).textContent()).not.toContain('navigation.html')

    // open-from-history lists both, the last visited first.
    await run(window, 'open-from-history')
    await expect(window.locator('#palette-prompt')).toHaveText('Open from history:')
    await expect(window.locator('#palette-candidates li')).toHaveCount(2)
    await expect(window.locator('#palette-candidates li').first()).toContainText(second)
    // Choosing one opens it in the current page buffer.
    await window.keyboard.press('Enter')
    await expect(window.locator('#palette')).toBeHidden()
    await expect.poll(async () => (await current(window))?.url).toBe(second)

    // A fresh persistent page to bookmark, with two tags.
    await run(window, 'open-url-in-new-buffer')
    await answer(window, 'Open URL in new buffer:', first)
    await expect.poll(async () => (await current(window))?.url).toBe(first)
    await run(window, 'bookmark-page')
    await answer(window, 'Bookmark tags:', 'fixture probe')

    // Found by its tag.
    await run(window, 'open-bookmark')
    await expect(window.locator('#palette-prompt')).toHaveText('Open bookmark:')
    await window.keyboard.type(':probe:')
    await expect(window.locator('#palette-candidates li')).toHaveCount(1)
    await expect(window.locator('#palette-candidates li').first()).toContainText(first)
    await window.keyboard.press('Control+g')
    await expect(window.locator('#palette')).toBeHidden()

    await run(window, 'show-bookmarks')
    await expect(help(window)).toContainText(':fixture:probe:')

    // The export is an Org file in the sessions folder.
    await run(window, 'export-bookmarks')
    const exported = join(sessionsDir, 'bookmarks.org')
    await expect(help(window)).toContainText(exported)
    expect(readFileSync(exported, 'utf8')).toContain(`* [[${first}][node probe]] :fixture:probe:`)
  } finally {
    await launched.app.close()
  }

  // The database was closed at quit; the next launch on the profile reads it.
  expect(existsSync(join(userData, 'nemesis.sqlite'))).toBe(true)
  const again = await launchApp('nemesis-history-', [], {}, {}, undefined, userData)
  try {
    const window = await again.app.firstWindow()
    await window.waitForLoadState('domcontentloaded')
    await run(window, 'show-history')
    await expect(help(window)).toContainText(second)
    expect(await help(window).textContent()).not.toContain('navigation.html')
    await run(window, 'show-bookmarks')
    await expect(help(window)).toContainText(':fixture:probe:')
  } finally {
    await again.app.close()
    await fixtures.close()
  }
})
