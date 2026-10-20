import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '../_test'
import { launchNemesis } from './_harness'

/**
 * SECURITY.org T1 and T3 for the config's pages (#181): a page the config
 * renders at `nemesis://app/user/<name>` runs no script, and its buttons
 * reach a command by name and nothing else.
 *
 * 1. The page's inline script and inline handler never ran: no global they
 *    set exists in the page, and the title is the config's.
 * 2. A `data-command` that names no registered command is refused with a
 *    notice, and nothing ran.
 * 3. A `data-command` that names a registered `free` command runs it, as a
 *    user page source, so the route is real and the refusal above is the
 *    check, not a dead button.
 */

const INIT = `nemesis.on('after-command', {
  name: 'say-page-runs',
  doc: 'Says which command a page button ran.',
  run(event: { command: string; context: { source: string } }): void {
    if (event.context.source === 'user-page') nemesis.notice('page ran ' + event.command)
  },
})
nemesis.definePage('tools', {
  title: 'Tools',
  render(): string {
    return '<h1 id="heading">Tools</h1>' +
      '<script>globalThis.__nemesisPwned = 1; document.title = "pwned"</script>' +
      '<img id="probe" src="data:," onerror="globalThis.__nemesisPwned = 2">' +
      '<button id="unknown" data-command="no-such-command">Nothing</button>' +
      '<button id="known" data-command="describe-bindings">Bindings</button>'
  },
})
`

interface PagesDoor {
  windows(): { id: number }[]
  run(windowId: number, name: string): Promise<void>
}

test('a config page runs no script, and a button runs only a registered command', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nemesis-security-user-pages-'))
  writeFileSync(join(dir, 'init.ts'), INIT)
  const nemesis = await launchNemesis({ env: { NEMESIS_CONFIG_DIR: dir } })
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
    const notices = (): Promise<string[]> =>
      window.evaluate(() => (globalThis as { __notices?: string[] }).__notices ?? [])

    const opened = app.waitForEvent('window')
    await app.evaluate(async () => {
      const door = (globalThis as { __nemesisPages?: PagesDoor }).__nemesisPages
      if (door === undefined) throw new Error('The app has no page door: is NODE_ENV=test?')
      const [first] = door.windows()
      if (first === undefined) throw new Error('No window')
      await door.run(first.id, 'page-tools')
    })
    const page = await opened
    await expect(page.locator('#heading')).toHaveText('Tools')
    expect(page.url()).toBe('nemesis://app/user/tools')

    // 1. Neither the inline script nor the inline handler ran.
    await expect(page).toHaveTitle('Tools')
    expect(
      await page.evaluate(() => (globalThis as { __nemesisPwned?: unknown }).__nemesisPwned),
    ).toBeUndefined()

    // 2. An unregistered name is refused, and runs nothing.
    await page.locator('#unknown').click()
    await expect
      .poll(notices)
      .toContain('Not run: the page tools names no command "no-such-command"')
    expect((await notices()).some((text) => text.startsWith('page ran'))).toBe(false)

    // 3. A registered free command runs, from the page.
    await page.locator('#known').click()
    await expect.poll(notices).toContain('page ran describe-bindings')
    expect(
      await page.evaluate(() => (globalThis as { __nemesisPwned?: unknown }).__nemesisPwned),
    ).toBeUndefined()
  } finally {
    await nemesis.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
