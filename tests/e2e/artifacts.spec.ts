import { expect, test } from './_test'
import { launchApp } from './_launch'

/**
 * The failure artifacts proving themselves (#101). Skipped by the gate; with
 * ARTIFACT_PROBE=1 it launches the app and fails on purpose, in the same shape
 * as every real spec (cleanup in `finally`), so one command shows whether a
 * red spec leaves window-1.png and main.log in its test-results folder:
 *
 *   ARTIFACT_PROBE=1 npx playwright test --project=app -g artifact-probe
 */
test(
  'a failing spec leaves a window screenshot and the main log',
  { tag: '@artifact-probe' },
  async () => {
    test.skip(
      process.env['ARTIFACT_PROBE'] !== '1',
      'Set ARTIFACT_PROBE=1 to run the probe; it fails on purpose',
    )
    const { app } = await launchApp('nemesis-artifact-probe-')
    try {
      const page = await app.firstWindow()
      await page.waitForLoadState('domcontentloaded')
      await expect(page).toHaveTitle('Nemesis')
      expect(
        await page.title(),
        'The probe fails on purpose: window-1.png and main.log sit next to this result',
      ).toBe('not Nemesis')
    } finally {
      await app.close()
    }
  },
)
