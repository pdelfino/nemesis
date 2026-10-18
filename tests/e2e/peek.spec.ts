import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from './_test'
import { launchApp } from './_launch'

const PORT = 9333
const DEAD_PORT = 9334

/** scripts/peek.mts as `npm run peek` runs it: plain Node with type stripping. */
function peek(...args: string[]) {
  return spawnSync(
    process.execPath,
    ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', 'scripts/peek.mts', ...args],
    { encoding: 'utf8', timeout: 20_000 },
  )
}

test('npm run peek attaches to a running cockpit, prints its buffers as Org and saves a PNG (#102)', async () => {
  const { app, userData } = await launchApp('nemesis-peek-', [`--remote-debugging-port=${PORT}`])
  const outDir = mkdtempSync(join(tmpdir(), 'nemesis-peek-out-'))
  const png = join(outDir, 'shot.png')
  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await expect(page.locator('#modeline #buffer-list')).toHaveText('Transcript [Prompt]')

    const result = peek('--port', String(PORT), '--out', png)
    expect(result.stderr, result.stderr).toBe('')
    expect(result.status).toBe(0)

    // The Org document: the window, then one heading per visible buffer.
    expect(result.stdout).toContain('#+title: Nemesis peek')
    expect(result.stdout).toContain('- title: Nemesis')
    expect(result.stdout).toContain('- mode line: Nemesis')
    expect(result.stdout).toContain('\n** transcript\n')
    expect(result.stdout).toContain('\n** prompt buffer (current)\n')
    expect(result.stdout).toContain('\n* Palette\nclosed\n')

    // The screenshot is a real frame, not an empty file.
    expect(statSync(png).size).toBeGreaterThan(1024)

    // Reading left the app running and untouched: still two buffers, prompt current.
    await expect(page.locator('#modeline #buffer-list')).toHaveText('Transcript [Prompt]')
    await expect(page.locator('#prompt')).toHaveAttribute('data-current', 'true')
  } finally {
    await app.close()
    rmSync(outDir, { recursive: true, force: true })
    rmSync(userData, { recursive: true, force: true })
  }
})

test('npm run peek exits non-zero with one line when nothing listens on the port (#102)', () => {
  const result = peek('--port', String(DEAD_PORT))
  expect(result.status).toBe(1)
  expect(result.stdout).toBe('')
  expect(result.stderr).toBe(
    `peek: nothing listens on http://127.0.0.1:${DEAD_PORT}; start the app with npm run dev:debug\n`,
  )
})
