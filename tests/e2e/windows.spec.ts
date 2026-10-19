import { expect, test, type Page } from './_test'
import { launchNemesis } from './_launch'

interface AgentEvent {
  readonly type: string
  readonly text?: string
}

interface TestWindow {
  __agentEvents?: AgentEvent[]
  readonly nemesis: {
    readonly onAgentEvent: (listener: (event: AgentEvent) => void) => void
  }
}

/** The candidates the palette lists, the highlighted one marked. */
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

/** Starts recording the agent events this window receives. */
async function listen(page: Page): Promise<void> {
  await expect(page.locator('#prompt .cm-content')).toBeFocused()
  await page.evaluate(() => {
    const w = globalThis as unknown as TestWindow
    w.__agentEvents = []
    w.nemesis.onAgentEvent((event) => w.__agentEvents?.push(event))
  })
}

function events(page: Page): Promise<AgentEvent[]> {
  return page.evaluate(() => (globalThis as unknown as TestWindow).__agentEvents ?? [])
}

async function assistantTexts(page: Page): Promise<string[]> {
  return (await events(page))
    .filter((event) => event.type === 'assistant-text')
    .map((event) => event.text ?? '')
}

/** How many sessions started in this window. */
async function starts(page: Page): Promise<number> {
  return (await events(page)).filter((event) => event.type === 'started').length
}

/** Types a prompt into the prompt buffer and sends it with C-c C-c. */
async function send(page: Page, text: string): Promise<void> {
  await expect(page.locator('#prompt .cm-content')).toBeFocused()
  await page.keyboard.type(text)
  await page.keyboard.press('Control+c')
  await page.keyboard.press('Control+c')
}

test('C-x 5 2 opens a second window with its own session; prompts and permission requests do not cross', async () => {
  const app = await launchNemesis()
  try {
    const first = await app.firstWindow()
    await first.waitForLoadState('domcontentloaded')
    await listen(first)

    // C-x 5 2 opens a second cockpit window, with its own buffers.
    const opened = app.waitForEvent('window')
    await first.keyboard.press('Control+x')
    await first.keyboard.press('5')
    await first.keyboard.press('2')
    const second = await opened
    await second.waitForLoadState('domcontentloaded')
    await second.bringToFront()
    await listen(second)
    await expect(second.locator('#buffer-list')).toHaveText('Transcript [Prompt]')

    // A prompt in each window reaches that window's session alone.
    await first.bringToFront()
    await send(first, 'hello from one')
    await expect.poll(() => assistantTexts(first)).toEqual(['You said: hello from one'])
    await second.bringToFront()
    await send(second, 'hello from two')
    await expect.poll(() => assistantTexts(second)).toEqual(['You said: hello from two'])
    expect(await assistantTexts(first)).toEqual(['You said: hello from one'])
    await expect(first.locator('#transcript')).not.toContainText('hello from two')
    await expect(second.locator('#transcript')).not.toContainText('hello from one')

    // Two windows, two sessions: each window saw its own session start, and
    // only its own. (The mock names every driver's first session alike, so
    // the ids cannot tell them apart.)
    expect(await starts(first)).toBe(1)
    expect(await starts(second)).toBe(1)

    // A permission request in the second window holds that window only; the
    // first window's buffers and keys are untouched, and the answer is given
    // where the request was made.
    await send(second, 'tool: Bash')
    await expect(second.locator('#request')).toBeVisible()
    await expect(second.locator('#buffer-list')).toHaveText('Transcript Prompt [Permission: Bash]')
    await expect(first.locator('#request')).toBeHidden()
    await expect(first.locator('#buffer-list')).toHaveText('Transcript [Prompt]')
    expect((await events(first)).some((event) => event.type === 'permission-request')).toBe(false)
    await second.keyboard.press('n')
    await expect.poll(() => assistantTexts(second)).toContain('Did not run Bash.')
    expect(await assistantTexts(first)).toEqual(['You said: hello from one'])

    // The palette's buffers source lists every window's buffers, the other
    // window's named.
    await first.bringToFront()
    await first.keyboard.press('Alt+x')
    await first.keyboard.type('choose-buffer')
    await first.keyboard.press('Enter')
    await expect(first.locator('#palette-prompt')).toHaveText('Switch to buffer:')
    await expect
      .poll(() => candidates(first))
      .toEqual(['Transcript *', 'Prompt', 'Transcript <Window 2>', 'Prompt <Window 2>'])
    await first.keyboard.press('Control+g')
    await expect(first.locator('#palette')).toBeHidden()
  } finally {
    await app.close()
  }
})
