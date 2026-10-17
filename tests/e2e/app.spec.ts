import { expect, test } from '@playwright/test'
import { launchNemesis } from './_launch'

test('opens one hardened window titled Nemesis', async () => {
  const app = await launchNemesis()
  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await expect(page).toHaveTitle('Nemesis')
    expect(app.windows()).toHaveLength(1)

    // The preload bridge is the only thing a page may see.
    expect(
      await page.evaluate(
        () => (globalThis as unknown as { nemesis: { name: string } }).nemesis.name,
      ),
    ).toBe('nemesis')

    // No Node in the page. The full non-negotiable spec lands with #47.
    const nodeGlobals = await page.evaluate(() => ({
      process: typeof (globalThis as Record<string, unknown>)['process'],
      require: typeof (globalThis as Record<string, unknown>)['require'],
    }))
    expect(nodeGlobals).toEqual({ process: 'undefined', require: 'undefined' })
  } finally {
    await app.close()
  }
})
