import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type Page } from './_test'
import { launchApp } from './_launch'

/** The palette's candidates, by name. */
function candidates(page: Page): Promise<string[]> {
  return page
    .locator('#palette-candidates li')
    .evaluateAll((items) => items.map((item) => item.firstChild?.textContent ?? ''))
}

/** The transcript's lines, as the DOM shows them. */
function transcriptLines(page: Page): Promise<string[]> {
  return page.locator('#transcript .cm-line').allTextContents()
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

/** The environment panel's config line (#86). */
async function configLine(page: Page): Promise<string | undefined> {
  await page.keyboard.press('Control+c')
  await page.keyboard.press('Control+e')
  await expect(page.locator('#environment .cm-content')).toBeFocused()
  const lines = await page.locator('#environment .cm-line').allTextContents()
  const heading = lines.indexOf('Nemesis config')
  return heading < 0 ? undefined : lines[heading + 1]
}

const FIRST = `// Erasable TypeScript, no runtime imports (ADR 0006).
const greeting: string = 'hello from init'
nemesis.defineCommand({
  name: 'say-hello',
  doc: 'Says hello from the config.',
  run(): void {
    nemesis.notice(greeting)
  },
})
nemesis.bindKey('C-c h', 'say-hello')
`

const SECOND = `nemesis.defineCommand({
  name: 'say-goodbye',
  doc: 'Says goodbye from the config.',
  run(): void {
    nemesis.notice('goodbye from init')
  },
})
nemesis.bindKey('C-c g', 'say-goodbye')
`

// The config file (#71, ADR 0006): a temp init.ts adds a command that M-x
// finds and a key runs; editing the file and reload-config swaps it for the
// new one; a broken file leaves the last good config live and says where;
// the environment panel lists the file with its status.
test('a config file adds a command; reload-config picks up an edit and survives an error', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nemesis-e2e-config-'))
  const path = join(dir, 'init.ts')
  writeFileSync(path, FIRST)
  const { app } = await launchApp('nemesis-e2e-', [], {}, { NEMESIS_CONFIG_DIR: dir })
  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await expect(page.locator('#prompt .cm-content')).toBeFocused()

    // M-x finds the config's command, with its doc and its key.
    await page.keyboard.press('Alt+x')
    await expect(page.locator('#palette-input .cm-content')).toBeFocused()
    await page.keyboard.type('say-')
    await expect.poll(() => candidates(page)).toEqual(['say-hello'])
    await expect(page.locator('#palette-doc')).toHaveText('Says hello from the config.')
    await expect(page.locator('#palette-candidates li', { hasText: 'say-hello' })).toContainText(
      'C-c h',
    )
    await page.keyboard.press('Enter')
    await expect.poll(() => transcriptLines(page)).toContain('hello from init')
    // The key the file bound runs it too.
    await page.keyboard.press('Control+c')
    await page.keyboard.press('h')
    await expect
      .poll(async () => (await transcriptLines(page)).filter((line) => line === 'hello from init'))
      .toHaveLength(2)

    // The environment panel lists the file as loaded, with what it added.
    expect(await configLine(page)).toBe(`  ${path}: loaded (1 command, 1 binding, 0 settings)`)

    // An edit and reload-config: the old command is gone, the new one is in.
    writeFileSync(path, SECOND)
    await runCommand(page, 'reload-config')
    await expect
      .poll(() => transcriptLines(page))
      .toContain(`Config reloaded from ${path}: 1 command, 1 binding, 0 settings overridden.`)
    await page.keyboard.press('Alt+x')
    await expect(page.locator('#palette-input .cm-content')).toBeFocused()
    await page.keyboard.type('say-')
    await expect.poll(() => candidates(page)).toEqual(['say-goodbye'])
    await page.keyboard.press('Control+g')
    await page.keyboard.press('Control+c')
    await page.keyboard.press('g')
    await expect.poll(() => transcriptLines(page)).toContain('goodbye from init')

    // A broken file: the error with its line in the help buffer, and the
    // last good config still live.
    writeFileSync(path, "nemesis.notice('fine')\nconst fs = require('node:fs')\n")
    await runCommand(page, 'reload-config')
    await expect(page.locator('#help')).toBeVisible()
    await expect
      .poll(() => page.locator('#help .cm-line').allTextContents())
      .toEqual([
        'Config errors',
        '',
        `${path}, line 2, column 12:`,
        '  ReferenceError: require is not defined: a runtime require or import is not available in the config; only `import type` is erased',
        '',
        'Nothing from this load was applied: the previous config, or the defaults, stays live.',
        'Fix the file, then M-x reload-config.',
      ])
    await page.keyboard.press('Alt+x')
    await expect(page.locator('#palette-input .cm-content')).toBeFocused()
    await page.keyboard.type('say-')
    await expect.poll(() => candidates(page)).toEqual(['say-goodbye'])
    await page.keyboard.press('Control+g')
    expect(await configLine(page)).toBe(
      `  ${path}: error at line 2, column 12: ReferenceError: require is not defined: a runtime require or import is not available in the config; only \`import type\` is erased`,
    )
  } finally {
    await app.close()
  }
})

const ON_CREATED = `nemesis.on('buffer-created', {
  name: 'say-created',
  doc: 'Says which buffer was made.',
  run(event: { buffer: { title: string } }): void {
    nemesis.notice('created ' + event.buffer.title)
  },
})
`

// A config hook (#165, ADR 0005): the file's handler on buffer-created runs
// when list-hooks opens the help buffer, list-hooks names it with its
// source, and after reload-config it runs once, not once per load.
test('a config on(buffer-created) handler runs, and after a reload it runs once', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nemesis-e2e-hooks-'))
  const path = join(dir, 'init.ts')
  writeFileSync(path, ON_CREATED)
  const { app } = await launchApp('nemesis-e2e-', [], {}, { NEMESIS_CONFIG_DIR: dir })
  const created = async (page: Page): Promise<number> =>
    (await transcriptLines(page)).filter((line) => line === 'created Help').length
  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await expect(page.locator('#prompt .cm-content')).toBeFocused()

    await runCommand(page, 'list-hooks')
    await expect(page.locator('#help')).toBeVisible()
    await expect
      .poll(() => page.locator('#help .cm-line').allTextContents())
      .toEqual([
        'Hooks',
        '',
        'buffer-created (observer)',
        '  say-created (config): Says which buffer was made.',
      ])
    await expect.poll(() => created(page)).toBe(1)

    await runCommand(page, 'reload-config')
    await expect
      .poll(() => transcriptLines(page))
      .toContain(`Config reloaded from ${path}: 0 commands, 0 bindings, 0 settings overridden.`)
    // The help buffer goes, so the next list-hooks makes it again.
    // C-x k kills the current buffer; kill-buffer from M-x reads which ones (#167).
    await page.keyboard.press('Control+x')
    await page.keyboard.press('k')
    await expect(page.locator('#help')).toBeHidden()
    await runCommand(page, 'list-hooks')
    await expect(page.locator('#help')).toBeVisible()
    await expect.poll(() => created(page)).toBe(2)
    expect(await page.locator('#help .cm-line').allTextContents()).toHaveLength(4)
  } finally {
    await app.close()
  }
})
