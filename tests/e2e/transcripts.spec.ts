import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Page } from './_test'
import { launchApp } from './_launch'

/** Types a prompt and sends it with C-c C-c, then waits for the reply to land. */
async function send(page: Page, text: string, reply: string): Promise<void> {
  await expect(page.locator('#prompt .cm-content')).toBeFocused()
  await page.keyboard.type(text)
  await page.keyboard.press('Control+c')
  await page.keyboard.press('Control+c')
  await expect(page.locator('#transcript .cm-content')).toContainText(reply)
}

function read(path: string): string {
  return existsSync(path) ? readFileSync(path, 'utf8') : ''
}

test('a session leaves its folder on disk: the event log and an Org transcript with the prompt and the reply', async () => {
  const { app, userData, sessionsDir } = await launchApp()
  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')

    // The settings file the harness wrote is the one the app read: the folder
    // is inside the profile, named by the mock's session id, and nothing was
    // written before the first prompt.
    expect(existsSync(join(userData, 'settings.json'))).toBe(true)
    expect(existsSync(sessionsDir)).toBe(false)

    await send(page, 'alpha one', 'You said: alpha one')
    const folder = join(sessionsDir, 'mock-session')
    const org = join(folder, 'session.org')
    const log = join(folder, 'events.jsonl')
    await expect.poll(() => read(org)).toContain('You said: alpha one')
    expect(readdirSync(folder).sort()).toEqual(['events.jsonl', 'session.org'])

    const rendered = read(org)
    expect(rendered.startsWith('#+title: Nemesis session mock-session\n#+date: [')).toBe(true)
    expect(rendered).toContain('** You\nalpha one\n')
    expect(rendered).toContain('- Session started: claude-mock-1, default mode, in ')
    expect(rendered).toContain('** Claude\nYou said: alpha one\n')

    const types = read(log)
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as { ts: string; type: string })
    expect(types.map((entry) => entry.type)).toEqual([
      'user-text',
      'started',
      'assistant-text',
      'turn-end',
      'context-usage',
    ])
    expect(types[0]?.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/)

    // A tool turn: the call is a source block, the permission answer a note,
    // the output an example block.
    await send(page, 'tool: Read', 'Permission')
    await page.keyboard.press('y')
    await expect(page.locator('#transcript .cm-content')).toContainText('Ran Read.')
    await expect.poll(() => read(org)).toContain('Ran Read.')
    const withTool = read(org)
    expect(withTool).toContain(
      '** Tool: Read\n#+begin_src json\n{\n  "path": "/mock/notes.txt"\n}\n#+end_src\n',
    )
    expect(withTool).toContain('- Permission asked: Read\n')
    expect(withTool).toContain('- Allowed Read once\n')
    expect(withTool).toContain('** Result: Read\n#+begin_example\nRead ran\n#+end_example\n')
    expect(withTool.match(/^\* \[/gm)).toHaveLength(2)
  } finally {
    await app.close()
  }
})
