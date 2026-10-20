import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type Page } from './_test'
import { launchApp } from './_launch'

/** The transcript's lines, as the DOM shows them. */
function transcriptLines(page: Page): Promise<string[]> {
  return page.locator('#transcript .cm-line').allTextContents()
}

/** Opens a palette read through M-x and runs the command named. */
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

/** Answers a free-text read with `text`. */
async function answer(page: Page, prompt: string, text: string): Promise<void> {
  await expect(page.locator('#palette-prompt')).toHaveText(prompt)
  await expect(page.locator('#palette-input .cm-content')).toBeFocused()
  await page.keyboard.type(text)
  await page.keyboard.press('Enter')
}

const FORM =
  "nemesis.defineCommand({ name: 'say-hi', doc: 'Says hi from eval.', run(): void { nemesis.notice('hi from eval') } })"

// Eval in the config scope (#72): eval-expression defines a command that M-x
// runs at once; the journal beside init.ts has one entry and the mode line
// counts it; journal-promote moves the form into the test's init.ts (the
// config folder of #71); reload-config loads the file and the command is
// still there, now the file's.
test('eval defines a command, the journal keeps it, promote and reload keep the command', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nemesis-e2e-eval-'))
  const init = join(dir, 'init.ts')
  const journal = join(dir, 'journal.org')
  const { app } = await launchApp('nemesis-e2e-', [], {}, { NEMESIS_CONFIG_DIR: dir })
  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await expect(page.locator('#prompt .cm-content')).toBeFocused()
    await expect(page.locator('#journal-count')).toHaveText('')

    // A plain value first: printed, nothing journaled.
    await runCommand(page, 'eval-expression')
    await answer(page, 'Eval:', 'const n: number = 40; n + 2')
    await expect.poll(() => transcriptLines(page)).toContain('=> 42')
    expect(existsSync(journal)).toBe(false)

    // A definition: applied at once and journaled.
    await runCommand(page, 'eval-expression')
    await answer(page, 'Eval:', FORM)
    await expect
      .poll(() => transcriptLines(page))
      .toContain(`Journaled command say-hi as entry 1 of ${journal}: 1 unpromoted.`)
    await expect(page.locator('#journal-count')).toHaveText('journal: 1')
    const entries = readFileSync(journal, 'utf8').match(/^\* \[.*\] command say-hi$/gm)
    expect(entries).toHaveLength(1)
    expect(readFileSync(journal, 'utf8')).toContain(`#+begin_src typescript\n${FORM}\n#+end_src`)
    await runCommand(page, 'say-hi')
    await expect.poll(() => transcriptLines(page)).toContain('hi from eval')

    // Promote: the form moves to init.ts and the count goes blank.
    await runCommand(page, 'journal-promote')
    await expect(page.locator('#palette-prompt')).toHaveText('Promote to init.ts:')
    await expect(page.locator('#palette-candidates li[aria-selected="true"]')).toContainText(
      '1. command say-hi',
    )
    await page.keyboard.press('Enter')
    await expect(page.locator('#journal-count')).toHaveText('')
    await expect.poll(() => (existsSync(init) ? readFileSync(init, 'utf8') : '')).toContain(FORM)
    expect(readFileSync(journal, 'utf8')).not.toContain('say-hi')

    // Reload: the file defines the command now, and it still runs.
    await runCommand(page, 'reload-config')
    await expect
      .poll(() => transcriptLines(page))
      .toContain(`Config reloaded from ${init}: 1 command, 0 bindings, 0 settings overridden.`)
    await runCommand(page, 'say-hi')
    await expect
      .poll(async () => (await transcriptLines(page)).filter((line) => line === 'hi from eval'))
      .toHaveLength(2)
  } finally {
    await app.close()
  }
})

// The *repl* buffer (#72): RET reads a form, and the form and its value are
// shown there.
test('the *repl* buffer evaluates a form on RET', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nemesis-e2e-repl-'))
  const { app } = await launchApp('nemesis-e2e-', [], {}, { NEMESIS_CONFIG_DIR: dir })
  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await expect(page.locator('#prompt .cm-content')).toBeFocused()
    await runCommand(page, 'repl')
    await expect(page.locator('#repl')).toBeVisible()
    await expect(page.locator('#repl .cm-content')).toBeFocused()
    await page.keyboard.press('Enter')
    await answer(page, 'Eval:', 'nemesis.buffers.list().length')
    await expect
      .poll(() => page.locator('#repl .cm-line').allTextContents())
      .toEqual(['> nemesis.buffers.list().length', '=> 3'])
  } finally {
    await app.close()
  }
})

// load-file (#182): a .ts file read off the palette is evaluated as eval
// evaluates a form; the command it defines runs from M-x, and what it
// defined is journaled like a form.
test('load-file evaluates a file that defines a command, which then runs', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nemesis-e2e-load-'))
  const file = join(dir, 'greet.ts')
  writeFileSync(
    file,
    [
      "const greeting: string = 'hi from a loaded file'",
      "nemesis.defineCommand({ name: 'say-loaded', doc: 'Says hi from load-file.', run(): void { nemesis.notice(greeting) } })",
      "'loaded'",
      '',
    ].join('\n'),
  )
  const { app } = await launchApp('nemesis-e2e-', [], {}, { NEMESIS_CONFIG_DIR: dir })
  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await expect(page.locator('#prompt .cm-content')).toBeFocused()

    await runCommand(page, 'load-file')
    await answer(page, 'Load file:', file)
    await expect.poll(() => transcriptLines(page)).toContain(`Loading ${file}`)
    await expect.poll(() => transcriptLines(page)).toContain('=> "loaded"')
    await expect
      .poll(() => transcriptLines(page))
      .toContain(
        `Journaled command say-loaded as entry 1 of ${join(dir, 'journal.org')}: 1 unpromoted.`,
      )
    await runCommand(page, 'say-loaded')
    await expect.poll(() => transcriptLines(page)).toContain('hi from a loaded file')

    // Only a .ts or .js file is loaded.
    const notes = join(dir, 'notes.org')
    writeFileSync(notes, '* not code\n')
    await runCommand(page, 'load-file')
    await answer(page, 'Load file:', notes)
    await expect
      .poll(() => transcriptLines(page))
      .toContain(`Not loaded: ${notes} is not a .ts or .js file`)
  } finally {
    await app.close()
  }
})
