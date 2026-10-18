import { expect, test } from '@playwright/test'
import { INTERNAL_SCHEME } from '../../../src/main/security/navigation-policy'
import { fixtureServer, launchNemesis } from './_harness'

/**
 * SECURITY.org, non-negotiables row 4: "New windows are controlled", asserted
 * the way the table asks, `window.open` from a page yields a controlled
 * buffer or nothing (#48, threat T1).
 *
 * The window-open fixture asks three ways: `window.open`, `window.open` with
 * features that beg for `nodeIntegration=yes`, and a `target=_blank` link.
 * Each time the page gets null back, no BrowserWindow appears, and the buffer
 * list grows by at most one controlled buffer. Today it grows by none: the
 * page buffer that would take the URL is M4 (#73), and the policy's hook for
 * it stays unwired until then.
 */

interface OpenWindow {
  readonly __windowOpen?: { readonly label: string; readonly handle: string }
  readonly open?: (url: string) => unknown
  readonly nemesis?: {
    buffers(): Promise<{ buffers: readonly { id: string; kind: string }[] }>
  }
}

const BLOCKED = /^navigation: blocked (\S+) to (\S+) from (\S+) contents (\d+)$/gm

test('window.open from a page yields a controlled buffer or nothing, never a bare window', async () => {
  const fixtures = await fixtureServer()
  const nemesis = await launchNemesis()
  let stderr = ''
  nemesis.app.process().stderr?.on('data', (chunk: Buffer | string) => {
    stderr += String(chunk)
  })
  const windows = (): Promise<number> =>
    nemesis.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)
  const buffers = async (): Promise<readonly { id: string; kind: string }[]> =>
    (await nemesis.window.evaluate(() => (globalThis as OpenWindow).nemesis?.buffers()))?.buffers ??
    []
  const blocked = (): string[][] =>
    Array.from(stderr.matchAll(BLOCKED), (match) => [
      match[1] ?? '',
      match[2] ?? '',
      match[3] ?? '',
    ])
  try {
    const buffersBefore = await buffers()
    expect(buffersBefore.length).toBeGreaterThan(0)

    const buffer = await nemesis.openPageBuffer(fixtures.url('window-open.html'))
    expect(buffer.loadError).toBeNull()
    await expect(buffer.page).toHaveTitle('window open')
    // The page buffer is itself one window in the harness; nothing else may appear.
    const windowsBefore = await windows()

    await buffer.page.click('#open-window')
    await expect(buffer.page.locator('#result')).toHaveText('window.open -> null')
    expect(await windows()).toBe(windowsBefore)

    await buffer.page.click('#open-named')
    await expect(buffer.page.locator('#result')).toHaveText('window.open features -> null')
    expect(await windows()).toBe(windowsBefore)

    await buffer.page.click('#blank-link')
    expect(await windows()).toBe(windowsBefore)
    // The link did not navigate the page in place either.
    await expect(buffer.page).toHaveTitle('window open')
    expect(buffer.page.url()).toBe(fixtures.url('window-open.html'))

    // file: is refused by the renderer before the main process hears of it;
    // still null, still no window.
    expect(
      await buffer.page.evaluate(() => {
        const handle = (globalThis as OpenWindow).open?.('file:///etc/hosts')
        return handle === null ? 'null' : typeof handle
      }),
    ).toBe('null')
    expect(await windows()).toBe(windowsBefore)

    // A URL the renderer does hand over and no buffer could hold is refused by
    // this app's handler and logged by scheme only: the evidence the handler
    // is live on the page buffer.
    expect(
      await buffer.page.evaluate((internal) => {
        const handle = (globalThis as OpenWindow).open?.(`${internal}//app/`)
        return handle === null ? 'null' : typeof handle
      }, INTERNAL_SCHEME),
    ).toBe('null')
    await expect.poll(blocked).toContainEqual(['window', INTERNAL_SCHEME, 'page'])
    expect(await windows()).toBe(windowsBefore)

    // The cockpit opens no windows either.
    expect(
      await nemesis.window.evaluate(() => {
        const handle = (globalThis as OpenWindow).open?.('https://example.test/')
        return handle === null ? 'null' : typeof handle
      }),
    ).toBe('null')
    expect(await windows()).toBe(windowsBefore)
    await expect(nemesis.window).toHaveTitle('Nemesis')

    // One controlled buffer at most, and it would be the main process's own.
    const buffersAfter = await buffers()
    const added = buffersAfter.filter((one) => !buffersBefore.some((b) => b.id === one.id))
    expect(added.length).toBeLessThanOrEqual(1)
    expect(buffersAfter.length - buffersBefore.length).toBe(added.length)

    // The hostile page never saw a window: a popup handle is the way to its opener.
    const last = await buffer.page.evaluate(() => (globalThis as OpenWindow).__windowOpen)
    expect(last?.handle).toBe('null')

    for (const line of stderr.split('\n').filter((one) => one.startsWith('navigation:'))) {
      expect(line).not.toContain('/etc/hosts')
      expect(line).not.toContain(fixtures.httpOrigin)
    }

    await buffer.close()
  } finally {
    await nemesis.close()
    await fixtures.close()
  }
})
