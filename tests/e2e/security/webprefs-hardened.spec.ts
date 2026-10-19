import { expect, test } from '../_test'
import {
  describeWeakPreferences,
  ENFORCED_PREFERENCE_KEYS,
  HARDENED_WEB_PREFERENCES,
  weakWebPreferences,
} from '../../../src/main/security/web-preferences'
import { fixtureServer, launchNemesis } from './_harness'

/**
 * SECURITY.org, non-negotiables row 2: "Every renderer runs sandboxed with
 * context isolation", asserted the way the table asks, from the
 * `webPreferences` of every WebContents read at runtime (#47, threat T1).
 *
 * REQUIRED below restates the values from SECURITY.org instead of importing
 * them, and the duplication is the point: a spec that only compared the running
 * app against HARDENED_WEB_PREFERENCES would pass happily after someone relaxed
 * that object, because both sides of the comparison would move together.
 * SECURITY.org is the source of truth and this table is its copy.
 * `weakWebPreferences` runs alongside, so the production check is exercised on
 * real input as well.
 */

/** The hardened values, from the table in SECURITY.org. Changing one is a diff under review. */
const REQUIRED: Readonly<Record<string, boolean | string>> = {
  sandbox: true,
  contextIsolation: true,
  nodeIntegration: false,
  nodeIntegrationInWorker: false,
  nodeIntegrationInSubFrames: false,
  webSecurity: true,
  allowRunningInsecureContent: false,
  experimentalFeatures: false,
  enableBlinkFeatures: '',
  webviewTag: false,
}

/** `getLastWebPreferences()` is runtime-only in Electron 44; see assert-web-preferences.ts. */
interface ReportedWebContents {
  getType(): string
  getLastWebPreferences?: () => Record<string, unknown> | null
}

interface Reported {
  readonly id: number
  readonly type: string
  readonly prefs: Record<string, unknown> | null
}

/** The cockpit's bridge, as far as this spec reads it. */
interface CockpitWindow {
  readonly nemesis: {
    buffers(): Promise<{
      readonly buffers: readonly { id: string; kind: string; url?: string }[]
      readonly currentId: string | null
    }>
  }
}

/** The types that hold app or web content, the ones the app configures itself. */
const OURS = ['window', 'browserView', 'webview', 'offscreen']

/** What every WebContents in the running app reports about itself. */
async function reportOurs(nemesis: Awaited<ReturnType<typeof launchNemesis>>): Promise<Reported[]> {
  const all = await nemesis.app.evaluate(({ webContents }) =>
    webContents.getAllWebContents().map((contents) => {
      const reader = contents as unknown as ReportedWebContents
      return {
        id: contents.id,
        type: reader.getType(),
        prefs: reader.getLastWebPreferences?.() ?? null,
      }
    }),
  )
  return all.filter((one) => OURS.includes(one.type))
}

/** Every enforced field of one live WebContents, against SECURITY.org and against the policy check. */
function assertHardened(contents: Reported): void {
  const where = `WebContents ${contents.id} (${contents.type})`
  for (const [key, value] of Object.entries(REQUIRED)) {
    // Reported at all: an absent key must never read as a pass.
    expect(contents.prefs, `${where} reports no ${key}`).toHaveProperty(key)
    expect(contents.prefs?.[key], `${where} runs with ${key} weakened`).toBe(value)
  }
  // The production check, on the same real input, has to agree.
  const weak = weakWebPreferences(contents.prefs)
  expect(weak, `${where}: ${describeWeakPreferences(weak)}`).toEqual([])
}

test('every WebContents reports the hardened preferences at runtime', async () => {
  const fixtures = await fixtureServer()
  const nemesis = await launchNemesis()
  try {
    const atStartup = await reportOurs(nemesis)
    // Non-vacuous: the cockpit window has to be in there, or the walk proved nothing.
    expect(atStartup.length).toBeGreaterThan(0)
    for (const contents of atStartup) assertHardened(contents)

    // A page buffer holding hostile content is held to the same policy: the
    // app's own, a WebContentsView src/main/page-buffer.ts built (#119).
    const url = fixtures.secureUrl('node-probe.html')
    const buffer = await nemesis.openPageBuffer(url)
    expect(buffer.loadError).toBeNull()
    await expect
      .poll(() =>
        nemesis.window.evaluate(async () => {
          const list = await (globalThis as unknown as CockpitWindow).nemesis.buffers()
          return list.buffers.find((one) => one.id === list.currentId) ?? null
        }),
      )
      .toMatchObject({ kind: 'page', url })
    const views = await nemesis.app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().flatMap((window) =>
        window.contentView.children.flatMap((child) =>
          'webContents' in child ? [(child as Electron.WebContentsView).webContents.getURL()] : [],
        ),
      ),
    )
    expect(views).toContain(url)

    const withPage = await reportOurs(nemesis)
    expect(withPage.length).toBeGreaterThan(atStartup.length)
    for (const contents of withPage) assertHardened(contents)

    // The policy object still says what SECURITY.org says. Without this, relaxing
    // HARDENED_WEB_PREFERENCES would relax what the app asks for and every
    // comparison above would quietly follow it down.
    for (const [key, value] of Object.entries(REQUIRED)) {
      expect(HARDENED_WEB_PREFERENCES, `the policy relaxed ${key}`).toHaveProperty(key, value)
    }
    expect([...ENFORCED_PREFERENCE_KEYS].sort()).toEqual(Object.keys(REQUIRED).sort())

    // The fields Chromium never reports back, asserted on what the app passes in.
    expect(HARDENED_WEB_PREFERENCES.navigateOnDragDrop).toBe(false)
    expect(HARDENED_WEB_PREFERENCES.spellcheck).toBe(true)
    expect(HARDENED_WEB_PREFERENCES.plugins).toBe(false)
    // The preload is added per internal page, so a page buffer cannot inherit it.
    expect('preload' in HARDENED_WEB_PREFERENCES).toBe(false)

    // The startup assertion is live: the app only gets this far because the walk
    // on `did-finish-load` found nothing weak and so did not throw.
    await expect(nemesis.window).toHaveTitle('Nemesis')

    await buffer.close()
  } finally {
    await nemesis.close()
    await fixtures.close()
  }
})
