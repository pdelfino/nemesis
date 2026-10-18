import { expect, test } from '@playwright/test'
import { COCKPIT_URL, INTERNAL_CSP } from '../../../src/main/security/internal-scheme'
import { fixtureServer, launchNemesis } from './_harness'

/**
 * SECURITY.org, non-negotiables row 9: "Internal pages carry a strict CSP",
 * asserted the way the table asks, an injected inline script does not
 * execute (#50, threat T3).
 *
 * The cockpit is on nemesis://app, not file://, and the policy arrives as a
 * response header, which the spec reads back through `fetch` on the same
 * origin. Then the spec plays the attacker who got markup into the page:
 * an inline script element, an inline event handler and a script element
 * that points at the fixture server. Each one raises a policy violation,
 * none leaves a mark, and the fixture server is never asked for anything.
 * The policy has no 'unsafe-eval' either, which the spec reads off the
 * header rather than probing: code the debugger runs, as `evaluate` does,
 * is exempt from that part of the policy and would prove nothing.
 */

interface Violation {
  readonly directive: string
  readonly blocked: string
}

/** The page is written in the page's own terms: the specs compile with no DOM library. */
interface CspWindow {
  readonly __violations?: Violation[]
  readonly __pwned?: string
  readonly document?: {
    getElementById(id: string): unknown
    createElement(tag: string): InjectedElement
    readonly body: { appendChild(node: InjectedElement): void }
  }
  addEventListener(type: string, listener: (event: PolicyEvent) => void): void
  fetch(url: string): Promise<{ status: number; headers: { get(name: string): string | null } }>
}

interface InjectedElement {
  textContent: string
  src: string
  setAttribute(name: string, value: string): void
  click(): void
}

interface PolicyEvent {
  readonly violatedDirective: string
  readonly blockedURI: string
}

const INLINE_PWNED =
  "document.body.appendChild(Object.assign(document.createElement('p'), { id: 'pwned-inline' }))"
const HANDLER_PWNED =
  "document.body.appendChild(Object.assign(document.createElement('p'), { id: 'pwned-handler' }))"

test('the cockpit is on nemesis://app with a CSP header that stops inline, handler and remote scripts', async () => {
  const fixtures = await fixtureServer()
  const nemesis = await launchNemesis()
  try {
    // The origin: the privileged scheme, not file://.
    expect(nemesis.window.url()).toBe(COCKPIT_URL)
    await expect(nemesis.window.locator('#transcript')).toBeVisible()

    // The policy is a response header on the page and on its assets.
    const headers = await nemesis.window.evaluate(
      async (paths) => {
        const page = globalThis as unknown as CspWindow
        const out: Record<string, { status: number; csp: string | null }> = {}
        for (const path of paths) {
          const response = await page.fetch(path)
          out[path] = {
            status: response.status,
            csp: response.headers.get('content-security-policy'),
          }
        }
        return out
      },
      ['/', '/index.html', '/nope.html', '/../../package.json'],
    )
    expect(headers['/']).toEqual({ status: 200, csp: INTERNAL_CSP })
    expect(headers['/index.html']).toEqual({ status: 200, csp: INTERNAL_CSP })
    expect(headers['/nope.html']).toEqual({ status: 404, csp: INTERNAL_CSP })
    expect(headers['/../../package.json']).toEqual({ status: 404, csp: INTERNAL_CSP })

    // The policy says what the issue asks: scripts from the origin only, no
    // eval, nothing embedded, no base element, no framing.
    expect(INTERNAL_CSP).toMatch(/(^|; )script-src 'self'(;|$)/)
    expect(INTERNAL_CSP).not.toContain('unsafe-eval')
    expect(INTERNAL_CSP).toContain("object-src 'none'")
    expect(INTERNAL_CSP).toContain("base-uri 'none'")
    expect(INTERNAL_CSP).toContain("frame-ancestors 'none'")

    // Now the attacker who got markup into the page. Playwright's own
    // evaluate runs through the debugger, outside the policy; what it
    // appends is subject to it.
    const remote = fixtures.url('pwned.js')
    await nemesis.window.evaluate(
      ({ inline, handler, remote }) => {
        const page = globalThis as unknown as CspWindow
        const violations: Violation[] = []
        ;(page as { __violations?: Violation[] }).__violations = violations
        page.addEventListener('securitypolicyviolation', (event) => {
          violations.push({ directive: event.violatedDirective, blocked: event.blockedURI })
        })
        const { document } = page
        if (!document) throw new Error('no document')
        const inlineScript = document.createElement('script')
        inlineScript.textContent = inline
        document.body.appendChild(inlineScript)
        const button = document.createElement('button')
        button.setAttribute('id', 'pwned-button')
        button.setAttribute('onclick', handler)
        document.body.appendChild(button)
        button.click()
        const remoteScript = document.createElement('script')
        remoteScript.src = remote
        document.body.appendChild(remoteScript)
      },
      { inline: INLINE_PWNED, handler: HANDLER_PWNED, remote },
    )

    // Three violations, one per injection, and nothing ran.
    await expect
      .poll(() =>
        nemesis.window.evaluate(() => (globalThis as unknown as CspWindow).__violations ?? []),
      )
      .toEqual(
        expect.arrayContaining([
          { directive: 'script-src-elem', blocked: 'inline' },
          { directive: 'script-src-attr', blocked: 'inline' },
          { directive: 'script-src-elem', blocked: remote },
        ]),
      )
    expect(
      await nemesis.window.evaluate(() => {
        const page = globalThis as unknown as CspWindow
        return {
          pwned: page.__pwned ?? null,
          inline: page.document?.getElementById('pwned-inline') !== null,
          handler: page.document?.getElementById('pwned-handler') !== null,
          remote: page.document?.getElementById('pwned-remote') !== null,
        }
      }),
    ).toEqual({ pwned: null, inline: false, handler: false, remote: false })
    // The remote script was refused before any request: the fixture server
    // heard nothing.
    expect(fixtures.requested).toEqual([])

    // The page is intact and still the cockpit.
    expect(nemesis.window.url()).toBe(COCKPIT_URL)
    await expect(nemesis.window.locator('#app-name')).toHaveText('Nemesis')
  } finally {
    await nemesis.close()
    await fixtures.close()
  }
})
