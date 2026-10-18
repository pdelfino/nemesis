import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from 'node:http'
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https'
import { readFileSync, rmSync } from 'node:fs'
import { basename, extname, join, resolve } from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import { HARDENED_WEB_PREFERENCES } from '../../../src/main/security/web-preferences'
import { launchApp } from '../_launch'
import { selfSignedCertificate } from './_certificate'

/**
 * The harness every spec under tests/e2e/security shares (#46): a throwaway
 * profile, the mocked Agent SDK, hostile fixtures served over loopback HTTP
 * and HTTPS, and one teardown that leaves nothing behind.
 *
 * It is deliberately the only place that knows how to start the app for a
 * security spec. One spec per row of the non-negotiables table in SECURITY.org
 * copies tests/e2e/security/example.spec.ts and adds its own assertions.
 */

const FIXTURES = resolve(__dirname, 'fixtures')

/** Either fixture server: the two differ only in their transport. */
type FixtureListener = HttpServer | HttpsServer

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.bin': 'application/octet-stream',
}

export interface FixtureServer {
  /** `http://127.0.0.1:<port>`, a plain and therefore forbidden origin (T3). */
  readonly httpOrigin: string
  /** `https://127.0.0.1:<port>`, served with a certificate nothing trusts (T3). */
  readonly httpsOrigin: string
  /** The PEM certificate, for a client that wants to trust it on purpose. */
  readonly certificate: string
  /** The paths both servers were asked for, in order. */
  readonly requested: readonly string[]
  /** `url('node-probe.html')` for the plain origin. */
  url(fixture: string): string
  /** `secureUrl('node-probe.html')` for the HTTPS origin. */
  secureUrl(fixture: string): string
  close(): Promise<void>
}

function listen(server: FixtureListener): Promise<number> {
  return new Promise((done, fail) => {
    server.once('error', fail)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        fail(new Error('The fixture server did not get a loopback port'))
        return
      }
      done(address.port)
    })
  })
}

function closeServer(server: FixtureListener): Promise<void> {
  return new Promise((done) => {
    server.closeAllConnections()
    server.close(() => done())
  })
}

/**
 * Serves the fixtures and nothing else: a name outside tests/e2e/security/fixtures,
 * or with an extension that is not in the table above, is a 404.
 */
function serveFixtures(requested: string[]) {
  return (request: IncomingMessage, response: ServerResponse): void => {
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
    requested.push(path)

    const name = basename(path)
    const type = CONTENT_TYPES[extname(name)]
    if (type === undefined || name !== path.slice(1)) {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      response.end(`No fixture named ${path}\n`)
      return
    }

    let body: Buffer
    try {
      body = readFileSync(join(FIXTURES, name))
    } catch {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      response.end(`No fixture named ${path}\n`)
      return
    }

    const headers: Record<string, string> = {
      'content-type': type,
      'content-length': String(body.length),
    }
    // The download fixture has to arrive as an attachment to trigger T2.
    if (extname(name) === '.bin') {
      headers['content-disposition'] = `attachment; filename="${name}"`
    }
    response.writeHead(200, headers)
    response.end(body)
  }
}

/**
 * Starts both fixture servers on random loopback ports. The ports are printed
 * because a spec that fails against a fixture is read from the terminal.
 */
export async function fixtureServer(): Promise<FixtureServer> {
  const requested: string[] = []
  const handler = serveFixtures(requested)
  const { key, certificate } = selfSignedCertificate()

  const plain = createHttpServer(handler)
  const secure = createHttpsServer({ key, cert: certificate }, handler)
  const [httpPort, httpsPort] = await Promise.all([listen(plain), listen(secure)])

  const httpOrigin = `http://127.0.0.1:${httpPort}`
  const httpsOrigin = `https://127.0.0.1:${httpsPort}`
  console.log(`[fixtures] ${httpOrigin} and ${httpsOrigin} serving ${FIXTURES}`)

  return {
    httpOrigin,
    httpsOrigin,
    certificate,
    requested,
    url: (fixture) => `${httpOrigin}/${fixture}`,
    secureUrl: (fixture) => `${httpsOrigin}/${fixture}`,
    close: async () => {
      await Promise.all([closeServer(plain), closeServer(secure)])
    },
  }
}

/** A web page opened by the app, the way a buffer will hold one. */
export interface PageBuffer {
  /** Playwright's handle on the page, for `evaluate` and locators. */
  readonly page: Page
  /** Chromium's reason for refusing to load, or null when the load committed. */
  readonly loadError: string | null
  close(): Promise<void>
}

export interface PageBufferOptions {
  readonly withPreload?: boolean
}

export interface Nemesis {
  readonly app: ElectronApplication
  /** The cockpit window, the one internal page with the preload bridge. */
  readonly window: Page
  /** The throwaway profile, deleted by `close`. */
  readonly userData: string
  /**
   * Opens a URL in a hardened, preload-free WebContents, as a page buffer.
   * `withPreload` attaches the cockpit's preload to the hostile page instead,
   * which no page buffer ever gets: it is how the IPC spec reaches a
   * privileged channel from a web origin (#53).
   */
  openPageBuffer(url: string, options?: PageBufferOptions): Promise<PageBuffer>
  close(): Promise<void>
}

/**
 * Launches the built app against a throwaway profile, with NODE_ENV=test so
 * the main process resolves the deterministic Agent SDK mock (src/main/agent/mock.ts)
 * and never reaches the network or an account.
 */
export async function launchNemesis(): Promise<Nemesis> {
  // Fake camera and microphone devices (#49): with the real ones, a
  // microphone request from a page buffer sat in Chromium's audio capture
  // on macOS and never reached the app's permission handler, whatever the
  // system's own permission said. The fake devices skip that stack, so the
  // request reaches the handler, which is the control under test. The
  // switch grants nothing: that would be `--use-fake-ui-for-media-stream`,
  // which no spec may pass.
  const { app, userData } = await launchApp('nemesis-security-', [
    '--use-fake-device-for-media-stream',
  ])
  const window = await app.firstWindow()
  await window.waitForLoadState('domcontentloaded')

  const buffers: PageBuffer[] = []

  const openPageBuffer = async (
    url: string,
    options: PageBufferOptions = {},
  ): Promise<PageBuffer> => {
    const opened = app.waitForEvent('window')
    const created = await app.evaluate(
      async ({ app: main, BrowserWindow }, options) => {
        // A web page gets the hardened defaults and no preload: the bridge
        // belongs to internal pages only (SECURITY.org, T1). The one spec
        // that asks for the preload gets the built one, from the app path
        // the main process already knows.
        const preload = options.withPreload
          ? { preload: `${main.getAppPath()}/out/preload/index.js` }
          : {}
        const view = new BrowserWindow({
          show: false,
          width: 1000,
          height: 700,
          webPreferences: { ...options.webPreferences, ...preload },
        })
        try {
          await view.loadURL(options.url)
          return { id: view.id, loadError: null as string | null }
        } catch (error) {
          return { id: view.id, loadError: error instanceof Error ? error.message : String(error) }
        }
      },
      {
        url,
        webPreferences: { ...HARDENED_WEB_PREFERENCES },
        withPreload: options.withPreload === true,
      },
    )

    const page = await opened
    const buffer: PageBuffer = {
      page,
      loadError: created.loadError,
      close: async () => {
        await app.evaluate(({ BrowserWindow }, id) => {
          BrowserWindow.fromId(id)?.destroy()
        }, created.id)
      },
    }
    buffers.push(buffer)
    return buffer
  }

  return {
    app,
    window,
    userData,
    openPageBuffer,
    close: async () => {
      for (const buffer of buffers.reverse()) {
        await buffer.close().catch(() => undefined)
      }
      await app.close()
      rmSync(userData, { recursive: true, force: true })
    },
  }
}
