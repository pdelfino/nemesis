import { resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The internal scheme (#50, SECURITY.org T3) on fakes: the registration asks
 * for the three privileges the issue names, a request URL maps to a file
 * under the renderer root and nowhere else, and every response, a refusal
 * included, carries the policy header. The live run is
 * tests/e2e/security/internal-csp.spec.ts.
 */

const registered = vi.fn()
const handled = vi.fn()
vi.mock('electron', () => ({
  protocol: { registerSchemesAsPrivileged: registered, handle: handled },
  net: { fetch: vi.fn() },
}))

const {
  COCKPIT_URL,
  INTERNAL_CSP,
  INTERNAL_HOST,
  INTERNAL_ORIGIN,
  SCHEME,
  SCHEME_PRIVILEGES,
  internalRequestHandler,
  registerInternalScheme,
  resolveInternalPath,
  resolveUserPage,
  serveInternalPages,
  serveUserPages,
  USER_PAGE_CSP,
  userPageRequestHandler,
  userPageUrl,
} = await import('../../src/main/security/internal-scheme')
const { INTERNAL_SCHEME } = await import('../../src/main/security/navigation-policy')
const { INTERNAL_ORIGINS } = await import('../../src/main/ipc')

const ROOT = resolve('/app/out/renderer')

describe('the scheme and the origin', () => {
  it('is the scheme the navigation policy lets an internal page reach', () => {
    expect(`${SCHEME}:`).toBe(INTERNAL_SCHEME)
    expect(INTERNAL_ORIGIN).toBe(`nemesis://${INTERNAL_HOST}`)
    expect(COCKPIT_URL).toBe('nemesis://app/')
  })

  it('is the one origin the IPC sender check accepts', () => {
    expect(INTERNAL_ORIGINS).toEqual([INTERNAL_ORIGIN])
  })

  it('is registered standard, secure and with fetch, before the app is ready', () => {
    registerInternalScheme()
    expect(registered).toHaveBeenCalledWith([
      { scheme: 'nemesis', privileges: { standard: true, secure: true, supportFetchAPI: true } },
    ])
    expect(SCHEME_PRIVILEGES).toEqual({ standard: true, secure: true, supportFetchAPI: true })
  })

  it('installs one handler for the scheme', () => {
    serveInternalPages(ROOT)
    expect(handled).toHaveBeenCalledWith('nemesis', expect.any(Function))
  })
})

describe('the policy', () => {
  const directives = new Map(
    INTERNAL_CSP.split('; ').map((one) => {
      const [name, ...values] = one.split(' ')
      return [name, values] as const
    }),
  )

  it('allows scripts from the origin only: no inline, no eval, no remote', () => {
    expect(directives.get('default-src')).toEqual(["'self'"])
    expect(directives.get('script-src')).toEqual(["'self'"])
    expect(INTERNAL_CSP).not.toContain('unsafe-eval')
    expect(INTERNAL_CSP).not.toContain('http:')
    expect(INTERNAL_CSP).not.toContain('https:')
  })

  it('embeds nothing, rebases nothing, is framed by no one, posts nowhere', () => {
    expect(directives.get('object-src')).toEqual(["'none'"])
    expect(directives.get('base-uri')).toEqual(["'none'"])
    expect(directives.get('frame-ancestors')).toEqual(["'none'"])
    expect(directives.get('form-action')).toEqual(["'none'"])
  })

  it('allows inline styles and nothing else inline, for CodeMirror', () => {
    expect(directives.get('style-src')).toEqual(["'self'", "'unsafe-inline'"])
    for (const [name, values] of directives) {
      if (name !== 'style-src') expect(values, name).not.toContain("'unsafe-inline'")
    }
  })
})

describe('what a request URL names', () => {
  it('maps the root and a path to files under the renderer root', () => {
    expect(resolveInternalPath('nemesis://app/', ROOT)).toBe(resolve(ROOT, 'index.html'))
    expect(resolveInternalPath('nemesis://app/index.html', ROOT)).toBe(resolve(ROOT, 'index.html'))
    expect(resolveInternalPath('nemesis://app/assets/index-abc.js', ROOT)).toBe(
      resolve(ROOT, 'assets', 'index-abc.js'),
    )
    expect(resolveInternalPath('nemesis://app/assets/?v=1#frag', ROOT)).toBe(
      resolve(ROOT, 'assets', 'index.html'),
    )
    expect(resolveInternalPath('nemesis://app/a%20b.html', ROOT)).toBe(resolve(ROOT, 'a b.html'))
  })

  it('refuses another host, another scheme and anything unparseable', () => {
    expect(resolveInternalPath('nemesis://evil/index.html', ROOT)).toBeNull()
    expect(resolveInternalPath('nemesis://app.evil.test/', ROOT)).toBeNull()
    expect(resolveInternalPath('nemesis:///index.html', ROOT)).toBeNull()
    expect(resolveInternalPath('file:///app/out/renderer/index.html', ROOT)).toBeNull()
    expect(resolveInternalPath('https://app/', ROOT)).toBeNull()
    expect(resolveInternalPath('not a url', ROOT)).toBeNull()
  })

  it('never resolves outside the root, whatever the path says', () => {
    // The URL parser collapses a dot segment, encoded or not, before the
    // path is read, so these land inside the root or nowhere; the check on
    // the resolved path is the second line, for a parser that did not.
    for (const path of [
      '/../package.json',
      '/../../etc/passwd',
      '/assets/../../package.json',
      '/%2e%2e/package.json',
      '/..%2fpackage.json',
      '/%2e%2e%2f%2e%2e%2fetc%2fpasswd',
      '/assets/%00/../../package.json',
      '/%ZZ',
    ]) {
      const file = resolveInternalPath(`nemesis://app${path}`, ROOT)
      expect(file, path).toSatisfy(
        (one: string | null) => one === null || one.startsWith(ROOT + sep),
      )
    }
    expect(resolveInternalPath('nemesis://app/..%2fpackage.json', ROOT)).toBeNull()
    expect(resolveInternalPath('nemesis://app/assets/%00/x', ROOT)).toBeNull()
    expect(resolveInternalPath('nemesis://app/%ZZ', ROOT)).toBeNull()
  })
})

describe('the handler', () => {
  const fetchFile = vi.fn<(url: string) => Promise<Response>>()
  const handler = internalRequestHandler(ROOT, fetchFile)

  beforeEach(() => {
    fetchFile.mockReset()
  })

  it('serves a file off disk with the policy header added', async () => {
    fetchFile.mockResolvedValue(
      new Response('<!doctype html>', { status: 200, headers: { 'content-type': 'text/html' } }),
    )
    const response = await handler(new Request('nemesis://app/'))
    expect(fetchFile).toHaveBeenCalledWith(pathToFileURL(resolve(ROOT, 'index.html')).toString())
    expect(response.status).toBe(200)
    expect(response.headers.get('content-security-policy')).toBe(INTERNAL_CSP)
    expect(response.headers.get('content-type')).toBe('text/html')
    expect(await response.text()).toBe('<!doctype html>')
  })

  it('answers 404 with the policy header and never reads disk for a URL outside the root', async () => {
    for (const url of ['nemesis://app/..%2fpackage.json', 'nemesis://evil/', 'nemesis://app/%ZZ']) {
      const response = await handler(new Request(url))
      expect(response.status, url).toBe(404)
      expect(response.headers.get('content-security-policy'), url).toBe(INTERNAL_CSP)
      expect(await response.text(), url).not.toContain('package.json')
    }
    expect(fetchFile).not.toHaveBeenCalled()
  })

  it('turns a file that is not there into the same 404, whether the loader answers or throws', async () => {
    fetchFile.mockResolvedValueOnce(new Response('', { status: 404 }))
    fetchFile.mockRejectedValueOnce(new TypeError('net::ERR_FILE_NOT_FOUND'))
    for (const url of ['nemesis://app/nope.html', 'nemesis://app/gone.html']) {
      const response = await handler(new Request(url))
      expect(response.status, url).toBe(404)
      expect(response.headers.get('content-security-policy'), url).toBe(INTERNAL_CSP)
    }
  })
})

describe('config pages (#181)', () => {
  it('resolves a user page path to its name and its params', () => {
    expect(resolveUserPage('nemesis://app/user/tools')).toEqual({ name: 'tools', params: {} })
    expect(resolveUserPage('nemesis://app/user/word-count?text=a%20b&n=2&n=3')).toEqual({
      name: 'word-count',
      params: { text: 'a b', n: '2' },
    })
    expect(resolveUserPage(userPageUrl('tools', { q: 'x&y' }))).toEqual({
      name: 'tools',
      params: { q: 'x&y' },
    })
  })

  it('resolves no traversal, no other path, no other host and no name that is not kebab-case', () => {
    for (const url of [
      'nemesis://app/user/../index.html',
      'nemesis://app/user/%2e%2e/index.html',
      'nemesis://app/user/..%2findex.html',
      'nemesis://app/user/%2E%2E%2Fpackage.json',
      'nemesis://app/user/tools/../../index.html',
      'nemesis://app/user/tools/extra',
      'nemesis://app/user/',
      'nemesis://app/user/Tools',
      'nemesis://app/user/tools%00',
      'nemesis://app/index.html',
      'nemesis://app/',
      'nemesis://evil/user/tools',
      'https://app/user/tools',
      'not a url',
      `nemesis://app/user/${'a'.repeat(65)}`,
      `nemesis://app/user/tools?q=${'a'.repeat(8192)}`,
    ]) {
      expect(resolveUserPage(url), url).toBeNull()
    }
  })

  it('serves what render answers under the user page policy, which runs no script', async () => {
    const render = vi.fn((page: { name: string }) =>
      page.name === 'tools' ? '<button data-command="x">x</button>' : null,
    )
    const handler = userPageRequestHandler(render)
    const response = await handler(new Request('nemesis://app/user/tools?q=1'))
    expect(response.status).toBe(200)
    expect(response.headers.get('content-security-policy')).toBe(USER_PAGE_CSP)
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(await response.text()).toBe('<button data-command="x">x</button>')
    expect(render).toHaveBeenCalledWith({ name: 'tools', params: { q: '1' } })
    const directives = USER_PAGE_CSP.split('; ')
    expect(directives).toContain("script-src 'none'")
    expect(directives).toContain("default-src 'none'")
    expect(directives).toContain("form-action 'none'")
    expect(directives).toContain("frame-ancestors 'none'")
    expect(USER_PAGE_CSP).not.toContain("'self'")
    expect(USER_PAGE_CSP).not.toContain('unsafe-eval')
  })

  it('answers 404 for a page render knows nothing of, and never asks render for a traversal', async () => {
    const render = vi.fn(() => null)
    const handler = userPageRequestHandler(render)
    expect((await handler(new Request('nemesis://app/user/missing'))).status).toBe(404)
    expect(render).toHaveBeenCalledTimes(1)
    for (const url of ['nemesis://app/user/%2e%2e/index.html', 'nemesis://app/index.html']) {
      expect((await handler(new Request(url))).status, url).toBe(404)
    }
    expect(render).toHaveBeenCalledTimes(1)
  })

  it('installs its handler on the session it is given, not on the default protocol', () => {
    const own = vi.fn()
    handled.mockClear()
    serveUserPages({ protocol: { handle: own } } as never, () => null)
    expect(own).toHaveBeenCalledWith('nemesis', expect.any(Function))
    expect(handled).not.toHaveBeenCalled()
  })

  it('reads the same scheme and host as the shared parser the preload uses', async () => {
    const shared = await import('../../src/shared/user-pages')
    expect(shared.USER_PAGE_SCHEME).toBe(INTERNAL_SCHEME)
    expect(shared.USER_PAGE_HOST).toBe(INTERNAL_HOST)
  })

  it('leaves the app pages and their policy as they were', () => {
    expect(USER_PAGE_CSP).not.toBe(INTERNAL_CSP)
    expect(resolveInternalPath('nemesis://app/', ROOT)).toBe(resolve(ROOT, 'index.html'))
  })
})
