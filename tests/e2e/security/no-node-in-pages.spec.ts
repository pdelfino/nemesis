import { expect, test } from '@playwright/test'
import { fixtureServer, launchNemesis } from './_harness'

/**
 * SECURITY.org, non-negotiables row 1: "No page can see `process`, `require` or
 * any Node global", asserted the way the table asks, by loading a page and
 * evaluating the names in it (#47, threat T1).
 *
 * The page is the hostile node-probe fixture, and the assertions cover the main
 * world, a dedicated worker (`nodeIntegrationInWorker`), a subframe
 * (`nodeIntegrationInSubFrames`) and the cockpit's own internal page, which is
 * isolated even though it carries the preload bridge.
 */

interface ProbeWindow {
  readonly __nodeProbe?: { readonly found: Record<string, string>; readonly leaked: string[] }
  readonly nemesis?: { readonly name: string }
}

/** Every name a page would reach for on the way out of the renderer. */
const NODE_GLOBALS = [
  'process',
  'require',
  'module',
  'exports',
  'global',
  'Buffer',
  '__dirname',
  '__filename',
  'setImmediate',
  'electron',
] as const

test('a web page sees no Node global, in the page, a worker or a subframe', async () => {
  const fixtures = await fixtureServer()
  const nemesis = await launchNemesis()
  try {
    const buffer = await nemesis.openPageBuffer(fixtures.url('node-probe.html'))
    expect(buffer.loadError).toBeNull()

    // The two names the issue names, read straight out of the page.
    expect(await buffer.page.evaluate(() => typeof process)).toBe('undefined')
    expect(await buffer.page.evaluate(() => typeof require)).toBe('undefined')

    // The rest of the way out, one name at a time, so a failure says which.
    const kinds = await buffer.page.evaluate(
      (names) =>
        Object.fromEntries(
          names.map((name) => {
            try {
              return [name, typeof (globalThis as Record<string, unknown>)[name]]
            } catch {
              return [name, 'throws']
            }
          }),
        ),
      [...NODE_GLOBALS],
    )
    for (const name of NODE_GLOBALS) {
      expect(kinds[name], `${name} is reachable from a web page`).toBe('undefined')
    }

    // The fixture's own verdict, computed in the page before any spec ran.
    await expect(buffer.page.locator('#verdict')).toHaveText('clean')
    expect(
      (await buffer.page.evaluate(() => (globalThis as ProbeWindow).__nodeProbe))?.leaked,
    ).toEqual([])

    // No bridge on a web page: the preload belongs to internal pages only.
    expect(await buffer.page.evaluate(() => (globalThis as ProbeWindow).nemesis)).toBeUndefined()

    // The cockpit page does carry the bridge, and still no Node: that is what
    // contextIsolation plus sandbox buy, and the bridge is the whole surface.
    expect(await nemesis.window.evaluate(() => typeof process)).toBe('undefined')
    expect(await nemesis.window.evaluate(() => typeof require)).toBe('undefined')
    expect(await nemesis.window.evaluate(() => (globalThis as ProbeWindow).nemesis?.name)).toBe(
      'nemesis',
    )

    // nodeIntegrationInWorker: false and nodeIntegrationInSubFrames: false. A
    // worker is a second renderer thread and a subframe is a page of its own,
    // so each would be a second way out if it were not covered too. The probes
    // are page source on purpose: the specs compile against ES2022 with no DOM
    // library, and a hostile page is written in the page's own terms.
    //
    // They get a page buffer of their own because the probe fixture declares
    // `var name` at top level, which sets its frame's `window.name` to the last
    // name it tried, `nemesis`. A frame that names itself becomes a property of
    // its parent window, so an embedded probe would shadow the `nemesis` the
    // assertions above read. Harmless here, and a reason never to trust a
    // global by name on a page that embeds another.
    const probes = await nemesis.openPageBuffer(fixtures.url('node-probe.html'))
    await probes.page.setContent(`
      <p id="worker">pending</p>
      <iframe id="child" src="${fixtures.url('node-probe.html')}"></iframe>
      <script>
        var source = 'postMessage([typeof process, typeof require].join(","))'
        var worker = new Worker(URL.createObjectURL(new Blob([source], { type: 'text/javascript' })))
        worker.onmessage = function (event) {
          document.getElementById('worker').textContent = event.data
        }
      </script>
    `)
    await expect(probes.page.locator('#worker')).toHaveText('undefined,undefined')
    await expect(probes.page.frameLocator('#child').locator('#verdict')).toHaveText('clean')

    await probes.close()
    await buffer.close()
  } finally {
    await nemesis.close()
    await fixtures.close()
  }
})
