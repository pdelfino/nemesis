import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { launchApp } from './_launch'

interface AgentEvent {
  readonly type: string
  readonly text?: string
  readonly command?: string
  readonly source?: string
  readonly exitCode?: number | null
  readonly signal?: string | null
  readonly durationMs?: number
  readonly output?: string
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

/** The transcript's lines, as the DOM shows them: a folded body is not among them. */
function lines(page: Page): Promise<string[]> {
  return page.locator('#transcript .cm-line').allTextContents()
}

/** A folded header line carries the fold placeholder after its text, so it is matched by its start. */
function lineStarting(shown: readonly string[], prefix: string): string | undefined {
  return shown.find((line) => line.startsWith(prefix))
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

/** The events a session folder's log holds, in order. */
function eventsIn(sessionsDir: string, id: string): AgentEvent[] {
  const log = join(sessionsDir, id, 'events.jsonl')
  if (!existsSync(log)) return []
  return readFileSync(log, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as AgentEvent)
}

/** The fake check: output on both streams and a telling exit code, through the user's shell. */
const CHECK = 'echo check output; echo check error 1>&2; exit 3'

// The guide's first practice as keys (#81): C-c C-v runs the check the
// settings name (no issue is attached, so the issue source is skipped) with
// the user's permissions, outside the agent, and the output lands as an
// evidence block folded under a header with the exit code; a test run the
// agent makes through its shell tool is evidence too; attach-check adds a
// criterion to the prompt from two reads, the verify command as the
// candidate for the check.
test('verify runs the settings check into an evidence block with its exit code, a test run of the agent is evidence, attach-check adds a criterion to the prompt', async () => {
  const { app, sessionsDir } = await launchApp('nemesis-e2e-', [], { verify: CHECK })
  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    const prompt = page.locator('#prompt .cm-content')
    const transcript = page.locator('#transcript .cm-content')
    const modeline = page.locator('#buffer-list')
    const request = page.locator('#request')
    await expect(prompt).toBeFocused()
    await page.evaluate(() => {
      const w = globalThis as unknown as TestWindow
      w.__agentEvents = []
      w.nemesis.onAgentEvent((event) => w.__agentEvents?.push(event))
    })

    // A first prompt, so the session has a folder for the evidence to land in.
    await page.keyboard.type('hello')
    await page.keyboard.press('Control+c')
    await page.keyboard.press('Control+c')
    await expect(transcript).toContainText('You said: hello')

    // C-c C-v: the notice names the command and the source; the evidence
    // block follows, folded, the exit code and the duration in its header.
    await page.keyboard.press('Control+c')
    await page.keyboard.press('Control+v')
    await expect.poll(() => lines(page)).toContain(`Verifying: ${CHECK} (from the settings)`)
    await expect
      .poll(async () => lineStarting(await lines(page), `Evidence: ${CHECK} (exit 3, `))
      .toMatch(/^Evidence: .* \(exit 3, \d+\.\ds\)…$/)
    expect(await lines(page)).not.toContain('check output')
    const evidence = (await events(page)).find((event) => event.type === 'evidence')
    expect(evidence).toMatchObject({
      command: CHECK,
      source: 'settings',
      exitCode: 3,
      signal: null,
    })
    expect(evidence?.output).toBe('check output\ncheck error\n')
    expect(evidence?.durationMs).toBeGreaterThanOrEqual(0)
    // TAB on the header unfolds the output, so it is read on demand.
    await page.keyboard.press('Control+x')
    await page.keyboard.press('b')
    await expect(page.locator('#transcript .cm-content')).toBeFocused()
    const header = page.locator('#transcript .cm-line', { hasText: `Evidence: ${CHECK}` })
    await header.click()
    await page.keyboard.press('Tab')
    await expect.poll(() => lines(page)).toContain('check output')
    expect(await lines(page)).toContain('check error')
    await page.keyboard.press('Control+x')
    await page.keyboard.press('b')
    await expect(prompt).toBeFocused()
    // The agent saw nothing of it: no prompt went out, and the folder on disk has the evidence.
    expect((await events(page)).filter((event) => event.type === 'user-text')).toHaveLength(1)
    await expect
      .poll(() =>
        eventsIn(sessionsDir, 'mock-session').filter((event) => event.type === 'evidence'),
      )
      .toHaveLength(1)
    expect(readFileSync(join(sessionsDir, 'mock-session', 'session.org'), 'utf8')).toContain(
      `** Evidence: ${CHECK} (exit 3, `,
    )

    // A check the agent runs through its shell tool, allowed with y, is evidence too.
    await page.keyboard.type('check: auth')
    await page.keyboard.press('Control+c')
    await page.keyboard.press('Control+c')
    await expect(request).toBeVisible()
    await expect(modeline).toHaveText('Transcript Prompt [Permission: Bash]')
    await page.keyboard.press('y')
    await expect(transcript).toContainText('Ran the auth tests.')
    const shown = await lines(page)
    expect(lineStarting(shown, 'Evidence: npm test -- auth (passed)')).toBeDefined()
    expect(shown.some((line) => line.includes('Tests  3 passed'))).toBe(false)
    expect(lineStarting(shown, 'Result: Bash')).toBeUndefined()

    // attach-check: the cases as free text, then the check, where the one
    // C-c C-v would run is the candidate; the criterion lands in the prompt
    // and the point is there.
    await runCommand(page, 'attach-check')
    await expect(page.locator('#palette-prompt')).toHaveText('Example cases (input is output):')
    await page.keyboard.type('a@b.com is true, bad is false')
    await page.keyboard.press('Enter')
    await expect(page.locator('#palette-prompt')).toHaveText('Run after implementing:')
    await expect(page.locator('#palette-candidates li[aria-selected="true"]')).toHaveText(CHECK)
    await expect(page.locator('#palette-doc')).toHaveText(
      'The check C-c C-v runs, from the settings. Type another to use it instead.',
    )
    await page.keyboard.press('Enter')
    await expect(prompt).toHaveText(
      `Example cases: a@b.com is true, bad is false. Run \`${CHECK}\` after implementing, show its output, and iterate until it passes.`,
    )
    await expect(page.locator('#prompt-note')).toHaveText('Added to the prompt.')
    await expect(prompt).toBeFocused()
    // It is sent as typed.
    await page.keyboard.press('Control+c')
    await page.keyboard.press('Control+c')
    await expect(transcript).toContainText('You said: Example cases: a@b.com is true')
    await expect(prompt).toHaveText('')
  } finally {
    await app.close()
  }
})
