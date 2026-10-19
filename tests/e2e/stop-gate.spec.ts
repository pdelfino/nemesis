import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type Page } from './_test'
import { launchApp } from './_launch'

interface AgentEvent {
  readonly type: string
  readonly text?: string
  readonly exitCode?: number | null
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

async function prompts(page: Page): Promise<string[]> {
  return (await events(page)).flatMap((event) =>
    event.type === 'user-text' ? [event.text ?? ''] : [],
  )
}

async function exitCodes(page: Page): Promise<(number | null | undefined)[]> {
  return (await events(page)).flatMap((event) =>
    event.type === 'evidence' ? [event.exitCode] : [],
  )
}

/** The transcript's lines, as the DOM shows them: a folded body is not among them. */
function lines(page: Page): Promise<string[]> {
  return page.locator('#transcript .cm-line').allTextContents()
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

/**
 * The fake check: counts its runs in `dir`, red on the first, green from the
 * second on, and red at every run once `dir/always` exists.
 */
function check(dir: string): string {
  return `n=$(($(cat ${dir}/n 2>/dev/null || echo 0)+1)); echo $n > ${dir}/n; echo run $n; test ! -e ${dir}/always && test $n -ge 2`
}

// The guide's "gate the stop on the check" (#113): toggle-stop-gate puts
// `gate` in the mode line with the guide's words in the hint; a turn then
// ends with the check, run by the cockpit (no tool call of the agent), and a
// red one goes back as the next prompt with the evidence. Green ends the turn
// with the evidence block in the transcript. A check that stays red goes back
// as many times as the stopGateRetries setting says, then the turn ends with
// a notice.
test('the stop gate runs the check at the end of a turn, sends a red one back as the next prompt, and stops at the cap', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nemesis-gate-'))
  const command = check(dir)
  const { app } = await launchApp('nemesis-e2e-', [], { verify: command, stopGateRetries: 2 })
  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    const prompt = page.locator('#prompt .cm-content')
    const transcript = page.locator('#transcript .cm-content')
    const gate = page.locator('#stop-gate')
    const hint = page.locator('#modeline-hint')
    await expect(prompt).toBeFocused()
    await page.evaluate(() => {
      const w = globalThis as unknown as TestWindow
      w.__agentEvents = []
      w.nemesis.onAgentEvent((event) => w.__agentEvents?.push(event))
    })

    // Off by default: blank in the mode line.
    await expect(gate).toBeHidden()
    await runCommand(page, 'toggle-stop-gate')
    await expect(gate).toHaveText('gate')
    await expect(hint).toContainText('Stop gate: set the check as the goal')
    await expect
      .poll(() => lines(page))
      .toContain('Stop gate on: every turn ends with the check, up to 2 retries.')

    // Red, then green: two prompts, two evidence blocks, the second green.
    await expect(prompt).toBeFocused()
    await page.keyboard.type('fix the bug')
    await page.keyboard.press('Control+c')
    await page.keyboard.press('Control+c')
    await expect.poll(() => exitCodes(page)).toEqual([1, 0])
    await expect(transcript).toContainText('You said: The check failed, fix it:')
    const sent = await prompts(page)
    expect(sent).toHaveLength(2)
    expect(sent[0]).toBe('fix the bug')
    expect(sent[1]).toContain(`Evidence: `)
    expect(sent[1]).toContain('run 1')
    await expect(gate).toHaveText('gate 1/2')
    expect((await lines(page)).some((line) => line.startsWith('Evidence: '))).toBe(true)

    // Red at every run: the cap of two retries, then the turn ends with a notice.
    writeFileSync(join(dir, 'always'), '')
    await page.keyboard.type('another task')
    await page.keyboard.press('Control+c')
    await page.keyboard.press('Control+c')
    await expect
      .poll(() => lines(page))
      .toContain('Stop gate: the check still fails after 2 retries; the turn ends.')
    expect(await exitCodes(page)).toEqual([1, 0, 1, 1, 1])
    expect(await prompts(page)).toHaveLength(5)
    await expect(gate).toHaveText('gate 2/2')

    // Off again: the next turn ends without a check.
    await runCommand(page, 'toggle-stop-gate')
    await expect(gate).toBeHidden()
    await expect(prompt).toBeFocused()
    await page.keyboard.type('plain')
    await page.keyboard.press('Control+c')
    await page.keyboard.press('Control+c')
    await expect(transcript).toContainText('You said: plain')
    expect(await exitCodes(page)).toHaveLength(5)
  } finally {
    await app.close()
  }
})
