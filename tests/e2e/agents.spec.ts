import { expect, test, type Page } from './_test'
import { launchNemesis } from './_launch'

/**
 * The agents buffer (#157): every window's session on one screen. Two
 * windows; a turn in the second that waits on a permission answer; the
 * first window's `C-x 5 a` lists both with their states, the list follows
 * the answer, and `RET` brings the second window forward on its prompt.
 */

/** The agents buffer's lines, as the DOM shows them. */
function agentLines(page: Page): Promise<string[]> {
  return page.locator('#agents .cm-line').allTextContents()
}

/** The candidates the palette lists. */
function candidates(page: Page): Promise<string[]> {
  return page
    .locator('#palette-candidates li')
    .evaluateAll((items) => items.map((item) => item.firstChild?.textContent ?? ''))
}

/** Types a prompt into the prompt buffer and sends it with C-c C-c. */
async function send(page: Page, text: string): Promise<void> {
  await expect(page.locator('#prompt .cm-content')).toBeFocused()
  await page.keyboard.type(text)
  await page.keyboard.press('Control+c')
  await page.keyboard.press('Control+c')
}

async function chord(page: Page, ...keys: string[]): Promise<void> {
  for (const key of keys) await page.keyboard.press(key)
}

test("C-x 5 a lists every window's session with its state, follows it, and RET opens one", async () => {
  const app = await launchNemesis()
  try {
    const first = await app.firstWindow()
    await first.waitForLoadState('domcontentloaded')
    await expect(first.locator('#prompt .cm-content')).toBeFocused()

    const opened = app.waitForEvent('window')
    await chord(first, 'Control+x', '5', '2')
    const second = await opened
    await second.waitForLoadState('domcontentloaded')
    await second.bringToFront()

    // The second window's session asks before running Bash, and waits.
    await send(second, 'tool: Bash')
    await expect(second.locator('#request')).toBeVisible()

    // The first window lists both sessions; the second waits on the user.
    await first.bringToFront()
    await chord(first, 'Control+x', '5', 'a')
    await expect(first.locator('#agents')).toBeVisible()
    await expect(first.locator('#buffer-list')).toContainText('[Agents]')
    await expect(first.locator('#agents-keys')).toHaveText(
      'RET picks a session and brings its window forward',
    )
    await expect
      .poll(() => agentLines(first))
      .toEqual([
        'Agents: 2 sessions, 1 waits on you',
        '',
        expect.stringMatching(/^Window 1 \(here\) {2}Nemesis +idle$/),
        expect.stringMatching(/^ +\S/),
        expect.stringMatching(/^Window 2 {9}session \S{8} +waits on you, for \d+s, 1 tool call$/),
        expect.stringMatching(/^ +\S/),
        '',
      ])
    // Nothing of the conversation is in the list.
    expect((await agentLines(first)).join('\n')).not.toContain('Bash')

    // Answered in the second window, the turn ends and the list follows.
    await second.bringToFront()
    await expect(second.locator('#request')).toBeFocused()
    await second.keyboard.press('n')
    await first.bringToFront()
    await expect
      .poll(async () => (await agentLines(first))[4])
      .toMatch(/^Window 2 {9}session \S{8} +finished, after \d+s, 1 tool call$/)
    await expect.poll(async () => (await agentLines(first))[0]).toBe('Agents: 2 sessions')

    // RET asks which session, and the pick brings that window forward on its prompt.
    await expect(first.locator('#agents .cm-content')).toBeFocused()
    await first.keyboard.press('Enter')
    await expect(first.locator('#palette-prompt')).toHaveText('Open session:')
    await expect
      .poll(() => candidates(first))
      .toEqual(['Window 1: Nemesis', expect.stringMatching(/^Window 2: session \S{8}$/)])
    await first.keyboard.type('Window 2')
    await first.keyboard.press('Enter')
    await expect(first.locator('#palette')).toBeHidden()
    await expect
      .poll(() =>
        second.evaluate(() =>
          (globalThis as unknown as { document: { hasFocus(): boolean } }).document.hasFocus(),
        ),
      )
      .toBe(true)
    await expect(second.locator('#prompt .cm-content')).toBeFocused()
    await expect(second.locator('#buffer-list')).toContainText('[Prompt]')
  } finally {
    await app.close()
  }
})
