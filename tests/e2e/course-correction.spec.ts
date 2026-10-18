import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { launchApp } from './_launch'

interface AgentEvent {
  readonly type: string
  readonly text?: string
  readonly isError?: boolean
  readonly result?: string
  readonly sessionId?: string
}

interface TestWindow {
  __agentEvents?: AgentEvent[]
  readonly nemesis: {
    readonly onAgentEvent: (listener: (event: AgentEvent) => void) => void
  }
}

/** Every event of the session so far, through the public bridge. */
function events(page: Page): Promise<AgentEvent[]> {
  return page.evaluate(() => (globalThis as unknown as TestWindow).__agentEvents ?? [])
}

async function kinds(page: Page): Promise<string[]> {
  return (await events(page)).map((event) => event.type)
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

// The guide's course corrections as keys (#84): C-g stops the turn and keeps
// the context, C-x n starts over, rewind is a buffer over the checkpoints.
test('C-g interrupts a streaming turn, C-x n starts a fresh session, rewind lists the checkpoints', async () => {
  const { app, sessionsDir } = await launchApp()
  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    const prompt = page.locator('#prompt .cm-content')
    await expect(prompt).toBeFocused()
    await page.evaluate(() => {
      const w = globalThis as unknown as TestWindow
      w.__agentEvents = []
      w.nemesis.onAgentEvent((event) => w.__agentEvents?.push(event))
    })

    // A turn that streams until told to stop. C-g ends it: the turn-end
    // arrives, the session does not stop, and the next prompt is answered by
    // the same session, so the context was kept.
    await send(page, 'stream: tick')
    await expect(page.locator('#transcript .cm-content')).toContainText('tick 2')
    await page.keyboard.press('Control+g')
    await expect
      .poll(async () => (await events(page)).filter((event) => event.type === 'turn-end'))
      .toHaveLength(1)
    const [interrupted] = (await events(page)).filter((event) => event.type === 'turn-end')
    expect(interrupted).toMatchObject({ isError: true, result: 'Interrupted by the user' })
    expect(await kinds(page)).not.toContain('stopped')
    const chunks = (await events(page)).filter((event) => event.type === 'assistant-text').length
    await send(page, 'after')
    await expect(page.locator('#transcript .cm-content')).toContainText('You said: after')
    expect((await kinds(page)).filter((kind) => kind === 'started')).toHaveLength(1)
    // The stream stopped streaming: the only text since the interrupt is the reply.
    expect(
      (await events(page)).filter((event) => event.type === 'assistant-text').length - chunks,
    ).toBe(1)

    // C-x n: the session stops, the next prompt starts a new one under a new
    // id, with its own folder on disk.
    expect(existsSync(join(sessionsDir, 'mock-session'))).toBe(true)
    await page.keyboard.press('Control+x')
    await page.keyboard.press('n')
    await expect.poll(() => lines(page)).toContain('Session stopped (interrupted)')
    await expect
      .poll(() => lines(page))
      .toContain('New task: the next prompt starts a fresh session.')
    await send(page, 'fresh one')
    await expect(page.locator('#transcript .cm-content')).toContainText('You said: fresh one')
    await expect
      .poll(async () =>
        (await events(page))
          .filter((event) => event.type === 'started')
          .map((event) => event.sessionId),
      )
      .toEqual(['mock-session', 'mock-session-2'])
    expect(existsSync(join(sessionsDir, 'mock-session-2'))).toBe(true)

    // Two turns in the fresh session, then rewind: the help buffer lists the
    // two checkpoints and says what can be restored, and the palette reads
    // which one.
    await send(page, 'fresh two')
    await expect(page.locator('#transcript .cm-content')).toContainText('You said: fresh two')
    await runCommand(page, 'rewind')
    await expect(page.locator('#help')).toBeVisible()
    await expect
      .poll(() => page.locator('#help .cm-line').allTextContents())
      .toEqual([
        'Checkpoints, one per prompt sent, oldest first.',
        '',
        expect.stringMatching(/^1\. \d\d:\d\d:\d\d {2}fresh one$/),
        expect.stringMatching(/^2\. \d\d:\d\d:\d\d {2}fresh two$/),
        '',
        'Restore conversation: the session goes back to before the checkpoint; later turns are dropped.',
        'Restore code: files the agent edited since the checkpoint go back to their state then.',
        'Restore both: the two together.',
        'Summarize from here: not available, the Agent SDK exposes no such call.',
      ])
    await expect(page.locator('#palette-prompt')).toHaveText('Rewind to:')
    await expect(page.locator('#palette-candidates li')).toHaveCount(2)

    // Choose the second checkpoint and restore the code: the mock edits no
    // files, so the notice says so, and the session goes on.
    await page.keyboard.type('fresh two')
    await page.keyboard.press('Enter')
    await expect(page.locator('#palette-prompt')).toHaveText('Restore:')
    await expect
      .poll(() => page.locator('#palette-candidates li').allTextContents())
      .toEqual([
        expect.stringContaining('conversation'),
        expect.stringContaining('code'),
        expect.stringContaining('both'),
      ])
    await page.keyboard.type('code')
    await page.keyboard.press('Enter')
    await expect
      .poll(() => lines(page))
      .toContain('Rewind: files restored to checkpoint 2, 0 files changed.')
    expect((await kinds(page)).filter((kind) => kind === 'stopped')).toHaveLength(1)
  } finally {
    await app.close()
  }
})
