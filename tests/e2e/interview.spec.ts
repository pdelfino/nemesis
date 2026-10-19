import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Page } from './_test'
import { launchApp } from './_launch'

interface AgentEvent {
  readonly type: string
  readonly text?: string
  readonly sessionId?: string
  readonly parentToolUseId?: string
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

async function userTexts(page: Page): Promise<string[]> {
  return (await events(page))
    .filter((event) => event.type === 'user-text')
    .map((event) => event.text ?? '')
}

/** The transcript's lines, as the DOM shows them: a folded body is not among them. */
function lines(page: Page): Promise<string[]> {
  return page.locator('#transcript .cm-line').allTextContents()
}

/** A folded header line carries the fold placeholder after its text, so it is matched by its start. */
function headerOf(shown: readonly string[], text: string): string | undefined {
  return shown.find((line) => line === text || line.startsWith(`${text}\u2026`))
}

/** The spec buffer's lines, as the editor shows them. */
function specLines(page: Page): Promise<string[]> {
  return page.locator('#spec .cm-line').allTextContents()
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

/** Answers the free-text read a command opened. */
async function answerRead(page: Page, prompt: string, text: string): Promise<void> {
  await expect(page.locator('#palette-prompt')).toHaveText(prompt)
  await expect(page.locator('#palette-doc')).toHaveText('RET answers with the text typed.')
  await page.keyboard.type(text)
  await page.keyboard.press('Enter')
}

/** The prompts a session folder's log holds, in order. */
function promptsIn(sessionsDir: string, id: string): string[] {
  const log = join(sessionsDir, id, 'events.jsonl')
  if (!existsSync(log)) return []
  return readFileSync(log, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as AgentEvent)
    .filter((event) => event.type === 'user-text')
    .map((event) => event.text ?? '')
}

const SPEC_PATH = join(process.cwd(), 'SPEC.md')

// The guide's communication practices as commands (#85): ask-codebase sends
// the question as typed, investigate wraps it in the guide's words and the
// subagent's work shows as collapsed child blocks, interview sends the
// guide's interview prompt, renders the question rounds, and the spec the
// agent writes opens as a buffer whose one key starts a fresh session with
// the spec as its first message.
test('ask-codebase, investigate with child blocks, interview to a spec buffer, and a fresh session from the spec', async () => {
  const { app, sessionsDir } = await launchApp()
  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    const prompt = page.locator('#prompt .cm-content')
    const transcript = page.locator('#transcript .cm-content')
    const modeline = page.locator('#buffer-list')
    const request = page.locator('#request')
    const spec = page.locator('#spec')
    await expect(prompt).toBeFocused()
    await page.evaluate(() => {
      const w = globalThis as unknown as TestWindow
      w.__agentEvents = []
      w.nemesis.onAgentEvent((event) => w.__agentEvents?.push(event))
    })

    // ask-codebase: the question goes as typed, nothing around it.
    await runCommand(page, 'ask-codebase')
    await answerRead(page, 'Ask the codebase:', 'how does logging work')
    await expect(transcript).toContainText('You said: how does logging work')
    expect(await userTexts(page)).toEqual(['how does logging work'])

    // investigate: the guide's phrasing around the question; the Agent call
    // is a block of the main thread, what happened inside the subagent is
    // three child blocks with their bodies folded, and the main reply follows.
    await runCommand(page, 'investigate')
    await answerRead(page, 'Investigate:', 'how tokens refresh')
    await expect(transcript).toContainText('Investigated: how tokens refresh')
    expect((await userTexts(page)).at(-1)).toBe('Use subagents to investigate how tokens refresh')
    const shown = await lines(page)
    expect(headerOf(shown, 'Tool: Agent')).toBeDefined()
    expect(headerOf(shown, 'Subagent tool: Read')).toBeDefined()
    expect(headerOf(shown, 'Subagent result: Read')).toBeDefined()
    expect(headerOf(shown, 'Subagent: Claude')).toBeDefined()
    expect(headerOf(shown, 'Result: Agent')).toBeDefined()
    expect(shown).not.toContain('Found 2 files about how tokens refresh')
    expect(shown).not.toContain('alpha')
    await expect(page.locator('#transcript .cm-line.tr-child')).toHaveCount(3)
    const inside = (await events(page)).filter((event) => event.parentToolUseId === 'mock-tool-2')
    expect(inside.map((event) => event.type)).toEqual(['tool-use', 'tool-result', 'assistant-text'])
    // The main thread's events carry no parent.
    expect(
      (await events(page)).filter(
        (event) => event.type === 'assistant-text' && event.parentToolUseId === undefined,
      ),
    ).toHaveLength(2)

    // interview: the guide's prompt with the description in it; the question
    // round is the request buffer of #63, a digit answers it; the Write of
    // the spec asks like any tool, y allows it, and the spec buffer opens
    // with the point and the text.
    await runCommand(page, 'interview')
    await answerRead(page, 'Interview me about:', 'a calendar widget')
    await expect(request).toBeVisible()
    await expect(modeline).toHaveText('Transcript Prompt [Question: Priority]')
    expect((await userTexts(page)).at(-1)).toMatch(
      /^I want to build a calendar widget\. Interview me in detail using the AskUserQuestion tool\.\n/,
    )
    expect((await userTexts(page)).at(-1)).toContain(
      "Keep interviewing until we've covered everything, then write a complete spec to SPEC.md.",
    )
    await page.keyboard.press('2')
    await expect.poll(() => lines(page)).toContain('Answered Priority: beta')
    await expect(modeline).toHaveText('Transcript Prompt [Permission: Write]')
    await expect(request).toBeFocused()
    await page.keyboard.press('y')
    await expect(spec).toBeVisible()
    await expect(modeline).toHaveText('Transcript Prompt [Spec: SPEC.md]')
    await expect(page.locator('#spec .cm-content')).toBeFocused()
    await expect(page.locator('#spec-file')).toHaveText(SPEC_PATH)
    await expect(page.locator('#spec-keys')).toHaveText(
      'C-c C-c clears the context and starts a fresh session with this spec as its first message',
    )
    await expect.poll(() => specLines(page)).toContain('# Spec: a calendar widget')
    expect(await specLines(page)).toContain('- Priority: beta')
    await expect(transcript).toContainText('Spec written to SPEC.md.')
    expect(await lines(page)).toContain(
      `Spec written to ${SPEC_PATH}: C-c C-c in the spec buffer starts a fresh session with it as the first message.`,
    )
    // The key in the spec buffer typed nothing and sent nothing.
    expect(await userTexts(page)).toHaveLength(3)

    // C-c C-c in the spec buffer: the buffer closes, the point is back in
    // the prompt, the session is dropped and a fresh one starts with the spec
    // as its first message; the folder on disk says the same.
    await page.keyboard.press('Control+c')
    await page.keyboard.press('Control+c')
    await expect(spec).toBeHidden()
    await expect(modeline).toHaveText('Transcript [Prompt]')
    await expect(prompt).toBeFocused()
    await expect
      .poll(() => lines(page))
      .toContain(
        `Fresh session from the spec in ${SPEC_PATH}: the context is cleared and the spec is the first message.`,
      )
    expect(await lines(page)).toContain('New task: the next prompt starts a fresh session.')
    await expect(transcript).toContainText('You said: Implement the spec below.')
    await expect
      .poll(async () =>
        (await events(page))
          .filter((event) => event.type === 'started')
          .map((event) => event.sessionId),
      )
      .toEqual(['mock-session', 'mock-session-2'])
    const first = (await userTexts(page)).at(-1) ?? ''
    expect(first.startsWith(`Implement the spec below. It was written to ${SPEC_PATH}`)).toBe(true)
    expect(first).toContain('# Spec: a calendar widget')
    expect(first).toContain('- Priority: beta')
    await expect.poll(() => promptsIn(sessionsDir, 'mock-session-2')).toEqual([first])
    expect(promptsIn(sessionsDir, 'mock-session')).toHaveLength(3)
    // The spec file itself was never touched by the cockpit: the mock writes nothing.
    expect(existsSync(SPEC_PATH)).toBe(false)
  } finally {
    await app.close()
  }
})
