import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { defineConfig } from '@playwright/test'

// Per-machine opt-out (Pedro, 2026-10-20): every project here opens Electron
// windows, which flash across the screen. A Mac holding this file skips them
// all and exits 0 with a loud notice; the other Mac and CI run them. Delete
// the file, or set NEMESIS_WINDOW_TESTS=1 for one run, to turn them back on.
const WINDOW_TESTS_OFF = join(homedir(), '.config', 'nemesis', 'no-window-tests')
if (existsSync(WINDOW_TESTS_OFF) && process.env.NEMESIS_WINDOW_TESTS !== '1') {
  console.error(
    `\nWINDOW TESTS SKIPPED on this machine (${WINDOW_TESTS_OFF} exists).\n` +
      'This gate is partial: run the full gate on the other Mac or in CI before calling it green.\n' +
      'Turn back on: rm the file, or NEMESIS_WINDOW_TESTS=1 for one run.\n',
  )
  process.exit(0)
}

// Two projects: `app` is the product smoke, `security` holds one spec per
// non-negotiable in SECURITY.org. Both drive the built app in out/ through
// Playwright's Electron support, so `npm run build` runs first. A third,
// `package`, drives the packaged release/mac-arm64/Nemesis.app, so
// `npm run package` runs first; it is outside the gate because packaging is
// slow (#35). A fourth, `release`, reads the fuses back off whatever bundle
// is in release/, signed or not, for `npm run release:check` (#74). A
// fifth, `real`, drives the real Agent SDK with Haiku through the `claude`
// CLI login, for `make real` only (#146): never in the gate or CI, and its
// specs skip themselves unless NEMESIS_REAL_SDK=1.
export default defineConfig({
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  projects: [
    { name: 'app', testDir: 'tests/e2e', testIgnore: /security\// },
    { name: 'security', testDir: 'tests/e2e/security' },
    { name: 'package', testDir: 'tests/package' },
    { name: 'release', testDir: 'tests/release' },
    { name: 'real', testDir: 'tests/real' },
  ],
})
