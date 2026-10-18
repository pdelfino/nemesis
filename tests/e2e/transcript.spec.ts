import { expect, test, type Page } from '@playwright/test'
import { launchNemesis } from './_launch'

/** The transcript's lines, as the DOM shows them; a folded body is not among them. */
function lines(page: Page): Promise<string[]> {
  return page.locator('#transcript .cm-line').allTextContents()
}

/** Types a prompt and sends it with C-c C-c, then waits for the reply to land. */
async function send(page: Page, text: string, reply: string): Promise<void> {
  await page.keyboard.type(text)
  await page.keyboard.press('Control+c')
  await page.keyboard.press('Control+c')
  await expect(page.locator('#transcript .cm-content')).toContainText(reply)
}

test('the transcript streams replies in place, searches earlier turns, folds and copies plain text', async () => {
  const app = await launchNemesis()
  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await expect(page.locator('#prompt .cm-content')).toBeFocused()

    // The first turn: the user's text, the session note, the reply, in order.
    await send(page, 'alpha one', 'You said: alpha one')
    await expect
      .poll(() => lines(page))
      .toEqual([
        'You',
        'alpha one',
        '',
        'Session started: claude-mock-1, default mode, in ' + (await cwd(app)),
        '',
        'Claude',
        'You said: alpha one',
      ])
    const firstLine = await page.locator('#transcript .cm-line').first().elementHandle()
    if (firstLine === null) throw new Error('The transcript has no first line')

    // The second turn appends: the first line's DOM node is the same one, so
    // the earlier text was not redrawn. Thinking arrives folded.
    await send(page, 'think: beta two', 'You said: think: beta two')
    expect(await firstLine.evaluate((node) => node.isConnected)).toBe(true)
    expect(
      await page
        .locator('#transcript .cm-line')
        .first()
        .evaluate((node, earlier) => node === earlier, firstLine),
    ).toBe(true)
    await expect(page.locator('#transcript .cm-foldPlaceholder')).toHaveCount(1)
    expect(await lines(page)).not.toContain('beta two')
    expect((await lines(page)).some((line) => line.startsWith('Thinking'))).toBe(true)

    // C-x b makes the transcript current and gives it the point; typing into
    // it changes nothing.
    await page.keyboard.press('Control+x')
    await page.keyboard.press('b')
    await expect(page.locator('#transcript .cm-content')).toBeFocused()
    const before = await lines(page)
    await page.keyboard.type('zzz')
    expect(await lines(page)).toEqual(before)

    // C-s opens the search; the match in the earlier turn is selected as the
    // query is typed, before any Enter.
    await page.keyboard.press('Control+s')
    const field = page.locator('#transcript .cm-search input[name="search"]')
    await expect(field).toBeFocused()
    await page.keyboard.type('alpha')
    await expect(page.locator('#transcript .cm-searchMatch-selected')).toHaveText('alpha')
    // C-s again steps to the next match, in the reply.
    await page.keyboard.press('Control+s')
    await expect(page.locator('#transcript .cm-searchMatch-selected')).toHaveText('alpha')
    // C-g closes the panel and the point stays on the match.
    await page.keyboard.press('Control+g')
    await expect(page.locator('#transcript .cm-search')).toHaveCount(0)
    await expect(page.locator('#transcript .cm-content')).toBeFocused()

    // M-w copies the region: C-a, then shift-select two lines down to the end
    // of the line. (C-SPC would set the mark too, but on macOS the synthesized
    // chord is the input-source switch and leaks a stray key.) What lands on
    // the clipboard is the text of those lines and nothing else.
    await page.keyboard.press('Control+a')
    await page.keyboard.press('Shift+ArrowDown')
    await page.keyboard.press('Shift+ArrowDown')
    await page.keyboard.press('Shift+End')
    await page.keyboard.press('Alt+w')
    await expect
      .poll(() => app.evaluate(({ clipboard }) => clipboard.readText()))
      .toBe('You said: alpha one\n\nYou')

    // TAB on the Thinking header unfolds the body, and folds it again.
    await page.keyboard.press('Control+s')
    await page.keyboard.type('Thinking')
    await page.keyboard.press('Escape')
    await expect(page.locator('#transcript .cm-content')).toBeFocused()
    await page.keyboard.press('Tab')
    await expect.poll(() => lines(page)).toContain('beta two')
    await page.keyboard.press('Tab')
    await expect.poll(() => lines(page)).not.toContain('beta two')
  } finally {
    await app.close()
  }
})

function cwd(app: Awaited<ReturnType<typeof launchNemesis>>): Promise<string> {
  return app.evaluate(() => process.cwd())
}
