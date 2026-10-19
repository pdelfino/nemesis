import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ElectronApplication } from '@playwright/test'
import { expect, test, type Page } from './_test'
import { launchApp } from './_launch'
import { fixtureServer } from './security/_harness'

interface AgentEvent {
  readonly type: string
  readonly text?: string
}

interface ReceivedBlock {
  readonly type: string
  readonly text?: string
  readonly mediaType?: string
  readonly bytes?: number
}

interface TestWindow {
  __agentEvents?: AgentEvent[]
  readonly nemesis: {
    readonly onAgentEvent: (listener: (event: AgentEvent) => void) => void
    readonly promptState: () => Promise<{ draft: string }>
  }
}

/** The editor's lines, as the DOM shows them. */
function promptLines(page: Page): Promise<string[]> {
  return page.locator('#prompt .cm-line').allTextContents()
}

/** The transcript's lines, as the DOM shows them. */
function transcriptLines(page: Page): Promise<string[]> {
  return page.locator('#transcript .cm-line').allTextContents()
}

/** The palette's candidates in order, the highlighted one starred. */
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

/** The events a session folder's log holds, in order. */
function eventsIn(sessionsDir: string, id: string): AgentEvent[] {
  const log = join(sessionsDir, id, 'events.jsonl')
  if (!existsSync(log)) return []
  return readFileSync(log, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as AgentEvent)
}

/** What the mock SDK saw of every user message, read off the main process. */
function received(app: ElectronApplication): Promise<{ blocks: ReceivedBlock[] }[]> {
  return app.evaluate(
    () =>
      (globalThis as { __nemesisMockReceived?: { blocks: ReceivedBlock[] }[] })
        .__nemesisMockReceived ?? [],
  )
}

// The guide's specific, rich prompts as affordances (#83): `@` at the start
// of a word lists the files git knows and puts the pick at the point, and
// stays text inside a word; C-c C-i takes the image on the clipboard for the
// next prompt, a marker in the text, the bytes in the message the SDK gets
// and nowhere on disk; C-c C-u fetches an https page as text into the
// prompt, wrapped as untrusted content from its origin, and refuses http;
// the two templates drop in to be filled.
test('@ mentions a file at the point, an attached image reaches the SDK as a block, fetch-url wraps a page as untrusted content, the templates fill the prompt', async () => {
  const fixtures = await fixtureServer()
  const scratch = mkdtempSync(join(tmpdir(), 'nemesis-rich-'))
  const certificate = join(scratch, 'fixtures-ca.pem')
  writeFileSync(certificate, fixtures.certificate)
  const clipboardImage = join(scratch, 'clipboard.png')
  const { app, sessionsDir } = await launchApp(
    'nemesis-e2e-',
    [],
    {},
    // The fixture server's certificate is trusted on purpose, for Node's
    // fetch in the main process; the clipboard is a PNG file under test.
    { NODE_EXTRA_CA_CERTS: certificate, NEMESIS_CLIPBOARD_IMAGE: clipboardImage },
  )
  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    const prompt = page.locator('#prompt .cm-content')
    const palette = page.locator('#palette')
    const note = page.locator('#prompt-note')
    await expect(prompt).toBeFocused()
    await page.evaluate(() => {
      const w = globalThis as unknown as TestWindow
      w.__agentEvents = []
      w.nemesis.onAgentEvent((event) => w.__agentEvents?.push(event))
    })

    // `@` at the start of the prompt: the palette lists the repository's
    // files (this checkout is the working directory), the `@` is typed, the
    // pick lands after it with a space, and the point is back in the prompt.
    await page.keyboard.type('Read ')
    await page.keyboard.type('@')
    await expect(palette).toBeVisible()
    await expect(page.locator('#palette-prompt')).toHaveText('Mention file:')
    // The palette shows the first forty in git's order; a root file near the
    // top stands for the listing, and package.json is reached by typing.
    await expect.poll(() => candidates(page)).toContain('CLAUDE.md')
    await expect.poll(() => promptLines(page)).toEqual(['Read @'])
    await page.keyboard.type('package.json')
    // The exact name ranks first; a fuzzy neighbour such as the lock file follows it.
    await expect.poll(async () => (await candidates(page))[0]).toBe('package.json *')
    await page.keyboard.press('Enter')
    await expect(palette).toBeHidden()
    await expect(prompt).toBeFocused()
    await expect.poll(() => promptLines(page)).toEqual(['Read @package.json '])
    await expect(note).toHaveText('Added to the prompt.')

    // Inside a word `@` is text: an address stays one and no palette opens.
    await page.keyboard.type('and mail p@example.org')
    await expect
      .poll(() => promptLines(page))
      .toEqual(['Read @package.json and mail p@example.org'])
    await expect(palette).toBeHidden()

    // A mention at the point in the middle of the text, not at the end.
    await page.keyboard.press('Control+a')
    await page.keyboard.type('@')
    await expect(palette).toBeVisible()
    await page.keyboard.type('README.org')
    await expect.poll(async () => (await candidates(page))[0]).toBe('README.org *')
    await page.keyboard.press('Enter')
    await expect
      .poll(() => promptLines(page))
      .toEqual(['@README.org Read @package.json and mail p@example.org'])

    // C-g clears the prompt for the next part.
    await page.keyboard.press('Control+g')
    await expect.poll(() => promptLines(page)).toEqual([''])

    // C-c C-i with nothing on the clipboard: the help buffer says so.
    await page.keyboard.press('Control+c')
    await page.keyboard.press('Control+i')
    await expect(page.locator('#help')).toBeVisible()
    await expect(page.locator('#help .cm-content')).toContainText('No image on the clipboard.')
    await page.keyboard.press('Control+x')
    await page.keyboard.press('k')
    await expect(page.locator('#buffer-list')).toHaveText('[Transcript] Prompt')
    await page.keyboard.press('Control+x')
    await page.keyboard.press('b')
    await expect(prompt).toBeFocused()

    // An image on the clipboard: the marker line lands in the prompt with the
    // size, the send carries the PNG as an image block next to the text, and
    // neither the transcript nor the session folder holds the bytes.
    await page.screenshot({ path: clipboardImage })
    await page.keyboard.type('Compare this window with the mock.')
    await page.keyboard.press('Control+c')
    await page.keyboard.press('Control+i')
    await expect
      .poll(() => promptLines(page))
      .toEqual([
        'Compare this window with the mock.',
        '',
        expect.stringMatching(/^\[image 1: \d+x\d+ png, \d+ KB\]$/),
      ])
    const marker = (await promptLines(page))[2] ?? ''
    await page.keyboard.press('Control+c')
    await page.keyboard.press('Control+c')
    await expect(note).toHaveText('Sent.')
    await expect
      .poll(() => transcriptLines(page))
      .toContain('You said: Compare this window with the mock.')
    expect((await transcriptLines(page)).filter((line) => line === marker)).toHaveLength(2)
    // The block carries the PNG as the clipboard re-encoded it, so its size
    // is the marker's, not the file's to the byte.
    const messages = await received(app)
    const blocks = messages.at(-1)?.blocks ?? []
    expect(blocks).toHaveLength(2)
    expect(blocks[0]).toEqual({
      type: 'text',
      text: `Compare this window with the mock.\n\n${marker}`,
    })
    expect(blocks[1]).toMatchObject({ type: 'image', mediaType: 'image/png' })
    const bytes = blocks[1]?.bytes ?? 0
    expect(bytes).toBeGreaterThan(0)
    expect(marker).toContain(`${Math.round(bytes / 1024)} KB`)
    await expect
      .poll(() => eventsIn(sessionsDir, 'mock-session').map((event) => event.type))
      .toContain('turn-end')
    const log = readFileSync(join(sessionsDir, 'mock-session', 'events.jsonl'), 'utf8')
    expect(log).toContain(marker)
    expect(log).not.toContain('base64')
    expect(log).not.toContain('iVBORw0KGgo')
    expect(await transcriptLines(page)).not.toContainEqual(expect.stringContaining('iVBORw0KGgo'))

    // fetch-url: http is refused before any request, in the help buffer.
    await runCommand(page, 'fetch-url')
    await expect(page.locator('#palette-prompt')).toHaveText('Fetch URL (https only):')
    await expect(page.locator('#palette-doc')).toHaveText('RET answers with the text typed.')
    await page.keyboard.type(fixtures.url('injection.html'))
    await page.keyboard.press('Enter')
    await expect(page.locator('#help .cm-content')).toContainText('Only https: URLs are fetched')
    expect(fixtures.requested).toEqual([])
    await page.keyboard.press('Control+x')
    await page.keyboard.press('k')
    await page.keyboard.press('Control+x')
    await page.keyboard.press('b')
    await expect(prompt).toBeFocused()

    // An https URL typed in the prompt is the candidate of C-c C-u; the page
    // comes back as text inside the wrapped block, instruction included,
    // and the notice says how much.
    const pageUrl = fixtures.secureUrl('injection.html')
    await page.keyboard.type(`Summarize ${pageUrl}`)
    await expect
      .poll(() =>
        page.evaluate(async () => {
          const state = await (globalThis as unknown as TestWindow).nemesis.promptState()
          return state.draft
        }),
      )
      .toBe(`Summarize ${pageUrl}`)
    await page.keyboard.press('Control+c')
    await page.keyboard.press('Control+u')
    await expect(page.locator('#palette-prompt')).toHaveText('Fetch URL (https only):')
    await expect.poll(() => candidates(page)).toEqual([`${pageUrl} *`])
    await page.keyboard.press('Enter')
    await expect(palette).toBeHidden()
    await expect
      .poll(() => promptLines(page))
      .toContain(`--- untrusted content from ${fixtures.httpsOrigin} ---`)
    const lines = await promptLines(page)
    const header = lines.indexOf(`--- untrusted content from ${fixtures.httpsOrigin} ---`)
    const footer = lines.indexOf(`--- end of untrusted content from ${fixtures.httpsOrigin} ---`)
    expect(header).toBeGreaterThan(0)
    expect(footer).toBeGreaterThan(header)
    expect(lines[header + 1]).toMatch(/untrusted content .* data .* not as instructions/)
    const canary = lines.findIndex((line) => line.includes('NEMESIS-INJECTION-CANARY'))
    expect(canary).toBeGreaterThan(header)
    expect(canary).toBeLessThan(footer)
    expect(lines.slice(header, footer).join('\n')).not.toContain('<p')
    expect(lines.slice(header, footer).join('\n')).not.toContain('<!--')
    expect(fixtures.requested).toEqual(['/injection.html'])
    await expect
      .poll(() => transcriptLines(page))
      .toContainEqual(
        expect.stringMatching(
          new RegExp(
            `^Fetched ${pageUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: \\d+ characters of text, in the prompt as untrusted content from `,
          ),
        ),
      )
    await page.keyboard.press('Control+g')
    await expect.poll(() => promptLines(page)).toEqual([''])

    // The two templates, from M-x, one after the other.
    await runCommand(page, 'template-symptom')
    await expect
      .poll(() => promptLines(page))
      .toEqual([
        'What happens:',
        'What should happen:',
        'How to reproduce:',
        'Where it last worked:',
      ])
    await expect(prompt).toBeFocused()
    await runCommand(page, 'template-pattern')
    await expect
      .poll(() => promptLines(page))
      .toEqual([
        'What happens:',
        'What should happen:',
        'How to reproduce:',
        'Where it last worked:',
        '',
        'The file that does it right:',
        'What to copy from it:',
        'What differs here:',
      ])
  } finally {
    await app.close()
    await fixtures.close()
  }
})
