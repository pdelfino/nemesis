import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Page } from '../e2e/_test'
import { cleanUp, launchReal, realOnly, TURN_TIMEOUT } from './_real'

/*
 * The agents buffer against a real session (#162). M6 (#157, #158) was
 * proven on the mock SDK; here a real background session asks for Bash
 * from a hidden window, and the agents line follows it: `waits on you`
 * while the request is open, `finished` once the turn ends.
 *
 * Cost: one prompt, one Haiku turn of a few model calls (a ToolSearch for
 * the deferred tool when the model makes one, the Bash call, the reply).
 */

realOnly()

const MARKER = 'nemesis-real-agents'

function agentLines(page: Page): Promise<string[]> {
  return page.locator('#agents .cm-line').allTextContents()
}

/** The agents buffer's line for the second window, or '' while it has none. */
async function secondLine(page: Page): Promise<string> {
  return (await agentLines(page)).find((line) => line.startsWith('Window 2')) ?? ''
}

async function runCommand(page: Page, name: string): Promise<void> {
  await page.keyboard.press('Alt+x')
  await page.keyboard.type(name)
  await page.keyboard.press('Enter')
}

test('a real background session: the agents line waits on you for its Bash request, then reads finished', async () => {
  const real = await launchReal()
  const { app, page, work } = real
  try {
    const opened = app.waitForEvent('window')
    await runCommand(page, 'new-background-session')
    await expect(page.locator('#palette-prompt')).toHaveText('Background prompt:')
    await page.keyboard.type(
      `Use the Bash tool to run exactly this command: touch ${MARKER}. Then reply with one word.`,
    )
    await page.keyboard.press('Enter')
    const second = await opened

    // The request is open in a hidden window: the line says so.
    await expect(page.locator('#agents')).toBeVisible()
    await expect
      .poll(() => secondLine(page), { timeout: TURN_TIMEOUT })
      .toMatch(
        /^Window 2 \(background\) {2}session .+? +waits on you, for \d+s, [1-9]\d* tool calls?$/,
      )
    expect(existsSync(join(work, MARKER))).toBe(false)

    // open-agent shows it on the request; y answers, and every later request too.
    await expect(page.locator('#agents .cm-content')).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(page.locator('#palette-prompt')).toHaveText('Open session:')
    await page.keyboard.type('Window 2')
    await page.keyboard.press('Enter')
    await second.bringToFront()
    const deadline = Date.now() + TURN_TIMEOUT
    while (!/ finished, /.test(await secondLine(page))) {
      if (Date.now() > deadline) throw new Error(`Never finished: ${await secondLine(page)}`)
      if (await second.locator('#request').isVisible()) {
        await expect(second.locator('#request')).toBeFocused()
        await second.keyboard.press('y')
        // A next request can replace this one at once; the loop answers it too.
        await second.waitForTimeout(500)
      }
      await second.waitForTimeout(250)
    }

    // The command ran, and the line reads finished with the calls counted.
    expect(existsSync(join(work, MARKER))).toBe(true)
    expect(await secondLine(page)).toMatch(
      /^Window 2 +session .+? +finished, after \d+s, [1-9]\d* tool calls?$/,
    )
  } finally {
    await app.close()
    cleanUp(real.userData, work)
  }
})
