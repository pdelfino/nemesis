import { expect, test, type Page } from './_test'
import { launchNemesis } from './_launch'

/** The transcript's lines, as the DOM shows them. */
function transcriptLines(page: Page): Promise<string[]> {
  return page.locator('#transcript .cm-line').allTextContents()
}

/** The diff buffer's lines: the new text, as the DOM shows it. */
function diffLines(page: Page): Promise<string[]> {
  return page.locator('#diff .cm-line').allTextContents()
}

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
  await expect(page.locator('#palette-prompt')).toHaveText('M-x')
  await page.keyboard.type(name)
  await expect.poll(() => candidates(page)).toEqual([`${name} *`])
  await page.keyboard.press('Enter')
}

test('an Edit call is listed by list-diffs and shown as a unified diff; C-c C-o asks before opening', async () => {
  const app = await launchNemesis()
  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    const prompt = page.locator('#prompt .cm-content')
    const modeline = page.locator('#buffer-list')
    const diff = page.locator('#diff')
    await expect(prompt).toBeFocused()

    // Nothing edited yet: list-diffs says so in the help buffer.
    await runCommand(page, 'list-diffs')
    await expect(page.locator('#help')).toBeVisible()
    await expect(page.locator('#help .cm-line').first()).toHaveText(
      'No diffs yet: the agent has made no Edit or Write call in this session.',
    )
    await page.keyboard.press('Control+x')
    await page.keyboard.press('k')
    await expect(page.locator('#help')).toBeHidden()
    // Killing it leaves the point on the transcript; C-x b brings it back.
    await expect(modeline).toHaveText('[Transcript] Prompt')
    await page.keyboard.press('Control+x')
    await page.keyboard.press('b')
    await expect(prompt).toBeFocused()

    // The mock makes one Edit call, allowed with y; the diff buffer is not
    // opened by itself, the transcript records the call.
    await send(page, 'edit: beta changed')
    await expect(modeline).toHaveText('Transcript Prompt [Permission: Edit]')
    await page.keyboard.press('y')
    await expect(page.locator('#transcript .cm-content')).toContainText('Edited notes.txt.')
    await expect(diff).toBeHidden()
    await expect(modeline).toHaveText('Transcript [Prompt]')

    // list-diffs lists it, numbered, with its size as the doc line; RET opens it.
    await runCommand(page, 'list-diffs')
    await expect(page.locator('#palette-prompt')).toHaveText('Show diff:')
    await expect.poll(() => candidates(page)).toEqual(['1. Edit /mock/notes.txt *'])
    await expect(page.locator('#palette-doc')).toHaveText('Edit: 3 lines replaced by 3')
    await page.keyboard.press('Enter')

    // The diff buffer: the new text as lines, the deleted line in a chunk
    // above its replacement, the point in the buffer.
    await expect(diff).toBeVisible()
    await expect(modeline).toHaveText('Transcript Prompt [Diff 1: notes.txt]')
    await expect(page.locator('#diff .cm-content')).toBeFocused()
    await expect(page.locator('#diff-file')).toHaveText('Edit /mock/notes.txt')
    await expect.poll(() => diffLines(page)).toEqual(['alpha', 'beta changed', 'gamma', ''])
    await expect(page.locator('#diff .cm-deletedChunk')).toHaveCount(1)
    await expect(page.locator('#diff .cm-deletedChunk')).toContainText('beta')
    await expect(page.locator('#diff .cm-deletedChunk')).not.toContainText('alpha')
    await expect(page.locator('#diff .cm-changedLine')).toHaveText('beta changed')
    // No accept or reject: the SDK has already applied the change.
    await expect(page.locator('#diff .cm-chunkButtons')).toHaveCount(0)

    // C-c C-o on a file that is not on disk launches nothing and says why in
    // the transcript; the mock's file never existed.
    await page.keyboard.press('Control+c')
    await page.keyboard.press('Control+o')
    await expect
      .poll(() => transcriptLines(page))
      .toContain('Not opened: /mock/notes.txt is not a file on disk')
    await expect(page.locator('#palette')).toBeHidden()

    // The same diff opened again reuses its buffer; C-x k kills it and the
    // section goes with it.
    await page.keyboard.press('Control+x')
    await page.keyboard.press('b')
    await expect(modeline).toHaveText('[Transcript] Prompt Diff 1: notes.txt')
    await runCommand(page, 'list-diffs')
    await page.keyboard.press('Enter')
    await expect(modeline).toHaveText('Transcript Prompt [Diff 1: notes.txt]')
    await expect(page.locator('#diff .cm-content')).toBeFocused()
    await page.keyboard.press('Control+x')
    await page.keyboard.press('k')
    await expect(diff).toBeHidden()
    await expect(modeline).toHaveText('[Transcript] Prompt')
  } finally {
    await app.close()
  }
})
