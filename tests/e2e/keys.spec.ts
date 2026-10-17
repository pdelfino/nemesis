import { expect, test, type Page } from '@playwright/test'
import { launchNemesis } from './_launch'

interface DispatchedKey {
  readonly chord: string
  readonly command: string
}

interface TestWindow {
  readonly nemesis: {
    readonly dispatchLog?: () => Promise<readonly DispatchedKey[]>
  }
}

/** Reads the main process dispatch log through the test-only preload door (#59). */
async function dispatched(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const log = (await (globalThis as unknown as TestWindow).nemesis.dispatchLog?.()) ?? []
    return log.map((record) => `${record.chord} ${record.command}`)
  })
}

test('the Emacs keyscheme dispatches named commands', async () => {
  const app = await launchNemesis()
  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')

    // The palette command and the cancel command, the two the issue names.
    await page.keyboard.press('Alt+x')
    await page.keyboard.press('Control+g')
    await expect.poll(() => dispatched(page)).toEqual(['M-x execute-command', 'C-g keyboard-quit'])

    // A prefix map: C-x waits for the second stroke, then switches buffer.
    await page.keyboard.press('Control+x')
    await page.keyboard.press('b')
    await expect
      .poll(() => dispatched(page))
      .toEqual(['M-x execute-command', 'C-g keyboard-quit', 'C-x b switch-buffer'])
  } finally {
    await app.close()
  }
})
