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
 * What the failure fixture (tests/e2e/_test.ts, #101) wants to know about one
 * launch: the app, everything its process wrote, and the last frame of its
 * first window.
 */
export interface LaunchRecord {
  readonly app: ElectronApplication
  /** The Electron process's stdout and stderr so far, interleaved in arrival order. */
  output(): string
  /**
   * A PNG of the first window: live when the window is still open, else the
   * frame taken as `app.close()` began. Null when there never was a window
   * or the screenshot failed.
   */
  frame(): Promise<Buffer | null>
}

const launched: LaunchRecord[] = []

/** Hands over every launch since the last call and forgets them. */
export function drainLaunched(): LaunchRecord[] {
  return launched.splice(0)
}

/** A screenshot that does not hold up a quit: a stuck renderer costs five seconds, not the test. */
async function screenshot(app: ElectronApplication): Promise<Buffer | null> {
  const page = app.windows().find((window) => !window.isClosed())
  if (page === undefined) return null
  try {
    return await page.screenshot({ timeout: 5_000 })
  } catch {
    return null
  }
}

/**
 * Records a launch for the failure fixture. The specs own their cleanup and
 * close the app in `finally`, which runs before any fixture teardown, so the
 * window at the failure is gone by the time the fixture looks. The record
 * therefore takes its frame when `close()` is called, which is right after
 * the assertion threw; a test that timed out never reaches its `finally`,
 * and then the fixture gets a live screenshot instead.
 */
function record(app: ElectronApplication): void {
  const chunks: string[] = []
  const child = app.process()
  child.stdout?.on('data', (chunk: Buffer | string) => chunks.push(String(chunk)))
  child.stderr?.on('data', (chunk: Buffer | string) => chunks.push(String(chunk)))

  let lastFrame: Buffer | null = null
  const close = app.close.bind(app)
  app.close = async () => {
    lastFrame = (await screenshot(app)) ?? lastFrame
    await close()
  }

  launched.push({
    app,
    output: () => chunks.join(''),
    frame: async () => (await screenshot(app)) ?? lastFrame,
  })
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
 *
 * A spec that needs a setting (the appearance pin of #33, for one) passes it
 * in `settings`; the keys are merged over the profile's own, so a spec can
 * even point the sessions folder elsewhere. A spec that needs the main
 * process to see an environment variable (a PATH with a fake `gh` first on
 * it, #98) passes it in `env`, merged over the test runner's own.
 */
export async function launchApp(
  prefix = 'nemesis-e2e-',
  chromiumSwitches: readonly string[] = [],
  settings: Readonly<Record<string, unknown>> = {},
  env: Readonly<Record<string, string>> = {},
): Promise<LaunchedApp> {
  const userData = mkdtempSync(join(tmpdir(), prefix))
  const sessionsDir = join(userData, 'sessions')
  const downloadsDir = join(userData, 'downloads')
  mkdirSync(downloadsDir)
  writeFileSync(
    join(userData, 'settings.json'),
    `${JSON.stringify({ sessionsDir, ...settings })}\n`,
  )
  const app = await electron.launch({
    // NEMESIS_USER_DATA and NEMESIS_DOWNLOADS are what the main process
    // reads; the Chromium switch keeps caches and partitions inside the same
    // throwaway tree. A caller may add Chromium switches of its own (the
    // security harness does).
    args: ['.', `--user-data-dir=${userData}`, ...chromiumSwitches],
    // Playwright emulates a light prefers-color-scheme unless told not to;
    // null lets the page follow nativeTheme, which is what the appearance
    // setting drives (#33).
    colorScheme: null,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      NEMESIS_USER_DATA: userData,
      NEMESIS_DOWNLOADS: downloadsDir,
      ...env,
    },
  })
  record(app)
  return { app, userData, sessionsDir, downloadsDir }
}

/** The product smoke specs want the app and nothing else. */
export async function launchNemesis(): Promise<ElectronApplication> {
  return (await launchApp()).app
}
