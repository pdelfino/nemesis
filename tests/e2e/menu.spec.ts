import { expect, test } from '@playwright/test'
import { launchNemesis } from './_launch'

/**
 * The application menu, live (#30): the app has a `Commands` submenu whose
 * items carry the chord as text and no accelerator, and clicking the
 * `switch-buffer` item in the main process moves the brackets in the
 * modeline, so a menu click is a command invocation like a key press.
 */
test('the Commands menu lists the commands and a click runs one', async () => {
  const app = await launchNemesis()
  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await expect(page.locator('#modeline #buffer-list')).toHaveText('Transcript [Prompt]')

    const commands = await app.evaluate(({ Menu }) => {
      const menu = Menu.getApplicationMenu()
      const submenu = menu?.items.find((item) => item.label === 'Commands')?.submenu
      return (submenu?.items ?? []).map((item) => ({
        id: item.id,
        label: item.label,
        // A live item reports no accelerator as null.
        accelerator: item.accelerator ?? null,
      }))
    })
    expect(commands.length).toBeGreaterThan(5)
    const switchBuffer = commands.find((item) => item.id === 'switch-buffer')
    expect(switchBuffer?.label).toBe('Switch buffer    C-x b')
    for (const item of commands) expect(item.accelerator).toBeNull()

    // A click in the main process runs the command: the other buffer is current.
    await app.evaluate(({ Menu }) => {
      const item = Menu.getApplicationMenu()?.getMenuItemById('switch-buffer')
      if (!item) throw new Error('No switch-buffer item')
      item.click()
    })
    await expect(page.locator('#modeline #buffer-list')).toHaveText('[Transcript] Prompt')
  } finally {
    await app.close()
  }
})
