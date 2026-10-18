import { net, protocol } from 'electron'
import { join, normalize, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { INTERNAL_SCHEME } from './navigation-policy'

/**
 * Where internal pages come from (#50, SECURITY.org T3).
 *
 * The cockpit, help and every later internal page are served from the
 * privileged `nemesis://app` origin, never from `file://`: a file: page can
 * read any file the user can, and its origin is opaque, so nothing can be
 * keyed on it. The scheme is `standard` (a real origin with a host, so
 * relative URLs and `'self'` mean something), `secure` (a secure context,
 * like https:), and it supports `fetch`. Every response carries the strict
 * Content Security Policy below as a header, which a page cannot edit the
 * way it could a meta tag.
 *
 * Registration has to happen before `app.whenReady` resolves, which is why
 * `registerInternalScheme` is called at module load in src/main/index.ts and
 * `serveInternalPages` from inside `whenReady`.
 */

/** The scheme without its colon, the way the protocol module spells it. */
export const SCHEME = INTERNAL_SCHEME.slice(0, -1)

/** The one host on the scheme. Any other host is a 404, whatever the path. */
export const INTERNAL_HOST = 'app'

/** The origin internal pages run on; the IPC sender check keys on it (#53). */
export const INTERNAL_ORIGIN = `${INTERNAL_SCHEME}//${INTERNAL_HOST}`

/** The URL the cockpit window loads. */
export const COCKPIT_URL = `${INTERNAL_ORIGIN}/`

/**
 * The policy on every internal response. Scripts come from the origin only:
 * no inline script, no eval, no remote script, nothing embedded, no base
 * element, no framing by anyone. Styles allow inline because CodeMirror
 * mounts its theme as style elements it writes at runtime; a style is not a
 * script, and the scripts that could write one are already confined.
 */
export const INTERNAL_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ')

/** The privileges the scheme is registered with, read back by the unit test. */
export const SCHEME_PRIVILEGES = Object.freeze({
  standard: true,
  secure: true,
  supportFetchAPI: true,
})

/** Registers the scheme as privileged. Main process, before the app is ready. */
export function registerInternalScheme(): void {
  protocol.registerSchemesAsPrivileged([{ scheme: SCHEME, privileges: { ...SCHEME_PRIVILEGES } }])
}

/**
 * The file under `root` a request URL names, or null when the URL is not on
 * the internal origin or would leave the root. `/` is the cockpit page. The
 * query and the fragment are ignored; a percent-encoded path is decoded
 * first so `%2e%2e` cannot slip past the check.
 */
export function resolveInternalPath(url: string, root: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== INTERNAL_SCHEME || parsed.host !== INTERNAL_HOST) return null
  let pathname: string
  try {
    pathname = decodeURIComponent(parsed.pathname)
  } catch {
    return null
  }
  if (pathname.includes('\0')) return null
  if (pathname.endsWith('/')) pathname += 'index.html'
  const base = resolve(root)
  const file = resolve(base, normalize(join('.', pathname)))
  return file.startsWith(base + sep) ? file : null
}

/** A refusal: no body that names the path, no detail a page could use. */
function notFound(): Response {
  return new Response('Not found', {
    status: 404,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'content-security-policy': INTERNAL_CSP,
    },
  })
}

/**
 * The handler for one request: the file from disk through Chromium's own
 * file loader, with the policy header added. On its own so the unit test can
 * run it on a fake fetch.
 */
export function internalRequestHandler(
  root: string,
  fetchFile: (url: string) => Promise<Response> = (url) => net.fetch(url),
): (request: Request) => Promise<Response> {
  return async (request) => {
    const file = resolveInternalPath(request.url, root)
    if (file === null) return notFound()
    let upstream: Response
    try {
      // Chromium's file loader rejects on a file that is not there instead
      // of answering 404; either way the page gets the same refusal.
      upstream = await fetchFile(pathToFileURL(file).toString())
    } catch {
      return notFound()
    }
    if (!upstream.ok) return notFound()
    const headers = new Headers(upstream.headers)
    headers.set('content-security-policy', INTERNAL_CSP)
    return new Response(upstream.body, { status: upstream.status, headers })
  }
}

/** Serves `root` (the built renderer) on the internal origin. After `whenReady`. */
export function serveInternalPages(root: string): void {
  protocol.handle(SCHEME, internalRequestHandler(root))
}
