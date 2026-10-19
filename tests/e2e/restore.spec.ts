import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ElectronApplication } from '@playwright/test'
import { expect, test } from './_test'
import { launchApp } from './_launch'
import { fixtureServer } from './security/_harness'

/**
 * Session restore (#127): two windows with page buffers, one of them
 * ephemeral, are quit; the next launch on the same profile reopens both
 * windows with their persistent pages, the current one loaded and the rest
 * waiting until they are shown, and the ephemeral page is gone, from the
 * windows and from windows.json. A launch with --no-restore opens one bare
 * window instead.
 */

interface WindowState {
  readonly id: number
  readonly cwd: string
  readonly currentId: string | null
  readonly pages: readonly {
    readonly id: string
    readonly url: string | null
    readonly title: string
    readonly partition: string
    readonly loaded: string
  }[]
}

/** The test-only page door of src/main/index.ts. */
interface PageDoor {
  open(
    url: string,
    partition?: 'persistent' | 'ephemeral',
    windowId?: number,
  ): Promise<{ readonly loadError: string | null }>
  run(windowId: number, name: string): Promise<void>
  windows(): WindowState[]
}

function windows(app: ElectronApplication): Promise<WindowState[]> {
  return app.evaluate(() =>
    (globalThis as unknown as { __nemesisPages: PageDoor }).__nemesisPages.windows(),
  )
}

async function open(
  app: ElectronApplication,
  url: string,
  partition: 'persistent' | 'ephemeral',
  windowId: number,
): Promise<void> {
  const opened = await app.evaluate(
    (_electron, [one, where, id]) =>
      (globalThis as unknown as { __nemesisPages: PageDoor }).__nemesisPages.open(one, where, id),
    [url, partition, windowId] as const,
  )
  expect(opened.loadError).toBeNull()
}

test('each window reopens its persistent page buffers at start, lazily, and never an ephemeral one', async () => {
  const fixtures = await fixtureServer()
  const a = fixtures.url('node-probe.html')
  const b = fixtures.url('window-open.html')
  const c = fixtures.url('navigation.html')
  const hidden = `${fixtures.url('navigation.html')}?ephemeral`
  const launched = await launchApp('nemesis-restore-')
  const { userData } = launched
  try {
    const window = await launched.app.firstWindow()
    await window.waitForLoadState('domcontentloaded')
    await expect.poll(async () => (await windows(launched.app)).length).toBe(1)
    const [first] = await windows(launched.app)
    if (first === undefined) throw new Error('no first window')

    // A second window, from the first, as C-x 5 2 opens it.
    await launched.app.evaluate(
      (_electron, id) =>
        (globalThis as unknown as { __nemesisPages: PageDoor }).__nemesisPages.run(
          id,
          'new-window',
        ),
      first.id,
    )
    await expect.poll(async () => (await windows(launched.app)).length).toBe(2)
    const second = (await windows(launched.app))[1]
    if (second === undefined) throw new Error('no second window')

    // Two persistent pages and an ephemeral one in the first, the last
    // persistent page current; one persistent page in the second.
    await open(launched.app, a, 'persistent', first.id)
    await open(launched.app, hidden, 'ephemeral', first.id)
    await open(launched.app, b, 'persistent', first.id)
    await open(launched.app, c, 'persistent', second.id)
    await expect
      .poll(async () => (await windows(launched.app))[0]?.pages.map((page) => page.title))
      .toEqual(['node probe', 'navigation', 'window open'])
  } finally {
    await launched.app.close()
  }

  // windows.json holds both windows and never the ephemeral page.
  const file = readFileSync(join(userData, 'windows.json'), 'utf8')
  expect(file).toContain(a)
  expect(file).toContain(c)
  expect(file).not.toContain('?ephemeral')

  const again = await launchApp('nemesis-restore-', [], {}, {}, undefined, userData)
  try {
    await again.app.firstWindow()
    await expect.poll(async () => (await windows(again.app)).length).toBe(2)
    const [first, second] = await windows(again.app)
    if (first === undefined || second === undefined) throw new Error('two windows')
    expect(first.pages.map((page) => [page.url, page.title, page.partition])).toEqual([
      [a, 'node probe', 'persistent'],
      [b, 'window open', 'persistent'],
    ])
    expect(second.pages.map((page) => page.url)).toEqual([c])
    expect(first.cwd).toBe(second.cwd)

    // The current page is the one that was current, and loads once shown;
    // the other waits until it is looked at.
    const current = first.pages[1]
    expect(first.currentId).toBe(current?.id)
    await expect
      .poll(async () => (await windows(again.app))[0]?.pages.map((page) => page.loaded))
      .toEqual(['', b])
  } finally {
    await again.app.close()
  }

  // --no-restore skips the restore once: one window, no page.
  const bare = await launchApp('nemesis-restore-', ['--no-restore'], {}, {}, undefined, userData)
  try {
    await bare.app.firstWindow()
    await expect.poll(async () => (await windows(bare.app)).length).toBe(1)
    expect((await windows(bare.app))[0]?.pages).toEqual([])
  } finally {
    await bare.app.close()
    await fixtures.close()
  }
})
