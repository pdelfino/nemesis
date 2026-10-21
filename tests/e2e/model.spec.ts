import { expect, test, type Page } from './_test'
import { launchApp } from './_launch'

/** The transcript's lines, as the DOM shows them. */
function lines(page: Page): Promise<string[]> {
  return page.locator('#transcript .cm-line').allTextContents()
}

/** Types a prompt into the prompt buffer and sends it with C-c C-c. */
async function send(page: Page, text: string): Promise<void> {
  await expect(page.locator('#prompt .cm-content')).toBeFocused()
  await page.keyboard.type(text)
  await page.keyboard.press('Control+c')
  await page.keyboard.press('Control+c')
}

/** Runs a command by name through M-x. */
async function runCommand(page: Page, name: string): Promise<void> {
  await page.keyboard.press('Alt+x')
  await expect(page.locator('#palette-input .cm-content')).toBeFocused()
  await page.keyboard.type(name)
  await expect
    .poll(() =>
      page
        .locator('#palette-candidates li[aria-selected="true"]')
        .evaluate((item) => item.firstChild?.textContent ?? ''),
    )
    .toBe(name)
  await page.keyboard.press('Enter')
}

/** The palette's candidates by label, in order. */
function candidates(page: Page): Promise<string[]> {
  return page
    .locator('#palette-candidates li')
    .evaluateAll((items) => items.map((item) => item.firstChild?.textContent ?? ''))
}

// Model and effort mid-session (#190): set-model lists what the SDK offers,
// set-effort the levels the current model takes, both for this session
// only, and the mode line shows the model and the effort next to the meter.
test('set-model and set-effort switch the running session, and the mode line shows both', async () => {
  const { app } = await launchApp()
  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    const model = page.locator('#session-model')
    await expect(model).toBeHidden()

    await send(page, 'hello')
    await expect.poll(() => lines(page)).toContain('You said: hello')
    await expect(model).toHaveText('claude-mock-1')

    // The mock default takes no max, so the palette does not offer it.
    await runCommand(page, 'set-effort')
    await expect(page.locator('#palette-prompt')).toHaveText('Set effort:')
    await expect.poll(() => candidates(page)).toEqual(['low', 'medium', 'high'])
    await page.keyboard.press('Escape')
    await expect(page.locator('#palette')).toBeHidden()

    await runCommand(page, 'set-model')
    await expect(page.locator('#palette-prompt')).toHaveText('Set model:')
    await expect.poll(() => candidates(page)).toEqual(['Mock One', 'Mock Two'])
    await page.keyboard.type('Mock Two')
    await page.keyboard.press('Enter')
    await expect(model).toHaveText('claude-mock-2')

    await runCommand(page, 'set-effort')
    await expect(page.locator('#palette-prompt')).toHaveText('Set effort:')
    await expect.poll(() => candidates(page)).toContain('max')
    await page.keyboard.type('max')
    await page.keyboard.press('Enter')
    await expect(model).toHaveText('claude-mock-2 · max')
    await expect.poll(() => lines(page)).toContain('Model: claude-mock-2, effort max')
  } finally {
    await app.close()
  }
})
