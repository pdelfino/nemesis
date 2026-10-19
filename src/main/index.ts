import {
  app,
  BrowserWindow,
  clipboard,
  desktopCapturer,
  nativeImage,
  nativeTheme,
  session,
  type WebContentsView,
} from 'electron'
import { join } from 'node:path'
import type { ClipboardImage } from './agent/images'
import type { EventSource } from './agent/session-bridge'
import { createCockpit, mergeNotices, type Cockpit } from './cockpit'
import { confirm, DOWNLOAD_SOURCE, EXTERNAL_SOURCE, WORKTREE_SOURCE } from './commands/confirm'
import {
  cockpitKeymapLayers,
  createCockpitRegistry,
  setUserKeymap,
  type CockpitWindows,
} from './commands/keyscheme'
import {
  CommandError,
  defineCommand,
  type Command,
  type CommandRegistry,
} from './commands/registry'
import { ConfigEval, type EvalOutcome } from './config/eval'
import { Journal, journalPath } from './config/journal'
import { ConfigLoader, configPath, renderProblem, type ConfigTarget } from './config/loader'
import type { HelpBuffers } from './help'
import { McpDoor } from './mcp/socket'
import type { PagePolicies } from './page-buffer'
import { installMenu } from './menu'
import type { WindowCapturer } from './screenshots'
import { assertWebContentsHardened } from './security/assert-web-preferences'
import { describeDownload, DownloadPolicy, QUARANTINE_FOLDER } from './security/downloads'
import { describeExternal, ExternalPolicy } from './security/external'
import {
  COCKPIT_URL,
  INTERNAL_ORIGIN,
  registerInternalScheme,
  serveInternalPages,
} from './security/internal-scheme'
import { applyNavigationPolicy } from './security/navigation-policy'
import {
  applyWebRTCPolicy,
  createPartitions,
  EPHEMERAL_PARTITION,
  PERSISTENT_PARTITION,
  recordRequests,
  type RequestRecord,
} from './security/partitions'
import { originOf, PermissionPolicy } from './security/permissions'
import { TransportPolicy } from './security/transport'
import { internalPagePreferences } from './security/web-preferences'
import { JOURNAL_CHANGED_CHANNEL } from '../shared/repl'
import { warnLimited } from './security/warn-limited'
import { SessionIndex } from './sessions'
import { defaultSettings, loadSettings, SETTINGS_FILE, type Settings } from './settings'
import { Worktrees, type Worktree } from './worktrees'

// Tests point the app at a throwaway profile (formalized by the harness, #46).
const userData = process.env['NEMESIS_USER_DATA']
if (userData) app.setPath('userData', userData)
// And at a throwaway downloads folder, so no spec leaves a file in ~/Downloads (#51).
const downloadsPath = process.env['NEMESIS_DOWNLOADS']
if (downloadsPath) app.setPath('downloads', downloadsPath)

// T3 (#50): internal pages live on nemesis://app, a privileged scheme that
// Electron only accepts before the app is ready. The handler that serves it
// is installed in whenReady below.
registerInternalScheme()

// The mark (#91). A development run is the stock Electron binary, which shows
// the Electron logo in the Dock and the app switcher unless the app sets its
// own; the packaged .app carries the icon in its bundle instead (#35), so the
// path into the checkout is only resolved when there is a checkout to resolve.
const iconPath = app.isPackaged ? undefined : join(__dirname, '../../resources/icon-512.png')

// T6 (#49): site permissions and device access are denied unless the user
// allowed them for that origin in this run. The allow set lives in memory
// only and is emptied on quit.
const permissionPolicy = new PermissionPolicy()
// The cockpit's own pages may write the clipboard: `M-w` in a buffer is
// CodeMirror's kill-ring-save, which Chromium puts behind the
// clipboard-sanitized-write permission on a secure origin such as
// nemesis://app. That one permission, for the internal origin only and for
// this run only; every site, and every other permission of the cockpit, stays
// denied by default (#49, SECURITY.org T6). The dev server origin gets the
// same in a development run, where it stands in for the internal origin.
permissionPolicy.allow(INTERNAL_ORIGIN, 'clipboard-sanitized-write')
const devOrigin = app.isPackaged ? null : originOf(process.env['ELECTRON_RENDERER_URL'])
if (devOrigin !== null) permissionPolicy.allow(devOrigin, 'clipboard-sanitized-write')
app.on('will-quit', () => permissionPolicy.clear())

// T2 (#51): a download or an external link is a question in the prompt
// buffer before anything lands or launches, the focused window's (#70).
const downloads = new DownloadPolicy({
  quarantineDir: join(app.getPath('downloads'), QUARANTINE_FOLDER),
  confirm: (request) => confirmInFocused(DOWNLOAD_SOURCE, describeDownload(request)),
})
const external = new ExternalPolicy({
  confirm: (request) => confirmInFocused(EXTERNAL_SOURCE, describeExternal(request)),
})
// A yes for a download is good for one request within 30 seconds (#100); on quit none survives.
app.on('will-quit', () => downloads.clear())
// T3 (#52): plain http: off loopback is upgraded or refused, and a certificate
// error is fatal, with a notice naming the host and the code. The test-only
// trust anchor is read from the environment here, once, and never outside a
// test run.
const transport = new TransportPolicy()
transport.guardCertificates(app)
// A quiet app still prints the last "suppressed N more" line of each key.
app.on('will-quit', () => warnLimited.flush())

app.on('web-contents-created', (_event, contents) => {
  // T6 (#49): whatever partition this WebContents uses gets the deny-by-default
  // handlers the moment it exists, so a partition the app creates later (#54)
  // cannot miss them. Electron grants everything on a session without them.
  permissionPolicy.apply(contents.session)
  permissionPolicy.watch(contents)
  // T2 (#51): downloads on whatever session this WebContents uses are
  // refused until the user says yes, and a link to an external handler asks.
  downloads.apply(contents.session)
  external.watch(contents)
  // T7 (#54): WebRTC uses the public interface only. Electron keeps the
  // setting per WebContents, so it is applied here, to every one.
  applyWebRTCPolicy(contents)
  // T1 and T3 (#48): every WebContents gets the page policy the moment it
  // exists, whoever created it, so no creation site can forget it. The one
  // internal page corrects its kind in createWindow below. The buffer manager
  // supplies openPage once a page buffer exists (M4, #73); until then a window
  // a page asks for is denied with nothing in its place.
  applyNavigationPolicy(contents, 'page')
  // T3 (#52): a page's plain http: navigation off loopback is re-issued on
  // https: once, after the policy above has let the scheme through. The
  // internal page corrects its kind in createWindow, so it is never upgraded
  // around the policy's refusal. The anchor seam covers whatever session
  // this WebContents uses, a partition created later included.
  transport.watch(contents, 'page')
  transport.apply(contents.session)
  // T1 (#47): read the preferences back off every WebContents the app creates,
  // the cockpit window included. The walk waits for the first load because
  // getLastWebPreferences() answers for the page that committed.
  contents.once('did-finish-load', () => {
    try {
      assertWebContentsHardened()
    } catch (error) {
      // An uncaught throw in the main process only raises a dialog and lets the
      // app run on, which is no control at all. A WebContents with weakened
      // preferences ends the process instead: a refusal to run, not a warning.
      console.error(error instanceof Error ? error.message : String(error))
      app.exit(1)
    }
  })
})

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    show: false,
    title: 'Nemesis',
    // Windows and Linux take the window icon from here; macOS ignores it and
    // reads the Dock icon set below.
    ...(iconPath ? { icon: iconPath } : {}),
    webPreferences: internalPagePreferences(join(__dirname, '../preload/index.js')),
  })
  win.once('ready-to-show', () => win.show())

  // The cockpit is an internal page: it may navigate on the internal scheme
  // only, and it opens no windows (#48). A development run adds the dev
  // server origin the page is loaded from, so Vite's full reload, a
  // navigation of the page to itself, lands (#96); a packaged run, or a run
  // without the variable, adds nothing.
  applyNavigationPolicy(win.webContents, 'internal', {}, devOrigin === null ? [] : [devOrigin])
  transport.watch(win.webContents, 'internal')

  const devServer = process.env['ELECTRON_RENDERER_URL']
  if (!app.isPackaged && devServer) {
    void win.loadURL(devServer)
  } else {
    // The built renderer, on the internal origin with the CSP header (#50).
    void win.loadURL(COCKPIT_URL)
  }
  return win
}

/**
 * The settings file lives in the profile, so the harness's throwaway profile
 * carries its own (#64). A file that cannot be read is reported and the
 * defaults stand in: the cockpit still opens, and the error names the key.
 */
function readSettings(): Settings {
  const defaults = defaultSettings(app.getPath('documents'))
  try {
    return loadSettings(join(app.getPath('userData'), SETTINGS_FILE), defaults)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    return defaults
  }
}

/**
 * The no-network spec (#54) reads every request the sessions made since
 * launch from here, through `app.evaluate`. Main process only, under test
 * only: the renderer has no path to it.
 */
const REQUEST_LOG = '__nemesisRequests'

/** The URLs handed to the system, for the downloads spec (#51). Main process only, under test only. */
const EXTERNAL_LOG = '__nemesisExternal'

/**
 * How the security harness opens a real page buffer in the focused window
 * and closes it again (#119), through `app.evaluate`. Main process only,
 * under test only.
 */
const PAGE_DOOR = '__nemesisPages'

/** What the page door answers: the buffer, its contents and Chromium's refusal, if any. */
interface OpenedPage {
  readonly windowId: number
  readonly bufferId: string
  readonly contentsId: number
  readonly loadError: string | null
}

/**
 * The baseline a page buffer runs under before its first load (#119):
 * `web-contents-created` applied it already, and each call is a no-op on a
 * WebContents that has it; the page buffer applies it again so its own
 * creation site is correct whatever the hook does.
 */
const pagePolicies: PagePolicies<WebContentsView> = {
  navigation: (contents) => applyNavigationPolicy(contents, 'page'),
  transport: (contents) => {
    transport.watch(contents, 'page')
    transport.apply(contents.session)
  },
  permissions: (contents) => {
    permissionPolicy.apply(contents.session)
    permissionPolicy.watch(contents)
  },
}

/** A window screenshot is scaled to fit this (#81): enough to read a UI, small enough to send. */
const SCREENSHOT_SIZE = { width: 1920, height: 1200 }

/**
 * The image on the clipboard as attach-image takes it (#83), or null when
 * the clipboard holds none: the first entry with an image type, decoded and
 * re-encoded as PNG whatever the clipboard's own format. Electron's
 * clipboard is the W3C-shaped asynchronous one, so this reads through
 * `clipboard.read()`. Under test a PNG file named by NEMESIS_CLIPBOARD_IMAGE
 * stands in for the clipboard, so a spec never writes the user's clipboard;
 * the variable is ignored in any other run.
 */
async function readClipboardImage(): Promise<ClipboardImage | null> {
  const standIn = process.env['NEMESIS_CLIPBOARD_IMAGE']
  if (process.env['NODE_ENV'] === 'test' && standIn !== undefined && standIn.length > 0) {
    return clipboardImageOf(nativeImage.createFromPath(standIn))
  }
  for (const item of await clipboard.read()) {
    const type = item.types.find((candidate) => candidate.startsWith('image/'))
    if (type === undefined) continue
    const blob = await item.getType(type)
    if (!(blob instanceof Blob)) continue
    const image = clipboardImageOf(
      nativeImage.createFromBuffer(Buffer.from(await blob.arrayBuffer())),
    )
    if (image !== null) return image
  }
  return null
}

function clipboardImageOf(image: Electron.NativeImage): ClipboardImage | null {
  if (image.isEmpty()) return null
  const { width, height } = image.getSize()
  return { png: image.toPNG(), width, height }
}

/** The command that runs the config file again (#71). */
const RELOAD_CONFIG = 'reload-config'

/** What reload-config says it does, in every window and in the config registry. */
const RELOAD_CONFIG_DOC =
  'Run the config file again; a failing file leaves the previous config live.'

/**
 * The window of each cockpit, by the id of its WebContents (#70): an IPC
 * call's sender names its window's cockpit, and the palette lists every
 * window's buffers from here.
 */
const cockpits = new Map<number, Cockpit>()
/** The window focused last, for the app's notices and questions while no window has focus. */
let lastFocused: number | null = null
/** How many windows were opened, for the next window's name. */
let opened = 0
/** Set on quit: a worktree window then closes without its question, and its worktree stays (#87). */
let quitting = false
app.on('before-quit', () => {
  quitting = true
})

/** Where a window's session runs, and the worktree it was opened in, if any (#87). */
interface CockpitPlace {
  readonly cwd: string
  readonly worktree?: { readonly worktree: Worktree; readonly opener: number } | undefined
}

/**
 * The cockpit the user is at: the focused window's, else the one focused
 * last, else the first still open. A download, an external link, the app's
 * notices and the config's `nemesis` object act on it.
 */
function focusedCockpit(): Cockpit | undefined {
  const focused = BrowserWindow.getFocusedWindow()
  const byFocus = focused === null ? undefined : cockpits.get(focused.webContents.id)
  const byLast = lastFocused === null ? undefined : cockpits.get(lastFocused)
  return byFocus ?? byLast ?? cockpits.values().next().value
}

function runInFocused(name: string): Promise<void> {
  const cockpit = focusedCockpit()
  return cockpit === undefined
    ? Promise.reject(new Error('Commands run once the cockpit is up, not while it starts'))
    : cockpit.registry.run(name, { source: 'config' })
}

/** A question in the focused window's prompt buffer; with no window, the answer is no. */
function confirmInFocused(source: string, question: string): Promise<boolean> {
  const cockpit = focusedCockpit()
  return cockpit === undefined
    ? Promise.resolve(false)
    : confirm(cockpit.prompter, source, question)
}

/** The menu bar runs the focused window's commands, so it is built again on focus (#70). */
function rebuildMenu(): void {
  const cockpit = focusedCockpit()
  if (cockpit !== undefined) {
    installMenu(cockpit.registry, cockpitKeymapLayers(), { isDev: !app.isPackaged })
  }
}

void app.whenReady().then(() => {
  // T3 (#50): the built renderer is served on nemesis://app before the
  // cockpit window asks for it. The dev server path above skips this origin.
  serveInternalPages(join(__dirname, '../renderer'))
  // T7 (#54): DNS over HTTPS off, the two partitions with the permission
  // handlers and the WebRTC policy, before any WebContents exists. The page
  // buffer (#73) names its partition from this module.
  const partitions = createPartitions(permissionPolicy)
  for (const one of [session.defaultSession, partitions.persistent, partitions.ephemeral]) {
    downloads.apply(one)
    transport.apply(one)
  }
  if (process.env['NODE_ENV'] === 'test') {
    // Installed before the cockpit window loads, so the first request the
    // app makes is already in the log the spec reads.
    const log = recordRequests({
      default: session.defaultSession,
      [PERSISTENT_PARTITION]: partitions.persistent,
      [EPHEMERAL_PARTITION]: partitions.ephemeral,
    })
    ;(globalThis as { [REQUEST_LOG]?: readonly RequestRecord[] })[REQUEST_LOG] = log
    ;(globalThis as { [EXTERNAL_LOG]?: readonly string[] })[EXTERNAL_LOG] = external.launched
    ;(globalThis as { [PAGE_DOOR]?: unknown })[PAGE_DOOR] = {
      open: async (url: string): Promise<OpenedPage> => {
        const cockpit = focusedCockpit()
        if (cockpit === undefined) throw new Error('No cockpit to open a page buffer in')
        const buffer = cockpit.pages.createPage()
        cockpit.buffers.switchTo(buffer.id)
        const contentsId = cockpit.pages.viewOf(buffer.id)?.webContents.id ?? -1
        const loadError = await cockpit.pages.load(buffer.id, url)
        return { windowId: cockpit.id, bufferId: buffer.id, contentsId, loadError }
      },
      close: (windowId: number, bufferId: string): void => {
        cockpits.get(windowId)?.pages.destroyPage(bufferId)
      },
    }
  }
  // app.dock exists on macOS only.
  if (iconPath && app.dock) app.dock.setIcon(iconPath)
  // The config file (#71, ADR 0006): run and checked whole before anything
  // reads a setting, against the cockpit's command names, so the settings it
  // overrides are in force from the start and a failing file changes
  // nothing. Its `nemesis` object acts on the focused window (#70).
  const initFile = configPath({ home: app.getPath('home'), env: process.env, argv: process.argv })
  const config = new ConfigLoader({
    path: initFile,
    base: readSettings,
    buffers: () => focusedCockpit()?.buffers.list() ?? [],
    run: runInFocused,
  })
  // The config's commands are committed to a registry of the cockpit's own
  // commands that no window drives, and copied from there into every
  // window's (#70), so a window opened after a reload has them too.
  const configRegistry = createCockpitRegistry()
  configRegistry.register(
    defineCommand({
      name: RELOAD_CONFIG,
      doc: RELOAD_CONFIG_DOC,
      run: () => runInFocused(RELOAD_CONFIG),
    }),
  )
  const ownCommands = new Set(configRegistry.list().map((command) => command.name))
  const syncConfigCommands = (registry: CommandRegistry): void => {
    const fromConfig = configRegistry.list().filter((command) => !ownCommands.has(command.name))
    const names = new Set(fromConfig.map((command) => command.name))
    for (const command of registry.list()) {
      if (!ownCommands.has(command.name) && !names.has(command.name)) {
        registry.unregister(command.name)
      }
    }
    for (const command of fromConfig) {
      registry.unregister(command.name)
      registry.register(command)
    }
  }
  const firstLoad = config.stage(ownCommands)
  const settings = config.settings
  // The appearance (#33): `system` follows the OS, `light` and `dark` pin it.
  // Set before the window exists, so the renderer's prefers-color-scheme is
  // right on its first paint and the renderer never reads the settings.
  nativeTheme.themeSource = settings.theme
  // The sessions folder, read back: what resume-session lists and replays
  // (#67). The app's, since every window's session writes to it.
  const sessions = new SessionIndex({ sessionsDir: settings.sessionsDir })
  // Under test a home named by NEMESIS_HOME stands in for the user's, so a
  // spec reads a fixture and never the developer's own ~/.claude (#86).
  const testHome = process.env['NEMESIS_HOME']
  const home =
    process.env['NODE_ENV'] === 'test' && testHome !== undefined && testHome.length > 0
      ? testHome
      : app.getPath('home')
  // A window of the screen into the prompt as an image (#81): the system's
  // capture under the user's screen-recording permission.
  const capturer: WindowCapturer = {
    list: async () =>
      (
        await desktopCapturer.getSources({
          types: ['window'],
          thumbnailSize: { width: 0, height: 0 },
        })
      ).map((source) => ({ id: source.id, name: source.name })),
    capture: async (id) => {
      const sources = await desktopCapturer.getSources({
        types: ['window'],
        thumbnailSize: SCREENSHOT_SIZE,
      })
      const source = sources.find((candidate) => candidate.id === id)
      return source === undefined || source.thumbnail.isEmpty() ? null : source.thumbnail.toPNG()
    },
  }
  // Eval in the config scope (#72): the forms run in the main process with
  // the init file's `nemesis` object, and a definition is applied to the
  // running cockpit and journaled beside init.ts until it is promoted or
  // discarded. The evaluator needs the config target, built below, so it is
  // reached through `evaluator` once the cockpit is up.
  const journal =
    initFile === null ? null : new Journal({ path: journalPath(initFile), configFile: initFile })
  let evaluator: ConfigEval | null = null
  const evaluate = (form: string): Promise<EvalOutcome> =>
    evaluator === null
      ? Promise.resolve({
          ok: false,
          text: 'Eval runs once the cockpit is up, not while it starts',
          defined: null,
          journal: null,
        })
      : evaluator.evaluate(form)
  // The app's own notices, a refused site permission or download, a
  // certificate error, a config load, go to the focused window's session
  // (#70), shown and recorded like any event there.
  const appNotices = mergeNotices(permissionPolicy, downloads, external, transport, config)
  const noticesFor = (id: number): EventSource => ({
    on: (listener) =>
      appNotices.on((event) => {
        if (focusedCockpit()?.id === id) listener(event)
      }),
  })
  // What a config load swaps (#71): its commands in every window's registry,
  // the user keymap layer the resolver reads on every key, the settings read
  // at use time, and the menu bar, which lists every command with its chord
  // as text (#30) and is built again so the labels follow. The palette's
  // commands source reads the registry and the layers on every open.
  const target: ConfigTarget = {
    registry: configRegistry,
    setUserKeymap,
    applySettings: (next) => {
      nativeTheme.themeSource = next.theme
    },
    rebuilt: () => {
      for (const cockpit of cockpits.values()) {
        syncConfigCommands(cockpit.registry)
        // An outside client's tool list follows the command table (#28, ADR 0007).
        cockpit.mcp.toolsChanged()
      }
      rebuildMenu()
    },
  }
  const reloadConfig = (help: HelpBuffers): Command =>
    defineCommand({
      name: RELOAD_CONFIG,
      doc: RELOAD_CONFIG_DOC,
      run: () => {
        const result = config.reload(target)
        if (result.ok) {
          config.notify(result.line)
          return
        }
        help.show(renderProblem(result.problem))
        config.notify(`Config not reloaded: ${result.problem.message}`)
      },
    })
  if (firstLoad.ok) config.commit(firstLoad.config, target)
  evaluator = new ConfigEval({
    loader: config,
    target,
    journal,
    buffers: () => focusedCockpit()?.buffers.list() ?? [],
    run: runInFocused,
  })
  /** The other windows as the window `id` sees them (#70). */
  const windowsFor = (id: number): CockpitWindows => ({
    open: () => {
      openCockpit()
    },
    others: () =>
      [...cockpits.values()]
        .filter((cockpit) => cockpit.id !== id)
        .flatMap((cockpit) =>
          cockpit.buffers.list().map((buffer) => ({
            windowId: cockpit.id,
            windowName: cockpit.name,
            buffer,
            current: buffer.id === cockpit.buffers.current?.id,
          })),
        ),
    switchTo: (windowId, bufferId) => {
      const cockpit = cockpits.get(windowId)
      if (cockpit === undefined) throw new CommandError('That window is closed')
      cockpit.buffers.switchTo(bufferId)
      if (cockpit.window.isMinimized()) cockpit.window.restore()
      cockpit.window.show()
      cockpit.window.focus()
    },
    // The reviewer (#87) is a window of its own in the writer's folder, a
    // fresh session whose first message is the reviewer's prompt; its first
    // turn's final text is the review.
    review: (prompt) => {
      const reviewer = openCockpit({ cwd: cockpits.get(id)?.cwd ?? process.cwd() })
      const done = new Promise<string>((resolve, reject) => {
        const off = reviewer.agent.on((event) => {
          if (event.type === 'turn-end') {
            off()
            if (event.isError) reject(new Error(event.result || 'the turn ended in an error'))
            else resolve(event.result)
          } else if (event.type === 'error') {
            off()
            reject(new Error(event.message))
          }
        })
        reviewer.window.once('closed', () => {
          off()
          reject(new Error('the reviewer window was closed before its turn ended'))
        })
      })
      // Sent once the page listens, so the reviewer's transcript shows the prompt.
      reviewer.window.webContents.once('did-finish-load', () => {
        reviewer.prompts.submit(prompt).catch((error: unknown) => {
          console.error('review: the reviewer prompt was not sent:', error)
        })
      })
      return { reviewer: reviewer.name, done }
    },
    openWorktree: (worktree) => {
      openCockpit({ cwd: worktree.path, worktree: { worktree, opener: id } })
    },
  })
  /**
   * Closing a worktree window asks first, keep highlighted (#87). The
   * removal runs after the window is gone, through the opener's worktrees
   * so the notice lands where the worktree was made, and only when the
   * worktree is clean. A quit asks nothing and keeps it.
   */
  const askBeforeClosing = (cockpit: Cockpit, worktree: Worktree, opener: number): void => {
    const win = cockpit.window
    let state: 'open' | 'asking' | 'closing' = 'open'
    win.on('close', (event) => {
      if (quitting || state === 'closing') return
      event.preventDefault()
      if (state === 'asking') return
      state = 'asking'
      void confirm(
        cockpit.prompter,
        WORKTREE_SOURCE,
        `Remove the worktree ${worktree.path}? Only a clean worktree is removed.`,
      ).then(async (remove) => {
        state = 'closing'
        if (!win.isDestroyed()) win.close()
        const notices = (cockpits.get(opener) ?? focusedCockpit())?.worktrees ?? new Worktrees()
        if (remove) await notices.remove(worktree)
        else notices.kept(worktree)
      })
    })
  }
  /** A window and its cockpit: its own session, buffers and keys (#70), in its own folder (#87). */
  const openCockpit = (place: CockpitPlace = { cwd: process.cwd() }): Cockpit => {
    const win = createWindow()
    const id = win.webContents.id
    opened += 1
    const cockpit = createCockpit(
      win,
      `Window ${opened}`,
      {
        config,
        sessions,
        journal,
        evaluate,
        home,
        clipboard: { readImage: readClipboardImage },
        capturer,
        notices: noticesFor(id),
        windows: windowsFor(id),
        commands: (help) => [reloadConfig(help)],
        pagePolicies,
      },
      place.cwd,
    )
    if (place.worktree !== undefined) {
      askBeforeClosing(cockpit, place.worktree.worktree, place.worktree.opener)
    }
    syncConfigCommands(cockpit.registry)
    cockpits.set(id, cockpit)
    lastFocused = id
    win.on('focus', () => {
      lastFocused = id
      rebuildMenu()
    })
    win.on('closed', () => {
      cockpits.delete(id)
      if (lastFocused === id) lastFocused = null
    })
    // The mode line's journal count is pushed on every change; a page that
    // loads, or loads again, gets the count as it stands.
    if (journal !== null) {
      win.webContents.on('did-finish-load', () => {
        win.webContents.send(JOURNAL_CHANGED_CHANNEL, { unpromoted: journal.count })
      })
    }
    rebuildMenu()
    return cockpit
  }
  // The door of ADR 0007 (#28): mcp.sock and mcp.token in the profile, both
  // 0600, for bin/nemesis-mcp. It lives as long as main does, window or not.
  // A connection drives the cockpit of the window focused when it arrived
  // (#70); with no window open, one is opened for it, as the Dock would.
  const door = new McpDoor({
    dir: app.getPath('userData'),
    accept: (transport) => {
      const cockpit = focusedCockpit() ?? openCockpit()
      cockpit.mcp.connect(transport).catch((error: unknown) => {
        console.error(
          `MCP connection failed: ${error instanceof Error ? error.message : String(error)}`,
        )
      })
    },
  })
  door.open().catch((error: unknown) => {
    console.error(`No MCP door: ${error instanceof Error ? error.message : String(error)}`)
  })
  app.on('will-quit', () => door.close())
  const first = openCockpit()
  // A load error at start is shown once the first window can show it, and
  // the app runs on the defaults.
  if (!firstLoad.ok) {
    const problem = firstLoad.problem
    first.window.webContents.once('did-finish-load', () => {
      first.help.show(renderProblem(problem))
      config.notify(`Config not loaded: ${problem.message}`)
    })
  }
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) openCockpit()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
