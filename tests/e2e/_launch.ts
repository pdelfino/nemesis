import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, type ElectronApplication } from '@playwright/test'

export interface LaunchedApp {
  readonly app: ElectronApplication
  /** The throwaway profile, for a caller that inspects or deletes it. */
  readonly userData: string
  /** Where this launch writes its session folders: inside the profile (#64). */
  readonly sessionsDir: string
  /** Where this launch's downloads path points: inside the profile too (#51). */
  readonly downloadsDir: string
}

/**
 * Launches the built app (out/) against a throwaway profile, with NODE_ENV=test
 * so the main process resolves the deterministic Agent SDK mock. The security
 * harness (tests/e2e/security/_harness.ts, #46) builds on this.
 *
 * The profile carries a settings file that points the sessions folder inside
 * itself, so no spec leaves a transcript in ~/Documents and the folder goes
 * with the profile when a caller deletes it. The downloads path is inside the
 * profile for the same reason: a download a spec says yes to lands in the
 * quarantine folder under it, never in ~/Downloads (#51).
 */
export async function launchApp(
  prefix = 'nemesis-e2e-',
  chromiumSwitches: readonly string[] = [],
): Promise<LaunchedApp> {
  const userData = mkdtempSync(join(tmpdir(), prefix))
  const sessionsDir = join(userData, 'sessions')
  const downloadsDir = join(userData, 'downloads')
  mkdirSync(downloadsDir)
  writeFileSync(join(userData, 'settings.json'), `${JSON.stringify({ sessionsDir })}\n`)
  const app = await electron.launch({
    // NEMESIS_USER_DATA and NEMESIS_DOWNLOADS are what the main process
    // reads; the Chromium switch keeps caches and partitions inside the same
    // throwaway tree. A caller may add Chromium switches of its own (the
    // security harness does).
    args: ['.', `--user-data-dir=${userData}`, ...chromiumSwitches],
    env: {
      ...process.env,
      NODE_ENV: 'test',
      NEMESIS_USER_DATA: userData,
      NEMESIS_DOWNLOADS: downloadsDir,
    },
  })
  return { app, userData, sessionsDir, downloadsDir }
}

/** The product smoke specs want the app and nothing else. */
export async function launchNemesis(): Promise<ElectronApplication> {
  return (await launchApp()).app
}
