import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { QUARANTINE_ATTRIBUTE, QUARANTINE_FOLDER } from '../../../src/main/security/downloads'
import { fixtureServer, launchNemesis } from './_harness'

/**
 * SECURITY.org, non-negotiables row "Downloads opt-in and quarantined": a
 * download lands only in the quarantine folder, with the attribute (#51,
 * threat T2). The same run covers the rest of T2's controls: a link to an
 * external handler asks and never launches on its own.
 *
 * The download fixture offers one kilobyte three ways. The first two are
 * refused, once with `C-g` and once with `RET` on the highlighted candidate,
 * and nothing is written anywhere under the launch's downloads path: not a
 * file, not a `.crdownload`. The third is accepted, and exactly one file
 * appears, in the quarantine folder, whole, carrying `com.apple.quarantine`
 * as `xattr -p` reads it. The `mailto:` link opens the same prompt and `C-g`
 * leaves the system untouched; the custom-scheme link is refused without a
 * prompt. The user is told each time, in the transcript.
 */

/** The main-process global the app fills under test; the name is set in src/main/index.ts. */
const EXTERNAL_LOG = '__nemesisExternal'

/** As much of the fixture's window as the spec touches; the e2e tsconfig has no DOM lib. */
interface FixtureWindow {
  readonly document: { getElementById(id: string): { click(): void } | null }
}

/** Every file under `dir`, as paths relative to it, sorted. Folders alone do not count. */
function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .map((name) => join(dir, name))
    .filter((path) => statSync(path).isFile())
    .map((path) => relative(dir, path))
    .sort()
}

/** The candidates the palette lists, highlighted one marked. */
function candidates(page: Page): Promise<string[]> {
  return page
    .locator('#palette-candidates li')
    .evaluateAll((items) =>
      items.map(
        (item) =>
          `${item.firstChild?.textContent ?? ''}${item.getAttribute('aria-selected') === 'true' ? ' *' : ''}`,
      ),
    )
}

test('a download lands only after a yes, in the quarantine folder, with the attribute; a mailto link only asks', async () => {
  const fixtures = await fixtureServer()
  const nemesis = await launchNemesis()
  try {
    const quarantine = join(nemesis.downloadsDir, QUARANTINE_FOLDER)
    const origin = fixtures.httpOrigin
    const palette = nemesis.window.locator('#palette')
    const promptLabel = nemesis.window.locator('#palette-prompt')
    const keyboard = nemesis.window.keyboard
    const notes = (): Promise<string[]> =>
      nemesis.window.locator('#transcript .cm-line').allTextContents()
    // The committed URL of every WebContents, from the main process: after
    // the app cancels a navigation to a handler scheme, Playwright's own view
    // of the page waits for that navigation forever, and this does not.
    const committed = (): Promise<string[]> =>
      nemesis.app.evaluate(({ webContents }) =>
        webContents.getAllWebContents().map((one) => one.getURL()),
      )
    const launched = (): Promise<readonly string[] | undefined> =>
      nemesis.app.evaluate(
        (_electron, key) =>
          (globalThis as Record<string, unknown>)[key] as readonly string[] | undefined,
        EXTERNAL_LOG,
      )

    const buffer = await nemesis.openPageBuffer(fixtures.url('download.html'))
    expect(buffer.loadError).toBeNull()
    await expect(buffer.page).toHaveTitle('download')
    const windowsBefore = nemesis.app.windows().length
    expect(filesUnder(nemesis.downloadsDir)).toEqual([])

    // The link: the prompt buffer asks with the name, the size and the
    // origin, no path, no URL, and the no is highlighted. The name is the
    // server's: Chromium takes Content-Disposition over the link's
    // `download` attribute, and the prompt shows what will land.
    await buffer.page.click('#download-link')
    await expect(palette).toBeVisible()
    await expect(promptLabel).toHaveText(`Download download.bin (1.0 KB) from ${origin}?`)
    expect(await candidates(nemesis.window)).toEqual([
      'Do not download *',
      'Save to nemesis-quarantine',
    ])
    // C-g is a no.
    await keyboard.press('Control+g')
    await expect(palette).toBeHidden()
    await expect
      .poll(notes)
      .toContain(
        `Refused download of download.bin (1.0 KB) from ${origin}: nothing was written (SECURITY.org, T2)`,
      )
    await nemesis.window.waitForTimeout(500)
    expect(filesUnder(nemesis.downloadsDir)).toEqual([])

    // The scripted click: RET on the highlighted candidate is a no as well.
    await buffer.page.click('#download-click')
    await expect(palette).toBeVisible()
    await expect(promptLabel).toHaveText(`Download download.bin (1.0 KB) from ${origin}?`)
    await keyboard.press('Enter')
    await expect(palette).toBeHidden()
    await expect
      .poll(
        async () => (await notes()).filter((line) => line.startsWith('Refused download')).length,
      )
      .toBe(2)
    await nemesis.window.waitForTimeout(500)
    expect(filesUnder(nemesis.downloadsDir)).toEqual([])

    // The navigation, and a yes typed out.
    await buffer.page.click('#download-navigate')
    await expect(palette).toBeVisible()
    await expect(promptLabel).toHaveText(`Download download.bin (1.0 KB) from ${origin}?`)
    await keyboard.type('save')
    await expect.poll(() => candidates(nemesis.window)).toEqual(['Save to nemesis-quarantine *'])
    await keyboard.press('Enter')
    await expect(palette).toBeHidden()

    // One file, in the quarantine folder, whole, and nothing else anywhere.
    await expect
      .poll(() => filesUnder(nemesis.downloadsDir), { timeout: 10_000 })
      .toEqual([join(QUARANTINE_FOLDER, 'download.bin')])
    const saved = join(quarantine, 'download.bin')
    expect(statSync(saved).size).toBe(1024)
    if (process.platform === 'darwin') {
      // The policy announces the file only after it has read the attribute
      // back; the spec reads it a second time, with the tool the issue names.
      await expect
        .poll(notes)
        .toContain(
          `Saved download.bin (1.0 KB) from ${origin} to ${quarantine}: quarantined, not opened`,
        )
      const attribute = execFileSync('/usr/bin/xattr', ['-p', QUARANTINE_ATTRIBUTE, saved], {
        encoding: 'utf8',
      }).trim()
      expect(attribute).toMatch(/^[0-9a-f]{4};[0-9a-f]+;/)
    } else {
      await expect
        .poll(notes)
        .toContain(`Saved download.bin (1.0 KB) from ${origin} to ${quarantine}: not opened`)
    }
    // Not opened, no dialog: no window appeared, and the page is where it was.
    expect(nemesis.app.windows().length).toBe(windowsBefore)
    await expect(buffer.page).toHaveTitle('download')

    // A mailto: link asks, with the URL and the asking origin; C-g leaves the
    // system alone. The clicks are dispatched from inside the page: Playwright's
    // own click would wait for the navigation it started, and the app cancels
    // that navigation, so it would wait until the timeout.
    const follow = (id: string) =>
      buffer.page.evaluate(
        (linkId) =>
          (globalThis as unknown as FixtureWindow).document.getElementById(linkId)?.click(),
        id,
      )
    expect(await launched()).toEqual([])
    await follow('mailto-link')
    await expect(palette).toBeVisible()
    await expect(promptLabel).toHaveText(
      `Open mailto:nyx@example.org?subject=Nemesis with the system handler? Asked by ${origin}`,
    )
    expect(await candidates(nemesis.window)).toEqual([
      'Do not open *',
      'Open with the system handler',
    ])
    await keyboard.press('Control+g')
    await expect(palette).toBeHidden()
    await expect
      .poll(notes)
      .toContain(`Refused mailto: link from ${origin}: nothing was opened (SECURITY.org, T2)`)
    expect(await launched()).toEqual([])
    expect(await committed()).toContain(fixtures.url('download.html'))

    // A custom scheme is refused without a prompt in version 1.
    await follow('custom-link')
    await expect
      .poll(notes)
      .toContain(
        `Refused zoommtg: link from ${origin}: only http:, https:, mailto:, tel: links open, after a yes (SECURITY.org, T2)`,
      )
    await expect(palette).toBeHidden()
    expect(await launched()).toEqual([])
    expect(await committed()).toContain(fixtures.url('download.html'))
    expect(nemesis.app.windows().length).toBe(windowsBefore)
    expect(filesUnder(nemesis.downloadsDir)).toEqual([join(QUARANTINE_FOLDER, 'download.bin')])

    await buffer.close()
  } finally {
    await nemesis.close()
    await fixtures.close()
  }
})
