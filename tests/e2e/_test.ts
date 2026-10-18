import { writeFileSync } from 'node:fs'
import { test as base } from '@playwright/test'
import { drainLaunched } from './_launch'

/**
 * Playwright's `test`, plus the evidence a red gate needs (#101). The specs
 * launch Electron themselves through `launchApp`, so Playwright's own
 * `screenshot: 'only-on-failure'` never fires: it needs the `page` fixture.
 * This automatic fixture does the equivalent for every app launched during a
 * test that did not end the way it was expected to: a PNG of each app's first
 * window as `window-<n>.png` and the main process's stdout and stderr as
 * `main.log`, both in the test's output folder under test-results/ and both
 * attached to the report. It closes nothing; the specs keep their own cleanup.
 *
 * Every spec under tests/e2e/ imports `test` and `expect` from here. The
 * probe in tests/e2e/artifacts.spec.ts fails on purpose to prove it works.
 */
export const test = base.extend<{ failureArtifacts: void }>({
  failureArtifacts: [
    // Playwright reads the destructuring to learn a fixture's dependencies; this one has none.
    // eslint-disable-next-line no-empty-pattern
    async ({}, use, testInfo) => {
      // Nothing left over from an earlier test in this worker.
      drainLaunched()
      await use()
      const records = drainLaunched()
      if (testInfo.status === testInfo.expectedStatus) return

      let n = 0
      for (const record of records) {
        n += 1
        const frame = await record.frame()
        if (frame === null) continue
        const path = testInfo.outputPath(`window-${n}.png`)
        writeFileSync(path, frame)
        await testInfo.attach(`window-${n}`, { path, contentType: 'image/png' })
      }

      const log =
        records.length === 0
          ? 'No app was launched through launchApp during this test.\n'
          : records
              .map((record, i) => `=== app ${i + 1}: stdout and stderr ===\n${record.output()}`)
              .join('\n')
      const path = testInfo.outputPath('main.log')
      writeFileSync(path, log)
      await testInfo.attach('main.log', { path, contentType: 'text/plain' })
    },
    { auto: true },
  ],
})

export { expect } from '@playwright/test'
export type { Page } from '@playwright/test'
