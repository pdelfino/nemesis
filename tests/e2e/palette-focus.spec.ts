import { expect, test } from './_test'
import { launchNemesis } from './_launch'
import { fixtureServer } from './security/_harness'

/**
 * The palette keeps the keyboard while a read is open. A page buffer pushes
 * the buffer list on its own events, a new title among them, and every buffer
 * module focuses its element when the list changes and its buffer is current;
 * before the guard in src/renderer/palette.ts, a page renaming itself while
 * M-x was open moved the focus to the page section and the rest of what was
 * typed was lost (found by full-screen.spec.ts, 2026-OCTOBER-19).
 */
test('a page renaming itself while M-x is open leaves the keyboard in the palette', async () => {
  const fixtures = await fixtureServer()
  const app = await launchNemesis()
  try {
    const window = await app.firstWindow()
    await window.waitForLoadState('domcontentloaded')
    const input = window.locator('#palette-input .cm-content')

    // A page buffer, current.
    await window.keyboard.press('Control+x')
    await window.keyboard.press('b')
    await window.keyboard.press('Control+x')
    await window.keyboard.press('Control+f')
    await expect(input).toBeFocused()
    const url = fixtures.url('node-probe.html')
    await window.keyboard.type(url)
    await window.keyboard.press('Enter')
    await expect.poll(() => app.windows().map((one) => one.url())).toContain(url)
    const view = app.windows().find((one) => one.url() === url)
    if (view === undefined) throw new Error('no page view')
    await expect(view).toHaveTitle('node probe')

    // M-x, then the page renames itself, which pushes the buffer list.
    await window.keyboard.press('Alt+x')
    await expect(input).toBeFocused()
    await window.keyboard.type('describe-')
    await view.evaluate(() => {
      ;(globalThis as unknown as { document: { title: string } }).document.title = 'renamed'
    })
    await expect(window.locator('#buffer-list')).toContainText('renamed')

    // The palette still has the keyboard, and what follows lands in it.
    await expect(input).toBeFocused()
    await window.keyboard.type('command')
    await expect(input).toHaveText('describe-command')
    await window.keyboard.press('Control+g')
    await expect(window.locator('#palette')).toBeHidden()
  } finally {
    await app.close()
    await fixtures.close()
  }
})
