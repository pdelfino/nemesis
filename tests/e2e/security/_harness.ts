import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from 'node:http'
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, extname, join, resolve } from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import { HARDENED_WEB_PREFERENCES } from '../../../src/main/security/web-preferences'
import { launchApp } from '../_launch'
import { selfSignedCertificate, type SelfSignedCertificate } from './_certificate'

/**
 * The harness every spec under tests/e2e/security shares (#46): a throwaway
 * profile, the mocked Agent SDK, hostile fixtures served over loopback HTTP
 * and HTTPS, and one teardown that leaves nothing behind.
 *
 * It is deliberately the only place that knows how to start the app for a
 * security spec. One spec per row of the non-negotiables table in SECURITY.org
 * copies tests/e2e/security/example.spec.ts and adds its own assertions.
 *
 * Transport (#52, T3): the app is HTTPS-only off loopback and a certificate
 * error is fatal, so a spec loads its hostile page from `secureUrl(...)`, and
 * the launch trusts this run's fixture certificate on purpose: the PEM is
 * written next to the throwaway profile and named by `NEMESIS_TEST_CA`, which
 * the main process reads only under `NODE_ENV=test`. One certificate serves
 * the fixture server and every launch of a run, so the two need no handshake.
 * `launchNemesis({ trustFixtures: false })` is the launch that does not
 * trust it, for the spec that watches the refusal.
 */

/**
 * A name off loopback that the app resolves to the fixture server, through
 * Chromium's `--host-resolver-rules` on the test launch only. `.test` is
 * reserved (RFC 2606) and never resolves outside this mapping, and the rule
 * keeps the port, so a plain `http:` URL on this host is what the upgrade of
 * #52 acts on, with the fixture server on the other end of the upgrade.
 */
export const OFF_LOOPBACK_HOST = 'nemesis.test'

let issued: SelfSignedCertificate | null = null

/** This run's fixture certificate, issued once per worker and shared by the server and the launches. */
function runCertificate(): SelfSignedCertificate {
  issued ??= selfSignedCertificate('nemesis-fixtures', ['localhost', OFF_LOOPBACK_HOST])
  return issued
}

const FIXTURES = resolve(__dirname, 'fixtures')

/** Either fixture server: the two differ only in their transport. */
type FixtureListener = HttpServer | HttpsServer

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.bin': 'application/octet-stream',
}

export interface FixtureServer {
  /** `http://127.0.0.1:<port>`, plain, and allowed because it is loopback (T3, #52). */
  readonly httpOrigin: string
  /** `https://127.0.0.1:<port>`, served with this run's certificate, trusted by a launch on purpose (T3). */
  readonly httpsOrigin: string
  /** The PEM certificate, for a client that wants to trust it on purpose. */
  readonly certificate: string
  /** The paths both servers were asked for, in order. */
  readonly requested: readonly string[]
  /** `url('node-probe.html')` for the plain loopback origin. */
  url(fixture: string): string
  /** `secureUrl('node-probe.html')` for the HTTPS origin: how a spec loads a hostile page. */
  secureUrl(fixture: string): string
  /**
   * `http://nemesis.test:<https port>/...`: plain `http:` off loopback whose
   * upgrade to `https:` lands on the HTTPS server, same port (T3, #52).
   */
  upgradableUrl(fixture: string): string
  /**
   * `http://nemesis.test:<http port>/...`: plain `http:` off loopback whose
   * upgrade cannot land, because the plain server speaks no TLS (T3, #52).
   */
  offLoopbackUrl(fixture: string): string
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
  const { key, certificate } = runCertificate()

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
    upgradableUrl: (fixture) => `http://${OFF_LOOPBACK_HOST}:${httpsPort}/${fixture}`,
    offLoopbackUrl: (fixture) => `http://${OFF_LOOPBACK_HOST}:${httpPort}/${fixture}`,
    close: async () => {
      await Promise.all([closeServer(plain), closeServer(secure)])
    },
  }
}

/** The test-only door src/main/index.ts installs for the page buffers (#119). */
interface PageDoor {
  open(url: string): Promise<{
    readonly windowId: number
    readonly bufferId: string
    readonly contentsId: number
    readonly loadError: string | null
  }>
  close(windowId: number, bufferId: string): void
}

/** A web page opened by the app in a page buffer (#119), or, with the preload, in a bare window. */
export interface PageBuffer {
  /** Playwright's handle on the page, for `evaluate` and locators. */
  readonly page: Page
  /** Chromium's reason for refusing to load, or null when the load committed. */
  readonly loadError: string | null
  /** The id of the page's WebContents, as the main process's log lines name it. */
  readonly contentsId: number
  close(): Promise<void>
}

export interface PageBufferOptions {
  readonly withPreload?: boolean
}

export interface LaunchOptions {
  /**
   * Trust this run's fixture certificate through the test-only anchor
   * (`NEMESIS_TEST_CA`, #52). On by default; the HTTPS-only spec turns it
   * off to watch the certificate error be fatal.
   */
  readonly trustFixtures?: boolean
}

export interface Nemesis {
  readonly app: ElectronApplication
  /** The cockpit window, the one internal page with the preload bridge. */
  readonly window: Page
  /** The throwaway profile, deleted by `close`. */
  readonly userData: string
  /** The downloads path of this launch, inside the profile; the quarantine folder is under it (#51). */
  readonly downloadsDir: string
  /**
   * Opens a URL in a real page buffer of the focused window (#119): the
   * app's hardened, preload-free WebContentsView, made current.
   * `withPreload` attaches the cockpit's preload to the hostile page in a
   * bare window instead, which no page buffer ever gets: it is how the IPC
   * spec reaches a privileged channel from a web origin (#53).
   */
  openPageBuffer(url: string, options?: PageBufferOptions): Promise<PageBuffer>
  close(): Promise<void>
}

/**
 * Launches the built app against a throwaway profile, with NODE_ENV=test so
 * the main process resolves the deterministic Agent SDK mock (src/main/agent/mock.ts)
 * and never reaches the network or an account.
 */
export async function launchNemesis(options: LaunchOptions = {}): Promise<Nemesis> {
  // The anchor lives in its own throwaway directory, deleted with the profile.
  const anchorDir = mkdtempSync(join(tmpdir(), 'nemesis-security-ca-'))
  const anchorPath = join(anchorDir, 'fixtures-ca.pem')
  writeFileSync(anchorPath, runCertificate().certificate)
  const env = options.trustFixtures === false ? {} : { NEMESIS_TEST_CA: anchorPath }
  // Fake camera and microphone devices (#49): with the real ones, a
  // microphone request from a page buffer sat in Chromium's audio capture
  // on macOS and never reached the app's permission handler, whatever the
  // system's own permission said. The fake devices skip that stack, so the
  // request reaches the handler, which is the control under test. The
  // switch grants nothing: that would be `--use-fake-ui-for-media-stream`,
  // which no spec may pass. The resolver rule maps the off-loopback fixture
  // name to the loopback servers, port kept (#52).
  const { app, userData, downloadsDir } = await launchApp(
    'nemesis-security-',
    [
      '--use-fake-device-for-media-stream',
      `--host-resolver-rules=MAP ${OFF_LOOPBACK_HOST} 127.0.0.1`,
    ],
    {},
    env,
  )
  const window = await app.firstWindow()
  await window.waitForLoadState('domcontentloaded')

  const buffers: PageBuffer[] = []

  const openPageBuffer = async (
    url: string,
    options: PageBufferOptions = {},
  ): Promise<PageBuffer> => {
    const opened = app.waitForEvent('window')
    if (options.withPreload !== true) {
      // A real page buffer (#119): the app's own WebContentsView, built by
      // src/main/page-buffer.ts under the baseline, opened in the focused
      // window and made current, through the test-only door in index.ts.
      const real = await app.evaluate(async (_main, target) => {
        const door = (globalThis as { __nemesisPages?: PageDoor }).__nemesisPages
        if (door === undefined) throw new Error('The app has no page door: is NODE_ENV=test?')
        return door.open(target)
      }, url)
      const page = await opened
      const buffer: PageBuffer = {
        page,
        loadError: real.loadError,
        contentsId: real.contentsId,
        close: async () => {
          await app.evaluate(
            (_main, { windowId, bufferId }) => {
              ;(globalThis as { __nemesisPages?: PageDoor }).__nemesisPages?.close(
                windowId,
                bufferId,
              )
            },
            { windowId: real.windowId, bufferId: real.bufferId },
          )
        },
      }
      buffers.push(buffer)
      return buffer
    }
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
          return { id: view.id, contentsId: view.webContents.id, loadError: null as string | null }
        } catch (error) {
          return {
            id: view.id,
            contentsId: view.webContents.id,
            loadError: error instanceof Error ? error.message : String(error),
          }
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
      contentsId: created.contentsId,
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
    downloadsDir,
    openPageBuffer,
    close: async () => {
      for (const buffer of buffers.reverse()) {
        await buffer.close().catch(() => undefined)
      }
      await app.close()
      rmSync(userData, { recursive: true, force: true })
      rmSync(anchorDir, { recursive: true, force: true })
    },
  }
}
