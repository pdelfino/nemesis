import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type Page } from './_test'
import { launchApp } from './_launch'

/**
 * fan-out (#160): the prompt buffer's draft holds an instruction and three
 * items; one yes makes three worktrees on three branches and three
 * background sessions there, each with its own first prompt, listed under
 * one heading in the agents buffer. A list longer than `fanOutMax` is
 * refused whole, with nothing made.
 */

function agentLines(page: Page): Promise<string[]> {
  return page.locator('#agents .cm-line').allTextContents()
}

async function runCommand(page: Page, name: string): Promise<void> {
  await page.keyboard.press('Alt+x')
  await page.keyboard.type(name)
  await page.keyboard.press('Enter')
}

test('fan-out starts one background session per item, each in its own worktree, and refuses a list over the cap', async () => {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'nemesis-e2e-fan-out-')))
  const repo = join(parent, 'repo')
  mkdirSync(repo)
  const git = (...args: string[]): string =>
    execFileSync('git', args, { cwd: repo, encoding: 'utf8' })
  git('init', '-q', '-b', 'main')
  writeFileSync(join(repo, 'notes.txt'), 'alpha\n')
  git('add', 'notes.txt')
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-q', '-m', 'init')

  const { app } = await launchApp('nemesis-e2e-', [], { fanOutMax: 3 }, {}, repo)
  try {
    const first = await app.firstWindow()
    await first.waitForLoadState('domcontentloaded')
    await expect(first.locator('#prompt .cm-content')).toBeFocused()

    // The instruction, then one item per line, typed in the prompt buffer.
    await first.keyboard.type('Say hello')
    for (const item of ['alpha', 'beta', 'gamma']) {
      await first.keyboard.press('Enter')
      await first.keyboard.type(item)
    }
    // The draft reaches the main process a moment after the typing stops.
    await first.waitForTimeout(500)

    await runCommand(first, 'fan-out')
    await expect(first.locator('#palette-prompt')).toHaveText(
      'Start 3 sessions, each in its own worktree?',
    )
    await first.keyboard.type('Start the')
    await first.keyboard.press('Enter')

    // Three hidden windows, three worktrees on three branches.
    await expect
      .poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length))
      .toBe(4)
    expect(
      await app.evaluate(
        ({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((w) => w.isVisible()).length,
      ),
    ).toBe(1)
    for (const item of ['alpha', 'beta', 'gamma']) {
      expect(existsSync(`${repo}-${item}`)).toBe(true)
    }
    expect(git('branch', '--list', '--format=%(refname:short)').split('\n').sort()).toEqual([
      '',
      'alpha',
      'beta',
      'gamma',
      'main',
    ])

    // Listed under one heading, each finished with its own first prompt.
    await expect(first.locator('#agents')).toBeVisible()
    await expect
      .poll(async () => (await agentLines(first))[5])
      .toBe('Fan-out "Say hello": 3 sessions, 3 finished, 0 waiting, 0 failed')
    const folders = (await agentLines(first)).filter((line) => /^\s+\S/.test(line))
    expect(folders.slice(1).map((line) => line.trim())).toEqual([
      `${repo}-alpha`,
      `${repo}-beta`,
      `${repo}-gamma`,
    ])
    const transcripts = await Promise.all(
      app
        .windows()
        .filter((page) => page !== first)
        .map((page) => page.locator('#transcript').innerText()),
    )
    for (const [index, item] of ['alpha', 'beta', 'gamma'].entries()) {
      expect(transcripts.some((text) => text.includes(`Item ${index + 1} of 3: ${item}`))).toBe(
        true,
      )
    }
  } finally {
    await app.close()
    rmSync(parent, { recursive: true, force: true })
  }
})

test('fan-out refuses a list longer than fanOutMax whole, with nothing made', async () => {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'nemesis-e2e-fan-out-')))
  const repo = join(parent, 'repo')
  mkdirSync(repo)
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
  const { app } = await launchApp('nemesis-e2e-', [], { fanOutMax: 3 }, {}, repo)
  try {
    const first = await app.firstWindow()
    await first.waitForLoadState('domcontentloaded')
    await expect(first.locator('#prompt .cm-content')).toBeFocused()
    await first.keyboard.type('Say hello')
    for (const item of ['alpha', 'beta', 'gamma', 'delta']) {
      await first.keyboard.press('Enter')
      await first.keyboard.type(item)
    }
    await first.waitForTimeout(500)
    await runCommand(first, 'fan-out')
    await expect(first.locator('#help')).toBeVisible()
    await expect(first.locator('#help')).toContainText(
      'No sessions started: 4 items is more than the fanOutMax setting allows (3).',
    )
    for (const item of ['alpha', 'beta', 'gamma', 'delta']) {
      expect(existsSync(`${repo}-${item}`)).toBe(false)
    }
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1)
  } finally {
    await app.close()
    rmSync(parent, { recursive: true, force: true })
  }
})
