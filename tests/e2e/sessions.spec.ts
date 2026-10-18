import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
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

/** Types a prompt into the prompt buffer, sends it with C-c C-c and waits for the reply. */
async function send(page: Page, text: string): Promise<void> {
  await expect(page.locator('#prompt .cm-content')).toBeFocused()
  await page.keyboard.type(text)
  await page.keyboard.press('Control+c')
  await page.keyboard.press('Control+c')
  await expect(page.locator('#transcript .cm-content')).toContainText(`You said: ${text}`)
}

/** Types into the open palette until `label` is the highlighted candidate, then picks it. */
async function pick(page: Page, label: string): Promise<void> {
  await expect(page.locator('#palette-input .cm-content')).toBeFocused()
  await page.keyboard.type(label)
  await expect
    .poll(() =>
      page
        .locator('#palette-candidates li[aria-selected="true"]')
        .evaluate((item) => item.firstChild?.textContent ?? ''),
    )
    .toBe(label)
  await page.keyboard.press('Enter')
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

const DATE = String.raw`\d{4}-\d{2}-\d{2} \d{2}:\d{2}`

// Two sessions on disk, the older one resumed (#67): the palette lists them
// by first prompt and date, the resumed transcript is shown again, the
// session continues under its old id and its folder takes the new turns.
test('resume-session lists the sessions on disk, shows the older transcript again and appends new turns to it', async () => {
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

    // The first session, then a fresh one on C-x n: two folders on disk.
    await send(page, 'first one')
    await page.keyboard.press('Control+x')
    await page.keyboard.press('n')
    await expect
      .poll(() => lines(page))
      .toContain('New task: the next prompt starts a fresh session.')
    await send(page, 'second one')
    await expect.poll(() => promptsIn(sessionsDir, 'mock-session')).toEqual(['first one'])
    await expect.poll(() => promptsIn(sessionsDir, 'mock-session-2')).toEqual(['second one'])

    // M-x resume-session: the two sessions, newest first, each titled by its
    // first prompt with the date beside it and the folder in the doc line.
    await page.keyboard.press('Alt+x')
    await pick(page, 'resume-session')
    await expect(page.locator('#palette-prompt')).toHaveText('Resume session:')
    await expect
      .poll(() => page.locator('#palette-candidates li').allTextContents())
      .toEqual([
        expect.stringMatching(new RegExp(`^second one ${DATE}$`)),
        expect.stringMatching(new RegExp(`^first one ${DATE}$`)),
      ])
    await expect(page.locator('#palette-doc')).toHaveText(/^mock-session-2 in .*, current$/)

    // RET on the older one: its recorded turn is shown again, then the
    // notice, then the session starts under the old id.
    await pick(page, 'first one')
    const notice =
      'Resumed session mock-session: 1 earlier turn shown above; the next prompt continues it.'
    await expect.poll(() => lines(page)).toContain(notice)
    const seen = await events(page)
    const at = seen.findIndex((event) => event.type === 'notice' && event.text === notice)
    expect(seen.slice(at - 7, at).map((event) => event.type)).toEqual([
      'stopped',
      'user-text',
      'started',
      'assistant-text',
      'turn-end',
      'context-usage',
      'stopped',
    ])
    expect(seen[at - 6]).toEqual({ type: 'user-text', text: 'first one' })
    expect(seen[at - 5]).toMatchObject({ type: 'started', sessionId: 'mock-session' })
    // Four starts in the window: two live, the replayed one, and the resume.
    await expect
      .poll(async () =>
        (await events(page))
          .filter((event) => event.type === 'started')
          .map((event) => event.sessionId),
      )
      .toEqual(['mock-session', 'mock-session-2', 'mock-session', 'mock-session'])

    // A new turn goes to the resumed session: its folder grows, the other does not.
    await send(page, 'third')
    await expect.poll(() => promptsIn(sessionsDir, 'mock-session')).toEqual(['first one', 'third'])
    expect(promptsIn(sessionsDir, 'mock-session-2')).toEqual(['second one'])
    const org = readFileSync(join(sessionsDir, 'mock-session', 'session.org'), 'utf8')
    expect(org.match(/^#\+title:/gm)).toHaveLength(1)
    expect(org.match(/^\* \[/gm)).toHaveLength(2)
    expect(org).toContain(`- ${notice}\n`)
    expect(org).toContain('** You\nthird\n')
    expect(org).toContain('** Claude\nYou said: third\n')
  } finally {
    await app.close()
  }
})
