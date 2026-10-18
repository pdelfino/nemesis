import { get } from 'node:https'
import { expect, test } from '../_test'
import { fixtureServer, launchNemesis } from './_harness'

/**
 * The harness proving itself (#46). Every other spec in this directory starts
 * from this shape: fixtures up, app up, assertions, teardown in `finally`.
 * This one asserts the first row of the non-negotiables table as its example,
 * no page can see a Node global; the full spec for that row is #47.
 */

interface ProbeWindow {
  readonly __nodeProbe?: { readonly found: Record<string, string>; readonly leaked: string[] }
  readonly nemesis?: { readonly name: string }
}

/** Reads a fixture over HTTPS, trusting the harness certificate on purpose. */
function fetchTrusted(url: string, certificate: string): Promise<string> {
  return new Promise((done, fail) => {
    const request = get(url, { ca: certificate, servername: 'localhost' }, (response) => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', (chunk) => {
        body += chunk
      })
      response.on('end', () => done(`${response.statusCode} ${body.length}`))
    })
    request.on('error', fail)
  })
}

test('the harness serves hostile fixtures to a hardened page buffer', async () => {
  const fixtures = await fixtureServer()
  const nemesis = await launchNemesis()
  try {
    // The cockpit window is an internal page, so it has the preload bridge.
    expect(await nemesis.window.evaluate(() => (globalThis as ProbeWindow).nemesis?.name)).toBe(
      'nemesis',
    )

    const buffer = await nemesis.openPageBuffer(fixtures.url('node-probe.html'))
    expect(buffer.loadError).toBeNull()
    await expect(buffer.page).toHaveTitle('node probe')

    // The fixture's own verdict, computed in the page.
    await expect(buffer.page.locator('#verdict')).toHaveText('clean')
    const probe = await buffer.page.evaluate(() => (globalThis as ProbeWindow).__nodeProbe)
    expect(probe?.leaked).toEqual([])
    expect(probe?.found['process']).toBe('undefined')
    expect(probe?.found['require']).toBe('undefined')

    // A web page is not an internal page: no bridge, whatever the fixture asks for.
    expect(await buffer.page.evaluate(() => (globalThis as ProbeWindow).nemesis)).toBeUndefined()

    // The 404 path is a 404, so a spec cannot pass against a fixture that is gone.
    const missing = await buffer.page.evaluate(
      async (url) => (await fetch(url)).status,
      fixtures.url('no-such-fixture.html'),
    )
    expect(missing).toBe(404)

    // The HTTPS server answers too, with the certificate generated for this run.
    expect(await fetchTrusted(fixtures.secureUrl('injection.html'), fixtures.certificate)).toMatch(
      /^200 \d+$/,
    )

    // The download fixture arrives as a one kilobyte attachment (SECURITY.org, T2).
    const attachment = await buffer.page.evaluate(async (url) => {
      const response = await fetch(url)
      return {
        disposition: response.headers.get('content-disposition'),
        bytes: (await response.arrayBuffer()).byteLength,
      }
    }, fixtures.url('download.bin'))
    expect(attachment).toEqual({
      disposition: 'attachment; filename="download.bin"',
      bytes: 1024,
    })

    expect(fixtures.requested).toContain('/node-probe.html')

    await buffer.close()
  } finally {
    await nemesis.close()
    await fixtures.close()
  }
})
