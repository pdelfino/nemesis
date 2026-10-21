import { expect, test, type Page } from '../e2e/_test'
import {
  cleanUp,
  events,
  launchReal,
  ofType,
  realOnly,
  resultOf,
  send,
  settle,
  TURN_TIMEOUT,
  type AgentEvent,
} from './_real'

/*
 * Steering a running turn (#194) on the real CLI, with Haiku. The SDK's user
 * message carries `priority`, and the cockpit's steer-prompt sends `next`:
 * the claim under test is that the CLI hands such a message to the turn that
 * is running, after the tool call under way, instead of opening a turn of
 * its own. The turn runs `sleep 5` through Bash; while it sleeps the spec
 * steers, and the turn's final text must answer the steered prompt before
 * that turn ends.
 *
 * Cost: one test, two prompts in one Haiku turn of a few model calls.
 */

realOnly()

/** The word only the steered prompt asks for. */
const WORD = 'PINEAPPLE-STEER'

interface PromptWindow {
  readonly nemesis: { readonly promptState: () => Promise<{ readonly draft: string }> }
}

function promptDraft(page: Page): Promise<string> {
  return page.evaluate(
    async () => (await (globalThis as unknown as PromptWindow).nemesis.promptState()).draft,
  )
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

test('a prompt steered during a running Bash call is answered by that turn before it ends', async () => {
  const real = await launchReal()
  try {
    const { page } = real
    await send(
      page,
      'Use the Bash tool to run exactly this command: sleep 5. When it finishes, reply with one short sentence.',
    )

    // y on the Bash request starts the sleep.
    await expect
      .poll(async () => (await ofType(page, 'permission-request')).length, {
        timeout: TURN_TIMEOUT,
      })
      .toBeGreaterThan(0)
    const [request] = await ofType(page, 'permission-request')
    expect(request?.toolName).toBe('Bash')
    expect(String(request?.input?.['command'])).toContain('sleep 5')
    await expect(page.locator('#request')).toBeFocused()
    await page.keyboard.press('y')

    // While it sleeps: steer.
    await expect(page.locator('#prompt .cm-content')).toBeFocused()
    await page.keyboard.type(`Also end your final reply with the exact word ${WORD}.`)
    await expect.poll(() => promptDraft(page)).toContain(WORD)
    expect(await ofType(page, 'turn-end')).toHaveLength(0)
    await runCommand(page, 'steer-prompt')
    await expect
      .poll(async () => (await ofType(page, 'user-text')).some((event) => event.steered === true))
      .toBe(true)
    // The steer reached the turn while the sleep still ran.
    const ran = request === undefined ? undefined : await resultOf(page, request)
    expect(ran, 'the sleep had already finished when the steer was sent').toBeUndefined()

    await settle(page, 0, () => 'y')
    const all = await events(page)
    const steeredAt = all.findIndex((event) => event.type === 'user-text' && event.steered === true)
    const endAt = all.findIndex((event) => event.type === 'turn-end')
    expect(steeredAt).toBeGreaterThan(-1)
    expect(endAt).toBeGreaterThan(steeredAt)
    const end = all[endAt]
    expect(end?.isError).toBe(false)
    // The sleep was not cut off by the steer.
    const slept = request === undefined ? undefined : await resultOf(page, request)
    expect(slept?.isError).toBe(false)
    // The first turn to end answers the steered prompt: its text before the
    // turn-end carries the word, and so does its result.
    const replies = all
      .slice(steeredAt, endAt)
      .filter((event): event is AgentEvent & { text: string } => event.type === 'assistant-text')
      .map((event) => event.text)
    expect(replies.join('\n'), JSON.stringify(all.slice(steeredAt))).toContain(WORD)
  } finally {
    await real.app.close()
    cleanUp(real.userData, real.work)
  }
})
