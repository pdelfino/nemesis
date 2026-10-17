import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, type ElectronApplication } from '@playwright/test'

export interface LaunchedApp {
  readonly app: ElectronApplication
  /** The throwaway profile, for a caller that inspects or deletes it. */
  readonly userData: string
}

/**
 * Launches the built app (out/) against a throwaway profile, with NODE_ENV=test
 * so the main process resolves the deterministic Agent SDK mock. The security
 * harness (tests/e2e/security/_harness.ts, #46) builds on this.
 */
export async function launchApp(prefix = 'nemesis-e2e-'): Promise<LaunchedApp> {
  const userData = mkdtempSync(join(tmpdir(), prefix))
  const app = await electron.launch({
    // NEMESIS_USER_DATA is what the main process reads; the Chromium switch
    // keeps caches and partitions inside the same throwaway tree.
    args: ['.', `--user-data-dir=${userData}`],
    env: { ...process.env, NODE_ENV: 'test', NEMESIS_USER_DATA: userData },
  })
  return { app, userData }
}

/** The product smoke specs want the app and nothing else. */
export async function launchNemesis(): Promise<ElectronApplication> {
  return (await launchApp()).app
}
