import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Page } from './_test'
import { launchApp } from './_launch'

interface AgentEvent {
  readonly type: string
  readonly text?: string
  readonly name?: string
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

/** The events a session folder's log holds, in order; none for a folder without a log. */
function eventsIn(sessionsDir: string, id: string): AgentEvent[] {
  const log = join(sessionsDir, id, 'events.jsonl')
  if (!existsSync(log)) return []
  return readFileSync(log, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as AgentEvent)
}

/** The prompts a session folder's log holds, in order. */
function promptsIn(sessionsDir: string, id: string): string[] {
  return eventsIn(sessionsDir, id)
    .filter((event) => event.type === 'user-text')
    .map((event) => event.text ?? '')
}

/** The names a session folder's log holds, in order (#104). */
function namesIn(sessionsDir: string, id: string): string[] {
  return eventsIn(sessionsDir, id)
    .filter((event) => event.type === 'named')
    .map((event) => event.name ?? '')
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

// A named session (#104): the name is one event in the log and a property in
// the Org file, the window title and the mode line carry it, and nothing is
// rewritten. After a relaunch the list shows the name in place of the first
// prompt, the resume brings the title back, and M-p walks into the old
// prompts because the resume seeded the history.
test('name-session names the session for the list, the title and the mode line, and a resume seeds M-p', async () => {
  const first = await launchApp()
  const { userData, sessionsDir } = first
  try {
    const page = await first.app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await expect(page.locator('#prompt .cm-content')).toBeFocused()
    await send(page, 'first one')
    await send(page, 'second one')
    expect(await page.title()).toBe('Nemesis')
    await expect(page.locator('#session-name')).toBeHidden()

    // C-c C-n reads the name; the mode line, the title, the transcript and
    // the two files follow. A second name is a second event; the latest wins.
    await page.keyboard.press('Control+c')
    await page.keyboard.press('Control+n')
    await expect(page.locator('#palette-prompt')).toHaveText('Name session:')
    await page.keyboard.type('first name')
    await page.keyboard.press('Enter')
    await expect(page.locator('#session-name')).toHaveText('first name')
    await page.keyboard.press('Control+c')
    await page.keyboard.press('Control+n')
    await expect(page.locator('#palette-prompt')).toHaveText('Name session:')
    await page.keyboard.type('nemesis security review')
    await page.keyboard.press('Enter')
    await expect(page.locator('#session-name')).toHaveText('nemesis security review')
    await expect.poll(() => page.title()).toBe('nemesis security review · Nemesis')
    await expect.poll(() => lines(page)).toContain('Session named: nemesis security review')
    await expect
      .poll(() => namesIn(sessionsDir, 'mock-session'))
      .toEqual(['first name', 'nemesis security review'])
    expect(promptsIn(sessionsDir, 'mock-session')).toEqual(['first one', 'second one'])
    const org = readFileSync(join(sessionsDir, 'mock-session', 'session.org'), 'utf8')
    expect(org).toContain('\n#+property: session_name first name\n')
    expect(org).toContain('\n#+property: session_name nemesis security review\n')
    expect(org.match(/^#\+title:/gm)).toHaveLength(1)

    // A fresh session has no name: the title and the mode line go back.
    await page.keyboard.press('Control+x')
    await page.keyboard.press('n')
    await expect(page.locator('#session-name')).toBeHidden()
    await expect.poll(() => page.title()).toBe('Nemesis')
  } finally {
    await first.app.close()
  }

  // Relaunched on the same profile: the list shows the name, the resume
  // brings the name back with the session, and M-p walks its prompts.
  const second = await launchApp('nemesis-e2e-', [], {}, {}, undefined, userData)
  try {
    const page = await second.app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await expect(page.locator('#prompt .cm-content')).toBeFocused()
    expect(await page.title()).toBe('Nemesis')
    await page.keyboard.press('Alt+x')
    await pick(page, 'resume-session')
    await expect(page.locator('#palette-prompt')).toHaveText('Resume session:')
    await expect
      .poll(() => page.locator('#palette-candidates li').allTextContents())
      .toEqual([expect.stringMatching(new RegExp(`^nemesis security review ${DATE}$`))])
    await pick(page, 'nemesis security review')
    await expect
      .poll(() => lines(page))
      .toContain(
        'Resumed session mock-session: 2 earlier turns shown above; the next prompt continues it.',
      )
    await expect(page.locator('#session-name')).toHaveText('nemesis security review')
    await expect.poll(() => page.title()).toBe('nemesis security review · Nemesis')
    // The resume recorded no new name: the log still holds the two.
    expect(namesIn(sessionsDir, 'mock-session')).toEqual(['first name', 'nemesis security review'])

    // M-p walks back through the resumed session's prompts, newest first;
    // M-n comes forward to the empty draft.
    await expect(page.locator('#prompt .cm-content')).toBeFocused()
    await page.keyboard.press('Alt+p')
    await expect(page.locator('#prompt .cm-content')).toHaveText('second one')
    await page.keyboard.press('Alt+p')
    await expect(page.locator('#prompt .cm-content')).toHaveText('first one')
    await page.keyboard.press('Alt+n')
    await page.keyboard.press('Alt+n')
    await expect(page.locator('#prompt .cm-content')).toHaveText('')
  } finally {
    await second.app.close()
  }
})
