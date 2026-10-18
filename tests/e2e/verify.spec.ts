import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { expect, test, type Page } from './_test'
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

/** The fake check: output on both streams and a telling exit code, through the user's shell. */
const CHECK = 'echo check output; echo check error 1>&2; exit 3'

/** The check the fixture issue's Verify section names: remote text, confirmed before it runs (#98). */
const ISSUE_CHECK = 'echo issue evidence; exit 5'

/**
 * A folder with a fake `gh` first on the PATH: attach-issue runs `gh issue
 * view`, and this one answers with the fixture issue whatever the number.
 */
function fakeGh(): string {
  const bin = mkdtempSync(join(tmpdir(), 'nemesis-gh-'))
  mkdirSync(join(bin, 'bin'))
  writeFileSync(
    join(bin, 'issue.json'),
    JSON.stringify({
      number: 98,
      title: 'Confirm the check',
      body: `## Why\nRemote text.\n\n## Verify\n- \`${ISSUE_CHECK}\` prints the evidence.\n`,
    }),
  )
  writeFileSync(join(bin, 'bin', 'gh'), '#!/bin/sh\ncat "$(dirname "$0")/../issue.json"\n', {
    mode: 0o755,
  })
  return join(bin, 'bin')
}

// The guide's first practice as keys (#81): C-c C-v runs the check the
// settings name (no issue is attached, so the issue source is skipped) with
// the user's permissions, outside the agent, and the output lands as an
// evidence block folded under a header with the exit code; a test run the
// agent makes through its shell tool is evidence too; attach-check adds a
// criterion to the prompt from two reads, the verify command as the
// candidate for the check. Once an issue is attached, its command is remote
// text: the key asks in the prompt buffer with "Do not run" first, a RET
// refuses, the yes runs it and holds for the next press (#98).
test('verify runs the settings check into an evidence block with its exit code, a test run of the agent is evidence, attach-check adds a criterion to the prompt, an attached issue is confirmed before it runs', async () => {
  const { app, sessionsDir } = await launchApp(
    'nemesis-e2e-',
    [],
    { verify: CHECK },
    { PATH: `${fakeGh()}${delimiter}${process.env['PATH'] ?? ''}` },
  )
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

    // attach-issue, through the fake gh: the notice names the command.
    await runCommand(page, 'attach-issue')
    await expect(page.locator('#palette-prompt')).toHaveText('Attach issue:')
    await page.keyboard.type('98')
    await page.keyboard.press('Enter')
    await expect
      .poll(() => lines(page))
      .toContain(`Attached issue #98: Confirm the check. C-c C-v runs its check: ${ISSUE_CHECK}.`)
    await expect(prompt).toBeFocused()

    // C-c C-v asks, the exact command in the prompt line and "Do not run"
    // highlighted: RET refuses, nothing runs, no evidence lands.
    const palette = page.locator('#palette')
    const issueEvidence = async (): Promise<number> =>
      (await events(page)).filter((event) => event.type === 'evidence' && event.source === 'issue')
        .length
    await page.keyboard.press('Control+c')
    await page.keyboard.press('Control+v')
    await expect(palette).toBeVisible()
    await expect(page.locator('#palette-prompt')).toHaveText(
      `Run the attached issue's check in a shell? ${ISSUE_CHECK}`,
    )
    expect(await candidates(page)).toEqual(['Do not run *', 'Run it with your permissions'])
    await page.keyboard.press('Enter')
    await expect(palette).toBeHidden()
    await expect.poll(() => lines(page)).toContain(`Not run: ${ISSUE_CHECK}`)
    expect(await lines(page)).not.toContain(`Verifying: ${ISSUE_CHECK} (from the attached issue)`)
    expect(await issueEvidence()).toBe(0)
    await expect(prompt).toBeFocused()

    // A second C-c C-v asks again; the yes candidate runs it into an evidence block.
    await page.keyboard.press('Control+c')
    await page.keyboard.press('Control+v')
    await expect(palette).toBeVisible()
    await page.keyboard.press('Control+n')
    expect(await candidates(page)).toEqual(['Do not run', 'Run it with your permissions *'])
    await page.keyboard.press('Enter')
    await expect
      .poll(() => lines(page))
      .toContain(`Verifying: ${ISSUE_CHECK} (from the attached issue)`)
    await expect
      .poll(async () => lineStarting(await lines(page), `Evidence: ${ISSUE_CHECK} (exit 5, `))
      .toMatch(/^Evidence: .* \(exit 5, \d+\.\ds\)…$/)
    await expect.poll(issueEvidence).toBe(1)
    expect((await events(page)).find((event) => event.source === 'issue')).toMatchObject({
      command: ISSUE_CHECK,
      exitCode: 5,
      output: 'issue evidence\n',
    })
    await expect(prompt).toBeFocused()

    // The yes holds for the session: a third press runs without a question.
    await page.keyboard.press('Control+c')
    await page.keyboard.press('Control+v')
    await expect.poll(issueEvidence).toBe(2)
    await expect(palette).toBeHidden()
  } finally {
    await app.close()
  }
})
