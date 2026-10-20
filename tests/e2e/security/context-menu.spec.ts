import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ElectronApplication } from '@playwright/test'
import { expect, test } from '../_test'
import { fixtureServer, launchNemesis } from './_harness'

/**
 * SECURITY.org T4 for the page context menu (#180): what is under the
 * pointer is page content, and `atPoint` carries it to a config command as
 * data. Over the hostile fixture, whose link URL and paragraph are code and
 * an instruction:
 *
 * 1. the config entry's command receives the link URL and the selection
 *    exactly, as strings;
 * 2. every built-in entry and the config entry run, and nothing evaluated the
 *    text: no global it would set exists in the main process, the cockpit or
 *    the page, and the eval journal was never written;
 * 3. the agent's prompt never saw it: the mock SDK received no message.
 */

interface ContextMenuRecord {
  readonly labels: readonly { readonly label: string; readonly enabled: boolean }[]
  click(label: string): void
}

const CANARY = 'NEMESIS-CONTEXT-CANARY'

const INIT = `nemesis.defineCommand({
  name: 'note-point',
  doc: 'Says the link and the selection under the pointer.',
  run(context: { atPoint?: { linkUrl: string | null; selection: string | null } }): void {
    nemesis.notice('link=' + context.atPoint?.linkUrl)
    nemesis.notice('selection=' + context.atPoint?.selection)
  },
})
nemesis.addContextMenuCommand('Note point', 'note-point')
`

function menus(app: ElectronApplication): Promise<number> {
  return app.evaluate(
    () =>
      (globalThis as { __nemesisContextMenus?: ContextMenuRecord[] }).__nemesisContextMenus
        ?.length ?? 0,
  )
}

function clickLast(app: ElectronApplication, label: string): Promise<void> {
  return app.evaluate((_main, name) => {
    ;(globalThis as { __nemesisContextMenus?: ContextMenuRecord[] }).__nemesisContextMenus
      ?.at(-1)
      ?.click(name)
  }, label)
}

test('atPoint text reaches a config command as data, never eval and never the agent', async () => {
  const fixtures = await fixtureServer()
  const dir = mkdtempSync(join(tmpdir(), 'nemesis-security-context-'))
  writeFileSync(join(dir, 'init.ts'), INIT)
  const clipboardFile = join(dir, 'clipboard.txt')
  const nemesis = await launchNemesis({
    env: { NEMESIS_CONFIG_DIR: dir, NEMESIS_CLIPBOARD_TEXT: clipboardFile },
  })
  const { app, window } = nemesis
  try {
    await window.evaluate(() => {
      const w = globalThis as unknown as {
        __notices?: string[]
        nemesis: { onAgentEvent(listener: (event: { type: string; text?: string }) => void): void }
      }
      w.__notices = []
      w.nemesis.onAgentEvent((event) => {
        if (event.type === 'notice') w.__notices?.push(event.text ?? '')
      })
    })
    const buffer = await nemesis.openPageBuffer(fixtures.url('context-menu.html'))
    expect(buffer.loadError).toBeNull()
    const page = buffer.page
    await expect(page).toHaveTitle('context menu')
    const hostileUrl = new URL(
      (await page.locator('#hostile').getAttribute('href')) ?? '',
      fixtures.httpOrigin,
    ).href

    // The hostile link: every built-in, then the config entry.
    for (const label of ['Copy link', 'Bookmark link', 'Open link in new buffer', 'Note point']) {
      const before = await menus(app)
      await page.locator('#hostile').click({ button: 'right' })
      await expect.poll(() => menus(app)).toBe(before + 1)
      await clickLast(app, label)
    }
    await expect
      .poll(() => (existsSync(clipboardFile) ? readFileSync(clipboardFile, 'utf8') : ''))
      .toBe(hostileUrl)

    // The hostile paragraph, selected: the config entry reads the selection.
    await page.locator('#text').selectText()
    const selected = await page.evaluate(() =>
      String((globalThis as unknown as { getSelection(): unknown }).getSelection()),
    )
    const before = await menus(app)
    await page.locator('#text').click({ button: 'right' })
    await expect.poll(() => menus(app)).toBe(before + 1)
    await clickLast(app, 'Note point')

    // 1. The command read both, exactly.
    const notices = (): Promise<string[]> =>
      window.evaluate(() => (globalThis as { __notices?: string[] }).__notices ?? [])
    await expect.poll(notices).toContain(`link=${hostileUrl}`)
    await expect.poll(notices).toContain(`selection=${selected}`)
    expect(selected).toContain(CANARY)

    // 2. Nothing evaluated it: no global, in any of the three places, and no journal.
    expect(
      await app.evaluate(() => (globalThis as { __nemesisPwned?: unknown }).__nemesisPwned),
    ).toBeUndefined()
    expect(
      await window.evaluate(() => (globalThis as { __nemesisPwned?: unknown }).__nemesisPwned),
    ).toBeUndefined()
    expect(
      await page.evaluate(() => (globalThis as { __nemesisPwned?: unknown }).__nemesisPwned),
    ).toBeUndefined()
    expect(existsSync(join(dir, 'journal.org'))).toBe(false)

    // 3. The agent got nothing: no message at all, so no canary in one.
    const received = await app.evaluate(
      () => (globalThis as { __nemesisMockReceived?: unknown[] }).__nemesisMockReceived ?? [],
    )
    expect(JSON.stringify(received)).not.toContain(CANARY)
    expect(received).toEqual([])
  } finally {
    await nemesis.close()
    await fixtures.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
