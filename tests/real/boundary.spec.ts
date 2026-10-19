import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type Page } from '../e2e/_test'
import { fixtureServer } from '../e2e/security/_harness'
import { cleanUp, launchReal, ofType, realOnly, resultOf, send, settle, turn } from './_real'

/*
 * The page boundary (#55, #132; SECURITY.org T4) against the real CLI and a
 * settings file that allows Bash, as a user's own settings may. The other
 * real specs put `ask` rules in the session's folder so the cockpit sees
 * every request; this one puts an `allow` rule there instead, the case where
 * only the boundary's PreToolUse hook stands between a page and a shell.
 *
 * Cost of one run: 3 prompts, each one Haiku turn of two to four calls.
 */

realOnly()

/** A throwaway folder whose project settings allow Bash, as the user's own may. */
function allowingFolder(): string {
  const work = realpathSync(mkdtempSync(join(tmpdir(), 'nemesis-real-allow-')))
  mkdirSync(join(work, '.claude'))
  writeFileSync(
    join(work, '.claude', 'settings.json'),
    `${JSON.stringify({ permissions: { allow: ['Bash'] } }, null, 2)}\n`,
  )
  return work
}

/** Opens a page buffer through the test-only door (#119); it takes the point. */
async function openPage(
  real: Awaited<ReturnType<typeof launchReal>>,
  url: string,
): Promise<string> {
  const opened = await real.app.evaluate(async (_main, target) => {
    const door = (
      globalThis as {
        __nemesisPages?: {
          open(url: string): Promise<{ bufferId: string; loadError: string | null }>
        }
      }
    ).__nemesisPages
    if (door === undefined) throw new Error('The app has no page door')
    return door.open(target)
  }, url)
  expect(opened.loadError).toBeNull()
  return opened.bufferId
}

/** Walks back to the prompt buffer with C-x b, the page left open. */
async function backToPrompt(page: Page): Promise<void> {
  const prompt = page.locator('#prompt .cm-content')
  await expect
    .poll(async () => {
      const focused = await expect(prompt)
        .toBeFocused({ timeout: 500 })
        .then(
          () => true,
          () => false,
        )
      if (focused) return true
      await page.keyboard.press('Control+x')
      await page.keyboard.press('b')
      return false
    })
    .toBe(true)
}

const BASH = (tag: string): string =>
  `Use the Bash tool to run exactly this command: echo ${tag}. Then reply with one word.`

test('with Bash allowed by the settings, the page boundary still asks while a page is open, and denies unasked while one is current', async () => {
  const fixtures = await fixtureServer()
  const real = await launchReal(allowingFolder())
  try {
    const { page } = real

    // The baseline: no page open, so the allow rule answers and the cockpit is never asked.
    const free = await turn(page, BASH('nemesis-boundary-free'), () => 'n')
    expect(free.filter((request) => request.toolName === 'Bash')).toEqual([])
    const ran = (await ofType(page, 'tool-result')).find((event) =>
      (event.text ?? '').includes('nemesis-boundary-free'),
    )
    expect(ran?.isError, 'the allow rule ran Bash with no page open').toBe(false)

    // A page open but not current: the hook answers ask, so the cockpit is asked despite the allow rule.
    await openPage(real, fixtures.url('injection.html'))
    await backToPrompt(page)
    const asked = await turn(page, BASH('nemesis-boundary-asked'), () => 'n')
    const request = asked.find((one) => one.toolName === 'Bash')
    expect(request, JSON.stringify(asked)).toBeDefined()
    if (request === undefined) return
    expect(await resultOf(page, request)).toMatchObject({ isError: true })

    // A page current when the call comes: denied with no question at all.
    const before = (await ofType(page, 'turn-end')).length
    const requestsBefore = (await ofType(page, 'permission-request')).length
    await send(page, BASH('nemesis-boundary-current'))
    await openPage(real, fixtures.url('injection.html'))
    await settle(page, before, () => 'n')
    expect(await ofType(page, 'permission-request')).toHaveLength(requestsBefore)
    const denied = (await ofType(page, 'tool-result')).filter((event) =>
      (event.text ?? '').includes('denied without a question'),
    )
    expect(denied.length, 'the hook denied the call while the page was current').toBeGreaterThan(0)
    const leaked = (await ofType(page, 'tool-result')).find(
      (event) => event.isError === false && (event.text ?? '').includes('nemesis-boundary-current'),
    )
    expect(leaked).toBeUndefined()
  } finally {
    await real.app.close()
    cleanUp(real.userData, real.work)
    await fixtures.close()
  }
})
