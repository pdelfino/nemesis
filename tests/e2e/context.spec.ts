import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Page } from './_test'
import { launchApp } from './_launch'

interface AgentEvent {
  readonly type: string
  readonly text?: string
  readonly sessionId?: string
}

interface TestWindow {
  __agentEvents?: AgentEvent[]
  readonly nemesis: {
    readonly onAgentEvent: (listener: (event: AgentEvent) => void) => void
  }
}

/** Every event the window saw so far, through the public bridge. */
function events(page: Page): Promise<AgentEvent[]> {
  return page.evaluate(() => (globalThis as unknown as TestWindow).__agentEvents ?? [])
}

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

/** The prompts a session folder's log holds, in order. */
function promptsIn(sessionsDir: string, id: string): string[] {
  const log = join(sessionsDir, id, 'events.jsonl')
  if (!existsSync(log)) return []
  return readFileSync(log, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as AgentEvent)
    .filter((event) => event.type === 'user-text')
    .map((event) => event.text ?? '')
}

// The guide's one constraint as affordances (#80): the meter in the mode line
// follows the SDK's usage, C-c C-k compacts with the prompt buffer as the
// instruction, C-c C-l clears to a fresh session, a side question answers in
// the help buffer and leaves the history alone, and the second correction in
// a row puts the guide's advice in the mode line.
test('the context meter follows usage, compact and clear are keys, a side question stays out of history, two corrections nudge', async () => {
  const { app, sessionsDir } = await launchApp()
  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await expect(page.locator('#prompt .cm-content')).toBeFocused()
    await page.evaluate(() => {
      const w = globalThis as unknown as TestWindow
      w.__agentEvents = []
      w.nemesis.onAgentEvent((event) => w.__agentEvents?.push(event))
    })
    const meter = page.locator('#context-meter')
    const hint = page.locator('#modeline-hint')
    await expect(meter).toHaveText('')
    await expect(meter).toHaveAttribute('data-level', 'none')

    // The first turn: the mock's reply carried 2000 tokens against a 200k
    // window, and the usage event drew the meter.
    await send(page, 'hello')
    await expect(page.locator('#transcript .cm-content')).toContainText('You said: hello')
    await expect(meter).toHaveText('2k/200k 1% ░░░░░░░░░░')
    await expect(meter).toHaveAttribute('data-level', 'ok')
    expect((await events(page)).filter((event) => event.type === 'context-usage')).toHaveLength(1)

    // Past the step: the fraction, the bar and the color say so.
    await send(page, 'usage: 150000')
    await expect(meter).toHaveText('150k/200k 75% ████████░░')
    await expect(meter).toHaveAttribute('data-level', 'high')

    // C-c C-k with an instruction typed: the prompt buffer sends `/compact
    // <text>`, the CLI compacts, the transcript says so, the meter drops.
    await page.keyboard.type('keep the file list')
    await page.keyboard.press('Control+c')
    await page.keyboard.press('Control+k')
    await expect
      .poll(() => lines(page))
      .toContain('Compacted the conversation (manual): 152000 tokens before, 2000 after.')
    await expect(page.locator('#transcript .cm-content')).toContainText(
      '/compact keep the file list',
    )
    await expect(page.locator('#prompt .cm-content')).toHaveText('')
    await expect(meter).toHaveText('2k/200k 1% ░░░░░░░░░░')
    await expect(meter).toHaveAttribute('data-level', 'ok')

    // C-c C-l: the session stops, the meter goes blank, and the next prompt
    // starts a new session under a new id.
    await page.keyboard.press('Control+c')
    await page.keyboard.press('Control+l')
    await expect
      .poll(() => lines(page))
      .toContain('New task: the next prompt starts a fresh session.')
    await expect(meter).toHaveText('')
    await send(page, 'fresh one')
    await expect(page.locator('#transcript .cm-content')).toContainText('You said: fresh one')
    await expect
      .poll(async () =>
        (await events(page))
          .filter((event) => event.type === 'started')
          .map((event) => event.sessionId),
      )
      .toEqual(['mock-session', 'mock-session-2'])
    await expect(meter).toHaveText('2k/200k 1% ░░░░░░░░░░')

    // A side question: read as free text, answered in the help buffer, and
    // neither the window's stream, the transcript nor the folder on disk
    // grew by it. The fork it ran in left no folder of its own.
    const seen = (await events(page)).length
    const shown = await lines(page)
    await page.keyboard.press('Alt+x')
    await expect(page.locator('#palette-input .cm-content')).toBeFocused()
    await page.keyboard.type('side-question')
    await expect
      .poll(() =>
        page
          .locator('#palette-candidates li[aria-selected="true"]')
          .evaluate((item) => item.firstChild?.textContent ?? ''),
      )
      .toBe('side-question')
    await page.keyboard.press('Enter')
    await expect(page.locator('#palette-prompt')).toHaveText('Side question:')
    await expect(page.locator('#palette-doc')).toHaveText('RET answers with the text typed.')
    await page.keyboard.type('what does the config do')
    await page.keyboard.press('Enter')
    await expect(page.locator('#help')).toBeVisible()
    await expect
      .poll(() => page.locator('#help .cm-line').allTextContents())
      .toEqual([
        'Side question: what does the config do',
        '',
        'You said: what does the config do',
        '',
        'This answer is not in the session history.',
      ])
    expect((await events(page)).length).toBe(seen)
    expect(await lines(page)).toEqual(shown)
    expect(promptsIn(sessionsDir, 'mock-session-2')).toEqual(['fresh one'])
    expect(existsSync(join(sessionsDir, 'mock-session-3'))).toBe(false)

    // Two corrections in a row: the mode line carries the guide's advice
    // after the second, and the next ordinary prompt takes it down.
    await page.keyboard.press('Control+x')
    await page.keyboard.press('k')
    await expect(page.locator('#buffer-list')).toHaveText('[Transcript] Prompt')
    await page.keyboard.press('Control+x')
    await page.keyboard.press('b')
    await expect(page.locator('#prompt .cm-content')).toBeFocused()
    await send(page, 'no, the other file')
    await expect(page.locator('#transcript .cm-content')).toContainText(
      'You said: no, the other file',
    )
    await expect(hint).toHaveText('')
    await send(page, 'wrong again')
    await expect(hint).toHaveText(
      '2 corrections in a row: clear (C-c C-l) and start over with a better prompt that says what you learned.',
    )
    await expect
      .poll(() => lines(page))
      .toContain(
        '2 corrections in a row: clear (C-c C-l) and start over with a better prompt that says what you learned.',
      )
    await send(page, 'thanks')
    await expect(hint).toHaveText('')
    expect(promptsIn(sessionsDir, 'mock-session-2')).toEqual([
      'fresh one',
      'no, the other file',
      'wrong again',
      'thanks',
    ])
  } finally {
    await app.close()
  }
})

// The session's cost next to the meter (#191): hidden until the first
// result, the SDK's running total after every turn with the last turn's
// share in the tooltip, blank once the session stops, and never in the log.
test('the mode line shows the session cost after a turn, and the log keeps none', async () => {
  const { app, sessionsDir } = await launchApp()
  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await expect(page.locator('#prompt .cm-content')).toBeFocused()
    const cost = page.locator('#session-cost')
    await expect(cost).toHaveText('')
    await expect(cost).toBeHidden()

    // The mock adds two cents a turn.
    await send(page, 'hello')
    await expect(page.locator('#transcript .cm-content')).toContainText('You said: hello')
    await expect(cost).toHaveText('≈$0.02')
    await expect(cost).toBeVisible()
    await send(page, 'again')
    await expect(page.locator('#transcript .cm-content')).toContainText('You said: again')
    await expect(cost).toHaveText('≈$0.04')
    await expect(cost).toHaveAttribute(
      'title',
      "Session cost so far: $0.0400, the SDK's estimate at list price. Last turn: $0.0200.",
    )

    const log = readFileSync(join(sessionsDir, 'mock-session', 'events.jsonl'), 'utf8')
    expect(log).toContain('"type":"turn-end"')
    expect(log).not.toContain('costUsd')

    // C-c C-l stops the session: the cost goes with it.
    await page.keyboard.press('Control+c')
    await page.keyboard.press('Control+l')
    await expect(cost).toHaveText('')
  } finally {
    await app.close()
  }
})
