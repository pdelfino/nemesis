import { spawn, type ChildProcess } from 'node:child_process'
import { accessSync, constants, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, expect, test } from '@playwright/test'
import { FuseState, FuseV1Options, getCurrentFuseWire } from '@electron/fuses'
// @ts-expect-error -- a packaging hook electron-builder loads by path, so plain
// ESM JavaScript rather than a typed module in src/.
import { FUSE_CONFIG } from '../../scripts/after-pack.mjs'

/**
 * The packaged app (#35): `npm run package` builds release/mac-arm64/Nemesis.app,
 * and these specs check the bundle that comes out, not the out/ build the e2e
 * project drives.
 *
 * Playwright's own Electron launcher attaches through `--inspect`, which the
 * EnableNodeCliInspectArguments fuse turns off in the packaged binary (#47),
 * so the app is spawned here and the page is reached over Chromium's DevTools
 * protocol instead.
 */

const APP = join(process.cwd(), 'release', 'mac-arm64', 'Nemesis.app')
const BINARY = join(APP, 'Contents', 'MacOS', 'Nemesis')
const UNPACKED = join(APP, 'Contents', 'Resources', 'app.asar.unpacked')

/** Starts the packaged binary on a throwaway profile and resolves its DevTools endpoint. */
function launchPackaged(): Promise<{ child: ChildProcess; endpoint: string }> {
  const userData = mkdtempSync(join(tmpdir(), 'nemesis-package-'))
  const downloadsDir = join(userData, 'downloads')
  mkdirSync(downloadsDir)
  writeFileSync(
    join(userData, 'settings.json'),
    `${JSON.stringify({ sessionsDir: join(userData, 'sessions') })}\n`,
  )
  const child = spawn(BINARY, [`--user-data-dir=${userData}`, '--remote-debugging-port=0'], {
    env: {
      ...process.env,
      // The deterministic Agent SDK mock, and every folder inside the profile,
      // as tests/e2e/_launch.ts does for the out/ build.
      NODE_ENV: 'test',
      NEMESIS_USER_DATA: userData,
      NEMESIS_DOWNLOADS: downloadsDir,
      NEMESIS_CONFIG_DIR: userData,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return new Promise((resolve, reject) => {
    let output = ''
    child.stderr.on('data', (chunk: Buffer) => {
      output += String(chunk)
      const match = /DevTools listening on (ws:\/\/\S+)/.exec(output)
      if (match?.[1] !== undefined) resolve({ child, endpoint: match[1] })
    })
    child.on('exit', (code) => reject(new Error(`Nemesis exited with ${code}:\n${output}`)))
  })
}

test('the packaged app opens one window titled Nemesis', async () => {
  const { child, endpoint } = await launchPackaged()
  try {
    const browser = await chromium.connectOverCDP(endpoint)
    const [context] = browser.contexts()
    if (context === undefined) throw new Error('the packaged app exposed no browser context')
    const page = context.pages()[0] ?? (await context.waitForEvent('page'))
    await page.waitForLoadState('domcontentloaded')
    await expect(page).toHaveTitle('Nemesis')
    expect(context.pages()).toHaveLength(1)
    await browser.close()
  } finally {
    child.kill()
  }
})

test('the packaged binary carries the fuses SECURITY.org T1 names', async () => {
  const wire = await getCurrentFuseWire(BINARY)
  const fuses = Object.keys(FUSE_CONFIG)
    .filter((key) => /^\d+$/.test(key))
    .map(Number) as FuseV1Options[]
  expect(fuses).toHaveLength(6)
  for (const fuse of fuses) {
    const want = (FUSE_CONFIG as Record<number, boolean>)[fuse]
      ? FuseState.ENABLE
      : FuseState.DISABLE
    expect(wire[fuse], FuseV1Options[fuse]).toBe(want)
  }
})

test('the Agent SDK CLI binary is unpacked from the asar and executable', () => {
  const claude = join(
    UNPACKED,
    'node_modules',
    '@anthropic-ai',
    `claude-agent-sdk-${process.platform}-${process.arch}`,
    'claude',
  )
  expect(() => accessSync(claude, constants.X_OK)).not.toThrow()
})
