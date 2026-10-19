import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Page } from './_test'
import { launchApp } from './_launch'

/** What the native sink would have shown (#90), read off the main process through the spy. */
interface NotificationRecord {
  readonly type: string
  readonly title: string
  readonly body: string
}

/**
 * The M1 acceptance test (#66): one walk through the cockpit against the mock
 * SDK, run by the gate on every commit. It asserts the whole path at once,
 * launch to disk, so a regression in any one piece turns the gate red even
 * when that piece's own spec still passes. The per-feature specs (#61 to #65)
 * own the details; this one owns the sequence.
 */

/** Types a prompt into the prompt buffer and sends it with C-c C-c. */
async function send(page: Page, text: string): Promise<void> {
  await expect(page.locator('#prompt .cm-content')).toBeFocused()
  await page.keyboard.type(text)
  await page.keyboard.press('Control+c')
  await page.keyboard.press('Control+c')
}

function read(path: string): string {
  return existsSync(path) ? readFileSync(path, 'utf8') : ''
}

test('launch, prompt, reply, permission, file on disk, quit', async () => {
  const { app, sessionsDir } = await launchApp('nemesis-smoke-')
  let exitCode: number | null
  try {
    // Launch: one hardened window, the prompt buffer holds the point.
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    const transcript = page.locator('#transcript .cm-content')
    await expect(page).toHaveTitle('Nemesis')
    expect(app.windows()).toHaveLength(1)
    await expect(page.locator('#prompt .cm-content')).toBeFocused()
    expect(existsSync(sessionsDir)).toBe(false)
    // One `destroyed` listener per bridge, not per channel (#136): the
    // cockpit stays under Node's default limit of ten whatever its channels.
    const destroyedListeners = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().map((win) => win.webContents.listenerCount('destroyed')),
    )
    expect(destroyedListeners).toHaveLength(1)
    expect(destroyedListeners[0]).toBeLessThan(10)

    // Prompt and reply: the mock echoes, the transcript shows it, the prompt
    // is empty again and ready for the next one.
    await send(page, 'hello cockpit')
    await expect(page.locator('#prompt-note')).toHaveText('Sent.')
    await expect(transcript).toContainText('You said: hello cockpit')
    await expect.poll(() => page.locator('#prompt .cm-line').allTextContents()).toEqual([''])

    // Permission: the tool call waits on a key, y lets it run.
    await send(page, 'tool: Read')
    await expect(page.locator('#request')).toBeFocused()
    await expect(page.locator('#request-title')).toHaveText('Read wants to run')
    // Walking away (#90): the request raised one "needs you" notification,
    // with the session's name, the elapsed time and the tool-call count only.
    const needsYou = async (): Promise<NotificationRecord[]> =>
      (
        await app.evaluate(
          () =>
            (globalThis as { __nemesisNotifications?: NotificationRecord[] })
              .__nemesisNotifications ?? [],
        )
      ).filter((record) => record.type === 'session-needs-you')
    await expect.poll(needsYou).toHaveLength(1)
    const [notification] = await needsYou()
    expect(notification?.title).toBe('Nemesis: session mock-ses')
    expect(notification?.body).toMatch(/^Needs you after \d+s, 1 tool call\.$/)
    await expect(page.locator('#buffer-list')).toHaveText('Transcript Prompt [Permission: Read]')
    await page.keyboard.press('y')
    await expect(transcript).toContainText('Ran Read.')
    await expect(page.locator('#request')).toBeHidden()
    await expect(page.locator('#prompt .cm-content')).toBeFocused()

    // Files on disk: the session folder is inside the throwaway profile and
    // holds both turns before the app is asked to quit.
    const folder = join(sessionsDir, 'mock-session')
    await expect.poll(() => read(join(folder, 'session.org'))).toContain('Ran Read.')
    expect(readdirSync(folder).sort()).toEqual(['events.jsonl', 'session.org'])
  } finally {
    // Quit cleanly: the process ends with 0, then the folder reads back whole.
    const child = app.process()
    await app.close()
    exitCode = child.exitCode
  }
  expect(exitCode).toBe(0)

  // The quit closed the session: the log ends with `stopped`, after the turns.
  const folder = join(sessionsDir, 'mock-session')
  const org = read(join(folder, 'session.org'))
  expect(org).toContain('** You\nhello cockpit\n')
  expect(org).toContain('** Claude\nYou said: hello cockpit\n')
  expect(org).toContain('- Allowed Read once\n')
  expect(org).toContain('** Result: Read\n#+begin_example\nRead ran\n#+end_example\n')
  const types = read(join(folder, 'events.jsonl'))
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => (JSON.parse(line) as { type: string }).type)
  expect(types).toEqual([
    'user-text',
    'started',
    'assistant-text',
    'turn-end',
    'context-usage',
    'user-text',
    'tool-use',
    'permission-request',
    'permission-answered',
    'tool-result',
    'assistant-text',
    'turn-end',
    'context-usage',
    'stopped',
  ])
})
