import { expect, test, type Page } from '@playwright/test'
import { launchNemesis } from './_launch'

interface AgentEvent {
  readonly type: string
  readonly text?: string
  readonly isError?: boolean
  readonly outcome?: string
}

interface TestWindow {
  __agentEvents?: AgentEvent[]
  readonly nemesis: {
    readonly onAgentEvent: (listener: (event: AgentEvent) => void) => void
  }
}

/** The transcript's lines, as the DOM shows them. */
function lines(page: Page): Promise<string[]> {
  return page.locator('#transcript .cm-line').allTextContents()
}

/** Every event of the session so far, through the public bridge. */
function events(page: Page): Promise<AgentEvent[]> {
  return page.evaluate(() => (globalThis as unknown as TestWindow).__agentEvents ?? [])
}

async function assistantTexts(page: Page): Promise<string[]> {
  return (await events(page))
    .filter((event) => event.type === 'assistant-text')
    .map((event) => event.text ?? '')
}

async function toolResults(page: Page): Promise<AgentEvent[]> {
  return (await events(page)).filter((event) => event.type === 'tool-result')
}

/** Types a prompt into the prompt buffer and sends it with C-c C-c. */
async function send(page: Page, text: string): Promise<void> {
  await expect(page.locator('#prompt .cm-content')).toBeFocused()
  await page.keyboard.type(text)
  await page.keyboard.press('Control+c')
  await page.keyboard.press('Control+c')
}

test('a permission request is answered with n, y and a; a question with a digit or a reply', async () => {
  const app = await launchNemesis()
  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await expect(page.locator('#prompt .cm-content')).toBeFocused()
    await page.evaluate(() => {
      const w = globalThis as unknown as TestWindow
      w.__agentEvents = []
      w.nemesis.onAgentEvent((event) => w.__agentEvents?.push(event))
    })
    const request = page.locator('#request')
    const modeline = page.locator('#buffer-list')

    // The mock asks before Bash runs: the request is a block in the transcript
    // naming the tool and its arguments, a buffer in the mode line, and it
    // holds the point.
    await send(page, 'tool: Bash')
    await expect(request).toBeVisible()
    await expect(request).toBeFocused()
    await expect(modeline).toHaveText('Transcript Prompt [Permission: Bash]')
    await expect(page.locator('#request-title')).toHaveText('Bash wants to run')
    await expect.poll(() => lines(page)).toContain('Permission: Bash')
    expect(await lines(page)).toContain('  "path": "/mock/notes.txt"')
    expect(await lines(page)).toContain('y allow once, n deny, a allow Bash for this session')

    // A letter that is not an answer is not typed anywhere.
    await page.keyboard.press('q')
    await expect(request).toBeFocused()

    // n denies: the agent gets the denial as the tool result, the request is
    // gone from the mode line and the prompt has the point for a reason.
    await page.keyboard.press('n')
    await expect.poll(() => assistantTexts(page)).toEqual(['Did not run Bash.'])
    expect((await toolResults(page)).at(-1)).toMatchObject({
      isError: true,
      text: 'The user denied this tool in the cockpit.',
    })
    await expect(modeline).toHaveText('Transcript [Prompt]')
    await expect(request).toBeHidden()
    await expect(page.locator('#prompt .cm-content')).toBeFocused()
    expect(await lines(page)).toContain('Denied Bash')

    // y allows once: the tool runs, and the next call asks again.
    await send(page, 'tool: Bash')
    await expect(request).toBeFocused()
    await page.keyboard.press('y')
    await expect.poll(() => assistantTexts(page)).toEqual(['Did not run Bash.', 'Ran Bash.'])
    expect(await lines(page)).toContain('Allowed Bash once')
    await send(page, 'tool: Bash')
    await expect(request).toBeFocused()

    // a allows for the session: this call runs and the one after never asks.
    await page.keyboard.press('a')
    await expect.poll(() => assistantTexts(page)).toHaveLength(3)
    expect(await lines(page)).toContain('Allowed Bash for this session')
    await send(page, 'tool: Bash')
    await expect.poll(() => assistantTexts(page)).toHaveLength(4)
    expect(
      (await events(page)).filter((event) => event.type === 'permission-request'),
    ).toHaveLength(3)
    await expect(request).toBeHidden()
    // Another tool still asks.
    await send(page, 'tool: Write')
    await expect(modeline).toHaveText('Transcript Prompt [Permission: Write]')
    await page.keyboard.press('n')
    await expect.poll(() => assistantTexts(page)).toHaveLength(5)

    // A question with three options renders them numbered; 2 answers it.
    await send(page, 'ask: Which one?')
    await expect(request).toBeFocused()
    await expect(modeline).toHaveText('Transcript Prompt [Question: Choice]')
    await expect(page.locator('#request-title')).toHaveText('Which one?')
    await expect(page.locator('#request-options li')).toHaveText([
      'alpha: The first option.',
      'beta: The second option.',
      'gamma: The third option.',
    ])
    expect(await lines(page)).toContain('2. beta: The second option.')
    await page.keyboard.press('2')
    await expect.poll(() => assistantTexts(page)).toContain('You chose: beta')
    expect(await lines(page)).toContain('Answered Choice: beta')
    await expect(page.locator('#prompt .cm-content')).toBeFocused()

    // Free text answers a question through the prompt buffer: C-x b walks to
    // it, the text is sent as the answer, not as a prompt.
    await send(page, 'ask: Or else?')
    await expect(request).toBeFocused()
    await page.keyboard.press('Control+x')
    await page.keyboard.press('b')
    await page.keyboard.press('Control+x')
    await page.keyboard.press('b')
    await expect(modeline).toHaveText('Transcript [Prompt] Question: Choice')
    await send(page, 'delta, in my own words')
    await expect(page.locator('#prompt-note')).toHaveText('Answered.')
    await expect.poll(() => assistantTexts(page)).toContain('You chose: delta, in my own words')
    expect((await events(page)).filter((event) => event.type === 'user-text')).toHaveLength(7)
    await expect(modeline).toHaveText('Transcript [Prompt]')
  } finally {
    await app.close()
  }
})
