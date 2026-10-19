import { defineConfig } from '@playwright/test'

// Two projects: `app` is the product smoke, `security` holds one spec per
// non-negotiable in SECURITY.org. Both drive the built app in out/ through
// Playwright's Electron support, so `npm run build` runs first. A third,
// `package`, drives the packaged release/mac-arm64/Nemesis.app, so
// `npm run package` runs first; it is outside the gate because packaging is
// slow (#35).
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
  ],
})
