import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Page } from './_test'
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

/** Runs rewind, picks the checkpoint by its prompt text and the target, up to the question. */
async function startRewind(page: Page, checkpoint: string, target: string): Promise<void> {
  await runCommand(page, 'rewind')
  await expect(page.locator('#palette-prompt')).toHaveText('Rewind to:')
  await page.keyboard.type(checkpoint)
  await page.keyboard.press('Enter')
  await expect(page.locator('#palette-prompt')).toHaveText('Restore:')
  await page.keyboard.type(target)
  await page.keyboard.press('Enter')
}

// The guide's course corrections as keys (#84): C-g stops the turn and keeps
// the context, C-x n starts over, rewind is a buffer over the checkpoints,
// and a restore shows what it would change and asks first (#99).
test('C-g interrupts a streaming turn, C-x n starts a fresh session, rewind previews and asks', async () => {
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

    // Choose the second checkpoint and restore the code: nothing was edited,
    // the dry run says so in the help buffer, and the question still asks,
    // with "Do not restore" highlighted; RET is the no, a notice (#99).
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
    await expect(page.locator('#palette-prompt')).toHaveText('Restore 0 files to checkpoint 2?')
    expect(await candidates(page)).toEqual(['Do not restore *', 'Restore'])
    await expect
      .poll(() => page.locator('#help .cm-line').allTextContents())
      .toEqual([
        'Rewind to checkpoint 2: the files that would change.',
        '',
        'None: no file changed since the checkpoint.',
        '',
        '0 files, 0 insertions, 0 deletions.',
      ])
    await page.keyboard.press('Enter')
    await expect(page.locator('#palette')).toBeHidden()
    await expect
      .poll(() => lines(page))
      .toContain('Rewind: checkpoint 2 left as is, nothing restored.')

    // The palette hands the point back to the help buffer it opened over;
    // kill it and bring the prompt back, as the diff spec does (#68).
    await page.keyboard.press('Control+x')
    await page.keyboard.press('k')
    await expect(page.locator('#help')).toBeHidden()
    await page.keyboard.press('Control+x')
    await page.keyboard.press('b')
    await expect(prompt).toBeFocused()

    // A third turn edits the mock's file, allowed with y, so a restore of the
    // code has something to list (#99).
    await send(page, 'edit: beta changed')
    await expect(page.locator('#buffer-list')).toHaveText('Transcript Prompt [Permission: Edit]')
    await page.keyboard.press('y')
    await expect(page.locator('#transcript .cm-content')).toContainText('Edited notes.txt.')
    await expect(prompt).toBeFocused()

    // Restore the code at checkpoint 2: the help buffer shows the SDK's dry
    // run, the files and the counts, and the prompt buffer asks with "Do not
    // restore" highlighted. RET is the no: a notice, and nothing restored.
    await startRewind(page, 'fresh two', 'code')
    await expect(page.locator('#palette-prompt')).toHaveText('Restore 1 file to checkpoint 2?')
    expect(await candidates(page)).toEqual(['Do not restore *', 'Restore'])
    const preview = [
      'Rewind to checkpoint 2: the files that would change.',
      '',
      '  /mock/notes.txt',
      '',
      '1 file, 1 insertion, 1 deletion.',
    ]
    await expect.poll(() => page.locator('#help .cm-line').allTextContents()).toEqual(preview)
    await page.keyboard.press('Enter')
    await expect(page.locator('#palette')).toBeHidden()
    await expect
      .poll(() => lines(page))
      .toContain('Rewind: checkpoint 2 left as is, nothing restored.')
    expect((await lines(page)).some((line) => line.includes('files restored'))).toBe(false)

    // The no left the file: the next preview lists it again. The yes, a
    // deliberate C-n away, runs the real rewind, and the session goes on.
    await startRewind(page, 'fresh two', 'code')
    await expect(page.locator('#palette-prompt')).toHaveText('Restore 1 file to checkpoint 2?')
    await expect.poll(() => page.locator('#help .cm-line').allTextContents()).toEqual(preview)
    await page.keyboard.press('Control+n')
    expect(await candidates(page)).toEqual(['Do not restore', 'Restore *'])
    await page.keyboard.press('Enter')
    await expect
      .poll(() => lines(page))
      .toContain('Rewind: files restored to checkpoint 2, 1 file changed.')
    expect((await kinds(page)).filter((kind) => kind === 'stopped')).toHaveLength(1)

    // A conversation-only restore skips the dry run and asks the one
    // question, with the turns it drops; RET is the no again.
    await startRewind(page, 'edit: beta', 'conversation')
    await expect(page.locator('#palette-prompt')).toHaveText(
      'Restore the conversation to before checkpoint 3, dropping 1 turn?',
    )
    expect(await candidates(page)).toEqual(['Do not restore *', 'Restore'])
    await page.keyboard.press('Enter')
    await expect
      .poll(() => lines(page))
      .toContain('Rewind: checkpoint 3 left as is, nothing restored.')
    expect((await kinds(page)).filter((kind) => kind === 'stopped')).toHaveLength(1)
  } finally {
    await app.close()
  }
})
