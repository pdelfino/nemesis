import { expect, test, type Page } from './_test'
import { launchNemesis } from './_launch'

interface AgentEvent {
  readonly type: string
  readonly text?: string
  readonly mode?: string
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

async function ofType(page: Page, type: string): Promise<AgentEvent[]> {
  return (await events(page)).filter((event) => event.type === type)
}

/** The transcript's lines, as the DOM shows them. */
function lines(page: Page): Promise<string[]> {
  return page.locator('#transcript .cm-line').allTextContents()
}

/** The plan buffer's lines, as the editor shows them. */
function planLines(page: Page): Promise<string[]> {
  return page.locator('#plan .cm-line').allTextContents()
}

/** Types a prompt into the prompt buffer and sends it with C-c C-c. */
async function send(page: Page, text: string): Promise<void> {
  await expect(page.locator('#prompt .cm-content')).toBeFocused()
  await page.keyboard.type(text)
  await page.keyboard.press('Control+c')
  await page.keyboard.press('Control+c')
}

async function togglePlanMode(page: Page): Promise<void> {
  await page.keyboard.press('Control+c')
  await page.keyboard.press('Control+p')
}

const REMINDER = 'Plan mode: small, clear changes skip planning; C-c C-p turns it off again.'

// The guide's "explore first, then plan, then code" as affordances (#82):
// C-c C-p toggles plan mode and the mode line shows the mode at all times,
// the plan the agent asks to leave plan mode with opens as an editable
// buffer, C-c C-c approves it as edited and the session goes on in
// execution mode with the edited plan, C-c C-k rejects it with the edited
// text as feedback, and the guide's callout shows once per session.
test('C-c C-p toggles plan mode in the mode line, a plan is an editable buffer, C-c C-c approves it edited, C-c C-k rejects it with feedback', async () => {
  const app = await launchNemesis()
  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    const prompt = page.locator('#prompt .cm-content')
    const modeline = page.locator('#buffer-list')
    const mode = page.locator('#permission-mode')
    const hint = page.locator('#modeline-hint')
    const plan = page.locator('#plan')
    await expect(prompt).toBeFocused()
    await page.evaluate(() => {
      const w = globalThis as unknown as TestWindow
      w.__agentEvents = []
      w.nemesis.onAgentEvent((event) => w.__agentEvents?.push(event))
    })

    // The mode line shows the mode before any session exists, and the key
    // toggles it. The callout comes with the first toggle on, and only then.
    await expect(mode).toHaveText('default')
    await expect(hint).toHaveText('')
    await togglePlanMode(page)
    await expect(mode).toHaveText('plan')
    await expect(hint).toHaveText(REMINDER)
    await togglePlanMode(page)
    await expect(mode).toHaveText('default')
    await togglePlanMode(page)
    await expect(mode).toHaveText('plan')
    expect(await ofType(page, 'nudge')).toEqual([{ type: 'nudge', text: REMINDER }])
    expect(await lines(page)).toContain(REMINDER)

    // The session starts in plan mode, says so, and the mock asks to leave
    // it with a plan: the plan buffer opens next to the transcript with the
    // point and the text, and the prompt is cleared of the callout.
    await send(page, 'plan: add a test')
    await expect(hint).toHaveText('')
    await expect(plan).toBeVisible()
    await expect(modeline).toHaveText('Transcript Prompt [Plan]')
    await expect(page.locator('#plan .cm-content')).toBeFocused()
    await expect
      .poll(() => planLines(page))
      .toEqual(['# Plan', '', '1. add a test', '2. Run the gate', ''])
    await expect(page.locator('#plan-keys')).toHaveText(
      'C-c C-c approves the plan as it reads here, C-c C-k rejects it with this text as feedback',
    )
    expect(await lines(page)).toContain(
      'Session started: claude-mock-1, plan mode, in ' + process.cwd(),
    )
    expect(await lines(page)).toContain(
      'Plan received: C-c C-c in the plan buffer approves it as edited, C-c C-k rejects it with the text as feedback.',
    )

    // Edit a line of the plan, then approve: the buffer closes, the point is
    // back in the prompt, the session leaves plan mode and goes on with the
    // edited plan.
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('End')
    await page.keyboard.type(' in tests/unit')
    await expect.poll(() => planLines(page)).toContain('1. add a test in tests/unit')
    await page.keyboard.press('Control+c')
    await page.keyboard.press('Control+c')
    await expect(plan).toBeHidden()
    await expect(modeline).toHaveText('Transcript [Prompt]')
    await expect(prompt).toBeFocused()
    await expect(mode).toHaveText('default')
    await expect
      .poll(() => lines(page))
      .toContain('Plan approved as edited: the session leaves plan mode and starts the work.')
    await expect(page.locator('#transcript .cm-content')).toContainText(
      'Approved plan, as you edited it:',
    )
    expect(await lines(page)).toContain('1. add a test in tests/unit')
    expect(await lines(page)).toContain('Permission mode: default')
    // Nothing was sent as a prompt by the approval key.
    expect((await ofType(page, 'user-text')).map((event) => event.text)).toEqual([
      'plan: add a test',
    ])
    // The session goes on in execution mode: an ordinary prompt is answered as before.
    await send(page, 'now do it')
    await expect(page.locator('#transcript .cm-content')).toContainText('You said: now do it')
    await expect(mode).toHaveText('default')

    // Back in plan mode, with no second callout: a plan rejected with C-c C-k
    // goes back as feedback with the edits, and the mode stays plan.
    await togglePlanMode(page)
    await expect(mode).toHaveText('plan')
    expect(await ofType(page, 'nudge')).toHaveLength(1)
    await send(page, 'plan: rename the module')
    await expect(plan).toBeVisible()
    await expect(page.locator('#plan .cm-content')).toBeFocused()
    await expect.poll(() => planLines(page)).toContain('1. rename the module')
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('End')
    await page.keyboard.type(', but keep the old name exported')
    await page.keyboard.press('Control+c')
    await page.keyboard.press('Control+k')
    await expect(plan).toBeHidden()
    await expect(prompt).toBeFocused()
    await expect(mode).toHaveText('plan')
    await expect
      .poll(() => lines(page))
      .toContain('Plan rejected: the edited text went back as feedback; still in plan mode.')
    await expect
      .poll(async () => (await ofType(page, 'assistant-text')).at(-1)?.text ?? '')
      .toContain('1. rename the module, but keep the old name exported')
    expect((await ofType(page, 'assistant-text')).at(-1)?.text).toContain(
      'Plan sent back with feedback:\nThe user rejected the plan in the cockpit.',
    )
    // The compact key sent nothing to the prompt path.
    expect((await ofType(page, 'user-text')).map((event) => event.text)).toEqual([
      'plan: add a test',
      'now do it',
      'plan: rename the module',
    ])
    expect((await ofType(page, 'permission-mode')).map((event) => event.mode)).toEqual([
      'plan',
      'default',
      'plan',
      'default',
      'plan',
    ])
  } finally {
    await app.close()
  }
})
