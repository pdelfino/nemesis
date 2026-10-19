import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ElectronApplication } from '@playwright/test'
import { expect, test, type Page } from './_test'
import { launchApp, launchNemesis } from './_launch'

interface AgentEvent {
  readonly type: string
  readonly text?: string
  readonly cwd?: string
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

async function userTexts(page: Page): Promise<string[]> {
  return (await events(page))
    .filter((event) => event.type === 'user-text')
    .map((event) => event.text ?? '')
}

/** Types a prompt into the prompt buffer and sends it with C-c C-c. */
async function send(page: Page, text: string): Promise<void> {
  await expect(page.locator('#prompt .cm-content')).toBeFocused()
  await page.keyboard.type(text)
  await page.keyboard.press('Control+c')
  await page.keyboard.press('Control+c')
}

/** The review buffer's lines, as the editor shows them. */
function reviewLines(page: Page): Promise<string[]> {
  return page.locator('#review .cm-line').allTextContents()
}

/** Closes the newest window the way its close button does: the window's `close` event runs. */
async function closeNewestWindow(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ BrowserWindow }) => {
    const newest = BrowserWindow.getAllWindows().sort((a, b) => b.id - a.id)[0]
    newest?.close()
  })
}

/** The worktrees git lists for the repository. */
function worktreesOf(repo: string): string[] {
  return execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: repo, encoding: 'utf8' })
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length))
}

// The guide's adversarial review step (#87): the writer's diff goes to a
// fresh session in a second window, and the findings come back as a review
// buffer whose one key sends them to the writer.
test('review-diff opens a reviewer window; its findings land in a review buffer and review-apply sends them to the writer', async () => {
  const app = await launchNemesis()
  try {
    const writer = await app.firstWindow()
    await writer.waitForLoadState('domcontentloaded')
    await listen(writer)
    const modeline = writer.locator('#buffer-list')

    // Nothing edited yet: there is nothing to review, and no window opens.
    await writer.keyboard.press('Control+c')
    await writer.keyboard.press('Control+r')
    await expect(writer.locator('#help .cm-line').first()).toHaveText(
      'Nothing to review: the agent has made no Edit or Write call in this session.',
    )
    expect(app.windows()).toHaveLength(1)
    await writer.keyboard.press('Control+x')
    await writer.keyboard.press('k')
    await writer.keyboard.press('Control+x')
    await writer.keyboard.press('b')

    // The writer makes one Edit.
    await send(writer, 'edit: beta changed')
    await expect(modeline).toHaveText('Transcript Prompt [Permission: Edit]')
    await writer.keyboard.press('y')
    await expect(writer.locator('#transcript .cm-content')).toContainText('Edited notes.txt.')

    // C-c C-r opens a second window whose fresh session starts with the
    // reviewer's prompt: the instruction and the diff as a unified patch.
    const opened = app.waitForEvent('window')
    await writer.keyboard.press('Control+c')
    await writer.keyboard.press('Control+r')
    const reviewer = await opened
    await reviewer.waitForLoadState('domcontentloaded')
    await expect(reviewer.locator('#transcript .cm-content')).toContainText(
      'Report only gaps that affect correctness',
    )
    await expect(reviewer.locator('#transcript .cm-content')).toContainText('+beta changed')
    expect(await userTexts(writer)).toEqual(['edit: beta changed'])

    // The reviewer's final text (the mock echoes its prompt) is a review
    // buffer in the writer's window, with the point.
    await writer.bringToFront()
    await expect(writer.locator('#review')).toBeVisible()
    await expect(modeline).toHaveText('Transcript Prompt [Review by Window 2]')
    await expect(writer.locator('#review-from')).toHaveText('Review by Window 2')
    await expect
      .poll(async () => (await reviewLines(writer))[0])
      .toBe(
        'You said: You are reviewing a change another session made. You did not write it: review it with fresh eyes.',
      )
    expect(await reviewLines(writer)).toContain('-beta')
    await expect(writer.locator('#review .cm-content')).toBeFocused()

    // C-c C-c there sends the findings to the writer's session as a prompt.
    await writer.keyboard.press('Control+c')
    await writer.keyboard.press('Control+c')
    await expect.poll(async () => (await userTexts(writer)).length).toBe(2)
    const applied = (await userTexts(writer))[1] ?? ''
    expect(
      applied.startsWith(
        'Address these review findings, one by one:\n\nYou said: You are reviewing',
      ),
    ).toBe(true)
    expect(await userTexts(reviewer)).toEqual([])

    // The review buffer is killed like any other.
    await writer.keyboard.press('Control+x')
    await writer.keyboard.press('b')
    await expect(modeline).toContainText('Review by Window 2')
    await writer.keyboard.press('Alt+x')
    await expect(writer.locator('#palette-input .cm-content')).toBeFocused()
    await writer.keyboard.type('choose-buffer')
    await writer.keyboard.press('Enter')
    await expect(writer.locator('#palette-prompt')).toHaveText('Switch to buffer:')
    await expect(writer.locator('#palette-input .cm-content')).toBeFocused()
    await writer.keyboard.type('Review by')
    await expect.poll(() => candidates(writer)).toContain('Review by Window 2 *')
    await writer.keyboard.press('Enter')
    await expect(writer.locator('#review .cm-content')).toBeFocused()
    await writer.keyboard.press('Control+x')
    await writer.keyboard.press('k')
    await expect(writer.locator('#review')).toBeHidden()
    await expect(modeline).not.toContainText('Review by')
  } finally {
    await app.close()
  }
})

// A worktree per window (#87): the task name becomes a git worktree beside
// the folder, a window works there, and closing it asks, keep highlighted.
test('new-window-in-worktree makes a worktree and a window in it; closing keeps it by default and removes a clean one on a yes', async () => {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'nemesis-e2e-worktree-')))
  const repo = join(parent, 'repo')
  mkdirSync(repo)
  const git = (...args: string[]): void => {
    execFileSync('git', args, { cwd: repo, stdio: 'ignore' })
  }
  git('init', '-q', '-b', 'main')
  writeFileSync(join(repo, 'notes.txt'), 'alpha\n')
  git('add', 'notes.txt')
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-q', '-m', 'init')
  const kept = `${repo}-fix-login`
  const removed = `${repo}-second-task`

  const { app } = await launchApp('nemesis-e2e-', [], {}, {}, repo)
  try {
    const first = await app.firstWindow()
    await first.waitForLoadState('domcontentloaded')
    await listen(first)

    // C-x 5 w reads the task name; the worktree is made and a window opens there.
    let opened = app.waitForEvent('window')
    await first.keyboard.press('Control+x')
    await first.keyboard.press('5')
    await first.keyboard.press('w')
    await expect(first.locator('#palette-prompt')).toHaveText('Worktree for task:')
    await expect(first.locator('#palette-input .cm-content')).toBeFocused()
    await first.keyboard.type('Fix login')
    await first.keyboard.press('Enter')
    const worktree = await opened
    await worktree.waitForLoadState('domcontentloaded')
    expect(worktreesOf(repo)).toEqual([repo, kept])
    expect(existsSync(join(kept, 'notes.txt'))).toBe(true)
    await expect(first.locator('#transcript .cm-content')).toContainText(
      `Worktree made: ${kept} on the new branch fix-login`,
    )

    // The window's session runs in the worktree.
    await worktree.bringToFront()
    await listen(worktree)
    await send(worktree, 'hello')
    await expect
      .poll(async () => (await events(worktree)).find((event) => event.type === 'started')?.cwd)
      .toBe(kept)

    // The same name again is a notice, and no window opens.
    await first.bringToFront()
    await first.keyboard.press('Control+x')
    await first.keyboard.press('5')
    await first.keyboard.press('w')
    await expect(first.locator('#palette-input .cm-content')).toBeFocused()
    await first.keyboard.type('fix login')
    await first.keyboard.press('Enter')
    await expect(first.locator('#transcript .cm-content')).toContainText(
      'No worktree made: the name fix-login is already used',
    )
    expect(app.windows()).toHaveLength(2)

    // Closing asks, keep highlighted; RET keeps the worktree.
    await closeNewestWindow(app)
    await expect(worktree.locator('#palette-prompt')).toContainText(`Remove the worktree ${kept}?`)
    await expect
      .poll(() => candidates(worktree))
      .toEqual(['Keep the worktree *', 'Remove the worktree'])
    // The answer closes the window under the key press, so the press itself may fail.
    const closed = worktree.waitForEvent('close')
    await worktree.keyboard.press('Enter').catch(() => undefined)
    await closed
    await expect(first.locator('#transcript .cm-content')).toContainText(`Worktree kept: ${kept}`)
    expect(worktreesOf(repo)).toEqual([repo, kept])
    expect(existsSync(kept)).toBe(true)

    // A second worktree, clean, closed with a yes: it is removed.
    await first.bringToFront()
    opened = app.waitForEvent('window')
    await first.keyboard.press('Control+x')
    await first.keyboard.press('5')
    await first.keyboard.press('w')
    await expect(first.locator('#palette-input .cm-content')).toBeFocused()
    await first.keyboard.type('Second task')
    await first.keyboard.press('Enter')
    const second = await opened
    await second.waitForLoadState('domcontentloaded')
    expect(worktreesOf(repo)).toEqual([repo, kept, removed])
    await closeNewestWindow(app)
    await expect
      .poll(() => candidates(second))
      .toEqual(['Keep the worktree *', 'Remove the worktree'])
    await second.keyboard.press('Control+n')
    await expect
      .poll(() => candidates(second))
      .toEqual(['Keep the worktree', 'Remove the worktree *'])
    await second.keyboard.press('Enter').catch(() => undefined)
    await expect.poll(() => worktreesOf(repo)).toEqual([repo, kept])
    expect(existsSync(removed)).toBe(false)
    await expect(first.locator('#transcript .cm-content')).toContainText(
      `Worktree removed: ${removed}`,
    )
  } finally {
    await app.close()
    rmSync(parent, { recursive: true, force: true })
  }
})
