import { expect, test, type Page } from './_test'
import { launchNemesis } from './_launch'

/**
 * Background sessions (#158): a session without a window on screen, started
 * with a prompt, listed in the agents buffer with a `background` mark. It
 * asks exactly as a shown one: a permission request waits, the notification
 * is raised, and the list says `waits on you`. `open-agent` shows it as an
 * ordinary window; `close-background-session` ends one after a yes.
 */

interface NotificationRecord {
  readonly type: string
  readonly title: string
  readonly body: string
}

function agentLines(page: Page): Promise<string[]> {
  return page.locator('#agents .cm-line').allTextContents()
}

function candidates(page: Page): Promise<string[]> {
  return page
    .locator('#palette-candidates li')
    .evaluateAll((items) => items.map((item) => item.firstChild?.textContent ?? ''))
}

async function runCommand(page: Page, name: string): Promise<void> {
  await page.keyboard.press('Alt+x')
  await page.keyboard.type(name)
  await page.keyboard.press('Enter')
}

test('a background session runs hidden, asks as any other, shows on open-agent, and closes after a yes', async () => {
  const app = await launchNemesis()
  const visibleWindows = (): Promise<number> =>
    app.evaluate(
      ({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((w) => w.isVisible()).length,
    )
  const allWindows = (): Promise<number> =>
    app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)
  const needsYou = async (): Promise<NotificationRecord[]> =>
    (
      await app.evaluate(
        () =>
          (globalThis as { __nemesisNotifications?: NotificationRecord[] })
            .__nemesisNotifications ?? [],
      )
    ).filter((record) => record.type === 'session-needs-you')
  try {
    const first = await app.firstWindow()
    await first.waitForLoadState('domcontentloaded')
    await expect(first.locator('#prompt .cm-content')).toBeFocused()

    // Started with a prompt that asks for Bash: a window opens, hidden.
    const opened = app.waitForEvent('window')
    await runCommand(first, 'new-background-session')
    await expect(first.locator('#palette-prompt')).toHaveText('Background prompt:')
    await first.keyboard.type('tool: Bash')
    await first.keyboard.press('Enter')
    const second = await opened
    await expect.poll(allWindows).toBe(2)
    expect(await visibleWindows()).toBe(1)

    // The agents buffer is shown and lists it as a background session that waits.
    await expect(first.locator('#agents')).toBeVisible()
    await expect
      .poll(async () => (await agentLines(first))[4])
      .toMatch(/^Window 2 \(background\) {2}session \S{8} +waits on you, for \d+s, 1 tool call$/)
    // It asked as any session does: the notification was raised, nothing was answered.
    await expect.poll(needsYou).toHaveLength(1)
    expect(await visibleWindows()).toBe(1)

    // open-agent shows it, an ordinary window from then on, on its pending request.
    await expect(first.locator('#agents .cm-content')).toBeFocused()
    await first.keyboard.press('Enter')
    await expect(first.locator('#palette-prompt')).toHaveText('Open session:')
    await first.keyboard.type('Window 2')
    await first.keyboard.press('Enter')
    await expect.poll(visibleWindows).toBe(2)
    await expect(second.locator('#request')).toBeVisible()
    await expect
      .poll(async () => (await agentLines(first))[4])
      .toMatch(/^Window 2 +session \S{8} +waits on you/)
    await second.bringToFront()
    await expect(second.locator('#request')).toBeFocused()
    await second.keyboard.press('n')
    await expect(second.locator('#request')).toBeHidden()

    // A second background session, which finishes on its own.
    await first.bringToFront()
    await expect(first.locator('#agents .cm-content')).toBeFocused()
    await runCommand(first, 'new-background-session')
    await first.keyboard.type('hello from the background')
    await first.keyboard.press('Enter')
    await expect.poll(allWindows).toBe(3)
    await expect
      .poll(async () => (await agentLines(first))[6])
      .toMatch(
        /^Window 3 \(background\) {2}session \S{8} +finished, after \d+s, 0 tool calls, ≈\$0\.02$/,
      )

    // close-background-session lists the background ones only, and ends one after a yes.
    await runCommand(first, 'close-background-session')
    await expect(first.locator('#palette-prompt')).toHaveText('Close background session:')
    await expect
      .poll(() => candidates(first))
      .toEqual([expect.stringMatching(/^Window 3: session \S{8}$/)])
    await first.keyboard.press('Enter')
    await expect(first.locator('#palette-prompt')).toHaveText(
      /^End the background session session \S{8} in Window 3 and close its window\?$/,
    )
    await first.keyboard.type('End')
    await first.keyboard.press('Enter')
    await expect.poll(allWindows).toBe(2)
    await expect.poll(async () => (await agentLines(first))[0]).toBe('Agents: 2 sessions')
  } finally {
    await app.close()
  }
})
