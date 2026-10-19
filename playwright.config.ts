import { defineConfig } from '@playwright/test'

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
