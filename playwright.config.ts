import { defineConfig } from '@playwright/test'

// Two projects: `app` is the product smoke, `security` holds one spec per
// non-negotiable in SECURITY.org. Both drive the built app in out/ through
// Playwright's Electron support, so `npm run build` runs first.
export default defineConfig({
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  projects: [
    { name: 'app', testDir: 'tests/e2e', testIgnore: /security\// },
    { name: 'security', testDir: 'tests/e2e/security' },
  ],
})
