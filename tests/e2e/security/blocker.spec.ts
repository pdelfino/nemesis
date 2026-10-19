import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '../_test'
import {
  fixtureServer,
  launchNemesis,
  OFF_LOOPBACK_HOST,
  type PageBuffer,
  type PageBufferState,
} from './_harness'

/**
 * SECURITY.org T7, blocker mode on by default (#126). The hostile fixture
 * asks for three things: one on a host the hosts file sends to 0.0.0.0, one
 * a filter list names, and a control. With the mode on, the first two never
 * reach the fixture server, the control does, and the mode line counts two.
 * After `toggle-blocker` and a reload, all three arrive and the mode line
 * says the blocker is off.
 *
 * Under test nothing is downloaded: the hosts file and the filter list are
 * this spec's own, written next to the profile and named by
 * NEMESIS_HOSTS_FILE and NEMESIS_BLOCKER_LIST.
 */

/** The test-only door src/main/index.ts installs for the page buffers. */
interface BlockerDoor {
  buffer(windowId: number, bufferId: string): PageBufferState | undefined
  run(windowId: number, name: string): Promise<void>
}

const HOSTS_LISTED = '/hosts-listed.txt'
const LIST_LISTED = '/nemesis-ad.js'
const CONTROL = '/blocker-control.txt'

test('a request to a listed host never reaches the server, the count rises, and the toggle lets it through', async () => {
  const lists = mkdtempSync(join(tmpdir(), 'nemesis-blocker-lists-'))
  const hostsFile = join(lists, 'hosts')
  writeFileSync(hostsFile, `127.0.0.1 localhost\n0.0.0.0 ${OFF_LOOPBACK_HOST}\n`)
  const seedList = join(lists, 'list.txt')
  writeFileSync(seedList, `! a filter list in EasyList syntax\n${LIST_LISTED}\n`)

  const fixtures = await fixtureServer()
  const nemesis = await launchNemesis({
    env: { NEMESIS_HOSTS_FILE: hostsFile, NEMESIS_BLOCKER_LIST: seedList },
  })
  const state = (buffer: PageBuffer): Promise<PageBufferState | undefined> =>
    nemesis.app.evaluate((_main, ids) => {
      const door = (globalThis as { __nemesisPages?: BlockerDoor }).__nemesisPages
      return ids === undefined ? undefined : door?.buffer(ids.windowId, ids.bufferId)
    }, buffer.ids)
  try {
    const buffer = await nemesis.openPageBuffer(fixtures.secureUrl('blocker.html'))
    expect(buffer.loadError).toBeNull()
    await expect(buffer.page).toHaveTitle('blocker')

    // The control arrives, so the page ran its requests; the listed two do not.
    await expect.poll(() => fixtures.requested.includes(CONTROL)).toBe(true)
    await expect.poll(async () => (await state(buffer))?.blocked).toBe(2)
    expect(fixtures.requested).not.toContain(HOSTS_LISTED)
    expect(fixtures.requested).not.toContain(LIST_LISTED)
    expect(await state(buffer)).toMatchObject({ blocker: true })
    await expect(nemesis.window.locator('#page-state')).toHaveText('2 blocked')

    // Blocker mode off for this page, then a reload: everything arrives.
    await nemesis.app.evaluate(async (_main, ids) => {
      const door = (globalThis as { __nemesisPages?: BlockerDoor }).__nemesisPages
      if (door === undefined || ids === undefined) throw new Error('No page door')
      await door.run(ids.windowId, 'toggle-blocker')
    }, buffer.ids)
    await expect(nemesis.window.locator('#page-state')).toHaveText('blocker off')
    await buffer.page.reload()
    await expect.poll(() => fixtures.requested.includes(HOSTS_LISTED)).toBe(true)
    await expect.poll(() => fixtures.requested.includes(LIST_LISTED)).toBe(true)
    expect(await state(buffer)).toMatchObject({ blocker: false, blocked: 0 })
  } finally {
    await nemesis.close()
    await fixtures.close()
    rmSync(lists, { recursive: true, force: true })
  }
})
