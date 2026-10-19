import { expect, test, type Page } from './_test'
import { launchNemesis } from './_launch'

/** The candidates the palette lists, highlighted one marked. */
function candidates(page: Page): Promise<string[]> {
  return page
    .locator('#palette-candidates li')
    .evaluateAll((items) =>
      items.map(
        (item) =>
          `${item.firstChild?.textContent ?? ''}${item.getAttribute('aria-selected') === 'true' ? ' *' : ''}`,
      ),
    )
}

/** The help buffer's lines, as the DOM shows them. */
function helpLines(page: Page): Promise<string[]> {
  return page.locator('#help .cm-line').allTextContents()
}

test('M-x reads a command, describe-command and describe-key answer in a help buffer, C-g cancels', async () => {
  const app = await launchNemesis()
  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    const prompt = page.locator('#prompt .cm-content')
    const palette = page.locator('#palette')
    const query = page.locator('#palette-input .cm-content')
    const doc = page.locator('#palette-doc')
    const modeline = page.locator('#buffer-list')
    await expect(prompt).toBeFocused()

    // M-x: the prompt buffer in command mode, every command listed with its
    // keys, the doc line of the highlighted one shown.
    await page.keyboard.press('Alt+x')
    await expect(palette).toBeVisible()
    await expect(query).toBeFocused()
    await expect(page.locator('#prompt')).toBeHidden()
    await expect(page.locator('#palette-prompt')).toHaveText('M-x')
    // The palette shows the first forty; the tail of a longer list is
    // reached by typing, so the chord is checked on a command inside them.
    expect(await candidates(page)).toContain('describe-command')
    expect(await candidates(page)).toContain('compact')
    await expect(page.locator('#palette-candidates li', { hasText: 'compact' })).toContainText(
      'C-c C-k',
    )
    await expect(doc).toHaveText('Allow the pending tool now and for the rest of the session.')

    // The query narrows the list; the highlight and its doc follow.
    await page.keyboard.type('desc')
    await expect.poll(() => candidates(page)).toEqual(['describe-command *', 'describe-key'])
    await expect(doc).toHaveText('Show what a command does and the keys that run it.')
    await page.keyboard.press('Control+n')
    await expect.poll(() => candidates(page)).toEqual(['describe-command', 'describe-key *'])
    await expect(doc).toHaveText('Show what the next key sequence runs.')
    await page.keyboard.press('Control+p')
    await expect.poll(() => candidates(page)).toEqual(['describe-command *', 'describe-key'])

    // RET runs describe-command, which reads a command the same way.
    await page.keyboard.press('Enter')
    await expect(page.locator('#palette-prompt')).toHaveText('Describe command:')
    await expect(query).toBeFocused()
    await expect(query).toHaveText('')
    await page.keyboard.type('describe-command')
    await page.keyboard.press('Enter')

    // The help buffer shows its own doc and binding, and has the point.
    await expect(palette).toBeHidden()
    await expect(page.locator('#help')).toBeVisible()
    await expect(modeline).toHaveText('Transcript Prompt [Help]')
    await expect(page.locator('#help .cm-content')).toBeFocused()
    await expect
      .poll(() => helpLines(page))
      .toEqual([
        'describe-command',
        'Show what a command does and the keys that run it.',
        'It is bound to C-h x.',
      ])

    // C-h k reads the next sequence instead of running it: C-x b is
    // described, the buffer does not switch, the one help buffer is reused.
    await page.keyboard.press('Control+h')
    await page.keyboard.press('k')
    await page.keyboard.press('Control+x')
    await page.keyboard.press('b')
    await expect
      .poll(() => helpLines(page))
      .toEqual(['C-x b runs switch-buffer in a help buffer.', 'Switch to the next buffer.'])
    await expect(modeline).toHaveText('Transcript Prompt [Help]')

    // C-x k kills the help buffer; the section goes with it.
    await page.keyboard.press('Control+x')
    await page.keyboard.press('k')
    await expect(page.locator('#help')).toBeHidden()
    await expect(modeline).toHaveText('[Transcript] Prompt')

    // The buffers source: choose-buffer from M-x, pick the prompt by a few letters.
    await page.keyboard.press('Alt+x')
    await page.keyboard.type('choose')
    await page.keyboard.press('Enter')
    await expect(page.locator('#palette-prompt')).toHaveText('Switch to buffer:')
    await expect.poll(() => candidates(page)).toEqual(['Transcript *', 'Prompt'])
    await expect(doc).toHaveText('transcript buffer, current')
    await page.keyboard.type('pro')
    await expect.poll(() => candidates(page)).toEqual(['Prompt *'])
    await page.keyboard.press('Enter')
    await expect(modeline).toHaveText('Transcript [Prompt]')
    await expect(prompt).toBeFocused()

    // C-g cancels: the palette closes, the draft under it is untouched and
    // the point is back in the prompt.
    await page.keyboard.type('keep me')
    await page.keyboard.press('Alt+x')
    await page.keyboard.type('kill')
    await expect.poll(() => candidates(page)).toEqual(['kill-buffer *'])
    await page.keyboard.press('Control+g')
    await expect(palette).toBeHidden()
    await expect(prompt).toBeVisible()
    await expect(prompt).toBeFocused()
    await expect(page.locator('#prompt .cm-line')).toHaveText(['keep me'])
    await expect(modeline).toHaveText('Transcript [Prompt]')
    // No match leaves the palette open and says so.
    await page.keyboard.press('Alt+x')
    await page.keyboard.type('zzzz')
    await expect(doc).toHaveText('No match.')
    await page.keyboard.press('Enter')
    await expect(palette).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(palette).toBeHidden()
    await expect(prompt).toBeFocused()
  } finally {
    await app.close()
  }
})
