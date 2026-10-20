import {
  app,
  BrowserWindow,
  clipboard,
  desktopCapturer,
  ipcMain,
  nativeImage,
  nativeTheme,
  net,
  session,
  ShareMenu,
  type WebContentsView,
} from 'electron'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ClipboardImage } from './agent/images'
import type { AgentEvent } from '../shared/agent'
import type { EventSource } from './agent/session-bridge'
import { createCockpit, mergeNotices, type Cockpit } from './cockpit'
import { HOOK_COMMAND_DOCS, HookRegistry } from './hooks'
import type { AgentsSource } from './agents'
import { confirm, DOWNLOAD_SOURCE, EXTERNAL_SOURCE, WORKTREE_SOURCE } from './commands/confirm'
import {
  cockpitKeymapLayers,
  createCockpitRegistry,
  setUserKeymap,
  cockpitModes,
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
import { installPageDoor, PageScriptDoor, pingPrompt } from './page-door'
import { snapshotPrompt } from './pages/semantic'
import { installMenu } from './menu'
import { Blocker, SYSTEM_HOSTS } from './pages/blocker'
import { CompletedRequests } from './pages/network'
import type { WindowCapturer } from './screenshots'
import { assertWebContentsHardened } from './security/assert-web-preferences'
import {
  describeDownload,
  DownloadPolicy,
  prepareStaging,
  QUARANTINE_FOLDER,
  removeStaging,
  STAGING_FOLDER,
} from './security/downloads'
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
import {
  loadWindows,
  restoreSkipped,
  savedWindow,
  saveWindows,
  WINDOWS_FILE,
  windowsToSave,
  type SavedWindow,
} from './restore'
import { SessionIndex } from './sessions'
import { defaultSettings, loadSettings, SETTINGS_FILE, type Settings } from './settings'
import { Bookmarks } from './bookmarks'
import { History } from './history'
import { openStore, STORE_FILE } from './store'
import { Worktrees, type Worktree } from './worktrees'

// Tests point the app at a throwaway profile (formalized by the harness, #46).
const userData = process.env['NEMESIS_USER_DATA']
if (userData) app.setPath('userData', userData)
// And at a throwaway downloads folder, so no spec leaves a file in ~/Downloads (#51).
const downloadsPath = process.env['NEMESIS_DOWNLOADS']
if (downloadsPath) app.setPath('downloads', downloadsPath)
// T2 (#137): Chromium buffers an offered download in a hidden temporary file
// in the app's downloads path as the bytes arrive, before `will-download` can
// refuse it and before anyone is asked. The user's downloads folder is kept
// for the quarantine folder, and the app's downloads path becomes this run's
// staging folder in the profile, owner-only and removed at quit, so an offer
// never touches ~/Downloads before a yes. It is set here, before any session
// exists, because each session's download manager reads the path once, when
// it is made; setting a session's download path later does not move it.
const userDownloads = app.getPath('downloads')
const stagingDir = prepareStaging(join(app.getPath('userData'), STAGING_FOLDER))
app.setPath('downloads', stagingDir)
app.on('will-quit', () => removeStaging(stagingDir))

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
  quarantineDir: join(userDownloads, QUARANTINE_FOLDER),
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

/** A window, shown once its page is ready unless it is a background session's (#158). */
function createWindow(hidden = false): BrowserWindow {
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
  if (!hidden) win.once('ready-to-show', () => win.show())

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
 * What share-page handed the share menu (#34), in place of the native menu,
 * which a spec cannot pick from. Main process only, under test only.
 */
const SHARE_LOG = '__nemesisShares'

/** One share-page call as the share log records it. */
interface ShareRecord {
  readonly urls: readonly string[]
  readonly title: string
}

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

/**
 * Text onto the clipboard, as copy-hint-url puts a link's URL there (#123).
 * Under test the text goes to the file NEMESIS_CLIPBOARD_TEXT names instead,
 * so a spec never writes the user's clipboard; the variable is ignored in
 * any other run.
 */
function writeClipboardText(text: string): void {
  const standIn =
    process.env['NODE_ENV'] === 'test' ? process.env['NEMESIS_CLIPBOARD_TEXT'] : undefined
  if (standIn !== undefined && standIn.length > 0) {
    writeFileSync(standIn, text, 'utf8')
    return
  }
  clipboard.writeText(text)
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

/** The cockpit and buffer id of the page buffer whose WebContents has this id, if any. */
function pageBufferOf(contentsId: number): { cockpit: Cockpit; bufferId: string } | null {
  for (const cockpit of cockpits.values()) {
    for (const buffer of cockpit.pages.list()) {
      if (cockpit.pages.viewOf(buffer.id)?.webContents.id === contentsId) {
        return { cockpit, bufferId: buffer.id }
      }
    }
  }
  return null
}

/**
 * The page-script door (ADR 0009, #130): one for the app, answering only a
 * page buffer some window still holds. Its reply path is installed in
 * whenReady below; consumers ask through `pageDoor.request`.
 */
const pageDoor = new PageScriptDoor({ isPage: (id) => pageBufferOf(id) !== null })

/**
 * How the door spec asks a page buffer, forges a reply and sends `ping`'s
 * answer to the agent (#130), through `app.evaluate`. Main process only,
 * under test only.
 */
const PAGE_SCRIPT_DOOR = '__nemesisPageDoor'

/**
 * How the semantic spec reads a page buffer's snapshot, asks whether a ref
 * is still live and sends a snapshot to the agent (#122), through
 * `app.evaluate`. Main process only, under test only.
 */
const SEMANTIC_VIEW = '__nemesisSemantic'

/**
 * How the hints spec reads the labels hint mode put up and what the page's
 * overlay drew (#123), through `app.evaluate`. Main process only, under test
 * only.
 */
const PAGE_HINTS = '__nemesisHints'

/**
 * How the form guide spec reads what a watched page's pane holds (#94),
 * through `app.evaluate`. Main process only, under test only.
 */
const FORM_GUIDE = '__nemesisFormGuide'
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
  /** A background session (#158): the window stays hidden until the user shows it. */
  readonly hidden?: boolean
  /** Sent as the session's first prompt once the page listens, as the reviewer's is (#87). */
  readonly firstPrompt?: string
  /** The fan-out run the session belongs to (#160). */
  readonly run?: string
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
  installPageDoor(ipcMain, pageDoor)
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
  // T7 (#126): blocker mode on both partitions, the hosts file and the lists
  // on disk read now, nothing downloaded until a page buffer opens. Under
  // test nothing is ever downloaded: the hosts file and a seed list are the
  // spec's own, named by NEMESIS_HOSTS_FILE and NEMESIS_BLOCKER_LIST.
  const underTest = process.env['NODE_ENV'] === 'test'
  const blocker = new Blocker({
    dir: join(app.getPath('userData'), 'blocker'),
    hostsFile: underTest ? process.env['NEMESIS_HOSTS_FILE'] || null : SYSTEM_HOSTS,
    updates: () => config.settings.blockerUpdates,
    fetch: underTest ? null : (url) => net.fetch(url),
    seedList: underTest ? process.env['NEMESIS_BLOCKER_LIST'] || undefined : undefined,
  })
  blocker.load()
  app.on('will-quit', () => blocker.stop())
  const blocked = {
    persistent: blocker.install(partitions.persistent),
    ephemeral: blocker.install(partitions.ephemeral),
  }
  // #29: the network feed hears every request the page partitions complete,
  // and each window keeps the ones of its own page buffers.
  const completed = new CompletedRequests()
  completed.install(partitions.persistent)
  completed.install(partitions.ephemeral)
  if (underTest) {
    // Installed before the cockpit window loads, so the first request the
    // app makes is already in the log the spec reads. On the partitions the
    // log observes through the blocker, which holds their one listener.
    const log = recordRequests({
      default: session.defaultSession,
      [PERSISTENT_PARTITION]: blocked.persistent,
      [EPHEMERAL_PARTITION]: blocked.ephemeral,
    })
    ;(globalThis as { [REQUEST_LOG]?: readonly RequestRecord[] })[REQUEST_LOG] = log
    ;(globalThis as { [EXTERNAL_LOG]?: readonly string[] })[EXTERNAL_LOG] = external.launched
    ;(globalThis as { [SHARE_LOG]?: ShareRecord[] })[SHARE_LOG] = []
    ;(globalThis as { [PAGE_DOOR]?: unknown })[PAGE_DOOR] = {
      open: async (
        url: string,
        partition: 'persistent' | 'ephemeral' = 'persistent',
        // A window by id instead of the focused one, for the restore spec (#127).
        windowId?: number,
      ): Promise<OpenedPage> => {
        const cockpit = windowId === undefined ? focusedCockpit() : cockpits.get(windowId)
        if (cockpit === undefined) throw new Error('No cockpit to open a page buffer in')
        const buffer = cockpit.pages.createPage({ partition })
        cockpit.buffers.switchTo(buffer.id)
        const contentsId = cockpit.pages.viewOf(buffer.id)?.webContents.id ?? -1
        const loadError = await cockpit.pages.load(buffer.id, url)
        return { windowId: cockpit.id, bufferId: buffer.id, contentsId, loadError }
      },
      close: (windowId: number, bufferId: string): void => {
        cockpits.get(windowId)?.pages.destroyPage(bufferId)
      },
      // What the mode line reads of a page buffer, and a command run as M-x
      // runs it, for the blocker spec (#126).
      buffer: (windowId: number, bufferId: string) => cockpits.get(windowId)?.buffers.get(bufferId),
      run: (windowId: number, name: string): Promise<void> =>
        cockpits.get(windowId)?.registry.run(name, { source: 'test' }) ??
        Promise.reject(new Error(`No window ${windowId}`)),
      // Every window's folder and page buffers, with the URL each page's
      // contents hold, empty until it loads, for the restore spec (#127).
      windows: () =>
        [...cockpits.values()].map((cockpit) => ({
          id: cockpit.id,
          cwd: cockpit.cwd,
          currentId: cockpit.buffers.current?.id ?? null,
          pages: cockpit.pages.list().map((buffer) => ({
            id: buffer.id,
            url: buffer.url ?? null,
            title: buffer.title,
            partition: cockpit.pages.partitionOf(buffer.id),
            loaded: cockpit.pages.viewOf(buffer.id)?.webContents.getURL() ?? '',
          })),
        })),
    }
    // The door's spec (#130): a request as a consumer makes it, a reply
    // forged around an id the door opened, fed to the reply check as IPC
    // would feed it, and `ping`'s answer sent to the agent as T4 sends it.
    const pageContents = (windowId: number, bufferId: string): Electron.WebContents => {
      const contents = cockpits.get(windowId)?.pages.viewOf(bufferId)?.webContents
      if (contents === undefined)
        throw new Error(`No page buffer ${bufferId} in window ${windowId}`)
      return contents
    }
    const outcome = (
      answer: Promise<unknown>,
    ): Promise<{ ok: true; data: unknown } | { ok: false; error: string }> =>
      answer.then(
        (data) => ({ ok: true, data }),
        (error: unknown) => ({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        }),
      )
    ;(globalThis as { [PAGE_SCRIPT_DOOR]?: unknown })[PAGE_SCRIPT_DOOR] = {
      ping: (windowId: number, bufferId: string) =>
        outcome(pageDoor.request(pageContents(windowId, bufferId), 'ping')),
      forge: (
        windowId: number,
        bufferId: string,
        reply: (id: string) => unknown,
        sender: 'top' | 'subframe' | 'cockpit',
      ) => {
        const contents = pageContents(windowId, bufferId)
        // Short, so a dropped reply that settles nothing times out quickly.
        const opened = pageDoor.expect(contents, 'ping', 1000)
        const from =
          sender === 'cockpit' ? (cockpits.get(windowId)?.window.webContents ?? contents) : contents
        const top = from.mainFrame
        const frame = sender === 'subframe' ? { url: top.url, parent: top } : top
        pageDoor.receive({ sender: from, senderFrame: frame }, reply(opened.id))
        return outcome(opened.answer)
      },
      prompt: async (windowId: number, bufferId: string, instruction: string): Promise<void> => {
        const cockpit = cockpits.get(windowId)
        if (cockpit === undefined) throw new Error(`No window ${windowId}`)
        const contents = pageContents(windowId, bufferId)
        const answer = await pageDoor.request(contents, 'ping')
        await cockpit.prompts.submit(pingPrompt(instruction, contents.getURL(), answer))
      },
    }
    // The semantic view's spec (#122): a snapshot as show-semantic-view reads
    // it, a ref checked against the page's current document, and a snapshot
    // sent to the agent as T4 sends it.
    const semanticOf = (windowId: number): Cockpit['semantic'] => {
      const cockpit = cockpits.get(windowId)
      if (cockpit === undefined) throw new Error(`No window ${windowId}`)
      return cockpit.semantic
    }
    ;(globalThis as { [SEMANTIC_VIEW]?: unknown })[SEMANTIC_VIEW] = {
      snapshot: (windowId: number, bufferId: string) =>
        outcome(semanticOf(windowId).snapshot(bufferId)),
      resolve: (windowId: number, ref: string) => semanticOf(windowId).resolve(ref),
      prompt: async (windowId: number, bufferId: string, instruction: string): Promise<void> => {
        const cockpit = cockpits.get(windowId)
        if (cockpit === undefined) throw new Error(`No window ${windowId}`)
        const snapshot = await cockpit.semantic.snapshot(bufferId)
        await cockpit.prompts.submit(snapshotPrompt(instruction, snapshot))
      },
    }
    // The hints spec (#123): the labels main holds for a page, and the
    // overlay's own report of where it drew them when they went up.
    ;(globalThis as { [PAGE_HINTS]?: unknown })[PAGE_HINTS] = {
      targets: (windowId: number, bufferId: string) =>
        cockpits.get(windowId)?.hints.targets(bufferId) ?? [],
      drawn: (windowId: number, bufferId: string) =>
        cockpits.get(windowId)?.hints.drawn(bufferId) ?? [],
    }
    // The form guide's spec (#94): the reading, the reply and the shown suggestion of a watch.
    ;(globalThis as { [FORM_GUIDE]?: unknown })[FORM_GUIDE] = {
      state: (windowId: number, bufferId: string) =>
        cockpits.get(windowId)?.formGuide.state(bufferId) ?? null,
    }
  }
  // app.dock exists on macOS only.
  if (iconPath && app.dock) app.dock.setIcon(iconPath)
  // The history and the bookmarks (#125): one node:sqlite file in the
  // profile, opened once here and closed at quit. A file that will not open
  // is reported and the cockpit runs without the two stores.
  let stores: { readonly history: History; readonly bookmarks: Bookmarks } | null = null
  try {
    const db = openStore(join(app.getPath('userData'), STORE_FILE))
    stores = { history: new History(db), bookmarks: new Bookmarks(db) }
    app.on('will-quit', () => {
      if (db.isOpen) db.close()
    })
  } catch (error) {
    console.error(
      `History and bookmarks are off: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  // The config file (#71, ADR 0006): run and checked whole before anything
  // reads a setting, against the cockpit's command names, so the settings it
  // overrides are in force from the start and a failing file changes
  // nothing. Its `nemesis` object acts on the focused window (#70).
  const initFile = configPath({ home: app.getPath('home'), env: process.env, argv: process.argv })
  // The hooks of ADR 0005 (#165): one registry for the app, fired from every
  // window's buffers, commands and session. A failing handler's notice goes
  // down the app's notices, to the focused window, like a config load's.
  const hookListeners = new Set<(event: AgentEvent) => void>()
  const hookNotices: EventSource = {
    on: (listener) => {
      hookListeners.add(listener)
      return () => {
        hookListeners.delete(listener)
      }
    },
  }
  const hooks = new HookRegistry((text) => {
    for (const listener of [...hookListeners]) listener({ type: 'notice', text, source: 'hook' })
  })
  // before-quit waits on its handlers: the first quit is held, the handlers
  // run each within its timeout, and the quit is asked again. The app's
  // other before-quit work has already run on the first pass.
  let quitHooksRan = false
  app.on('before-quit', (event) => {
    if (quitHooksRan || !hooks.has('before-quit')) return
    quitHooksRan = true
    event.preventDefault()
    void hooks.fire('before-quit', {}).finally(() => app.quit())
  })
  const config = new ConfigLoader({
    path: initFile,
    base: readSettings,
    buffers: () => focusedCockpit()?.buffers.list() ?? [],
    run: runInFocused,
    hooks,
    // A config mode (#166): defined in the app's registry, toggled in the focused window.
    modes: cockpitModes,
    toggleMode: async (name) => {
      const modes = focusedCockpit()?.modes
      const buffer = modes?.current
      if (modes === undefined || buffer === null || buffer === undefined) {
        throw new CommandError('There is no current buffer')
      }
      await modes.toggleMode(buffer.id, name)
    },
  })
  // A mode's hooks go to the app's registry while it is on (#166).
  cockpitModes.useHooks(hooks)
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
  // Every window registers its own list-hooks and remove-hook, over its help
  // buffer and prompter; these keep the names the window's own.
  for (const [name, doc] of Object.entries(HOOK_COMMAND_DOCS)) {
    configRegistry.register(defineCommand({ name, doc, run: () => runInFocused(name) }))
  }
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
  // Each source stamps its notices, for the messages log (#170).
  const stamped = (source: string, from: EventSource): EventSource => ({
    on: (listener) =>
      from.on((event) => listener(event.type === 'notice' ? { ...event, source } : event)),
  })
  const appNotices = mergeNotices(
    stamped('permission', permissionPolicy),
    stamped('download', downloads),
    stamped('app', external),
    stamped('app', transport),
    stamped('config', config),
    stamped('app', blocker),
    hookNotices,
  )
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
  // Every window's session for the agents buffer of each (#157): the list
  // read when a buffer draws, and a word to every buffer when any session's
  // state changes or a window opens or closes.
  const agentsListeners = new Set<() => void>()
  // The windows opened hidden by new-background-session and not shown since (#158).
  const background = new Set<number>()
  // The fan-out run of each window fan-out opened (#160).
  const runs = new Map<number, string>()
  const agentsChanged = (): void => {
    for (const listener of [...agentsListeners]) listener()
  }
  const agentsSource: AgentsSource = {
    list: () =>
      [...cockpits.values()].map((cockpit) => ({
        ...cockpit.status.snapshot,
        windowId: cockpit.id,
        windowName: cockpit.name,
        cwd: cockpit.cwd,
        targetBufferId:
          (
            cockpit.buffers.list().find((buffer) => buffer.kind === 'permission') ??
            cockpit.buffers.list().find((buffer) => buffer.kind === 'prompt')
          )?.id ?? null,
        background: background.has(cockpit.id),
        run: runs.get(cockpit.id) ?? null,
      })),
    onChange: (listener) => {
      agentsListeners.add(listener)
      return () => {
        agentsListeners.delete(listener)
      }
    },
  }
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
    // A background session (#158): a window of its own, hidden, in this
    // window's folder, whose first prompt is sent once its page listens. It
    // asks exactly as a shown one; showing it makes it an ordinary window.
    openBackground: (prompt, options = {}) =>
      openCockpit({
        cwd: options.worktree?.path ?? cockpits.get(id)?.cwd ?? process.cwd(),
        ...(options.worktree === undefined
          ? {}
          : { worktree: { worktree: options.worktree, opener: id } }),
        hidden: true,
        firstPrompt: prompt,
        ...(options.run === undefined ? {} : { run: options.run }),
      }).name,
    close: (windowId) => {
      const cockpit = cockpits.get(windowId)
      if (cockpit === undefined) throw new CommandError('That window is closed')
      cockpit.window.close()
    },
    // send-to-session (#159): appended to the other window's draft, never
    // sent, and that window is not focused.
    insertPrompt: (windowId, text) => {
      const cockpit = cockpits.get(windowId)
      if (cockpit === undefined) throw new CommandError('That window is closed')
      cockpit.prompts.insert(text)
    },
    // The renderer reports the page section's new rectangle on the window's
    // resize, so the page view follows full-screen in and out (#32).
    toggleFullScreen: () => {
      const window = cockpits.get(id)?.window
      if (window === undefined) throw new CommandError('That window is closed')
      window.setFullScreen(!window.isFullScreen())
    },
    // The share is the user's act (#34): the menu opens at the pointer over
    // this window, and only the target picked there receives the URL.
    openShareMenu: (urls, title) => {
      const window = cockpits.get(id)?.window
      if (window === undefined) throw new CommandError('That window is closed')
      const log = (globalThis as { [SHARE_LOG]?: ShareRecord[] })[SHARE_LOG]
      if (log !== undefined) {
        log.push({ urls: [...urls], title })
        return
      }
      if (process.platform !== 'darwin') throw new CommandError('The share menu is macOS only')
      new ShareMenu({ urls: [...urls], texts: [title] }).popup({ window })
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
      // A hidden window cannot show the question (#160): it closes, and the
      // worktree is kept, as a no would keep it.
      if (!win.isVisible()) {
        state = 'closing'
        win.once('closed', () => {
          const notices = (cockpits.get(opener) ?? focusedCockpit())?.worktrees ?? new Worktrees()
          notices.kept(worktree)
        })
        return
      }
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
    const hidden = place.hidden === true
    const win = createWindow(hidden)
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
        writeClipboardText,
        capturer,
        notices: noticesFor(id),
        windows: windowsFor(id),
        commands: (help) => [reloadConfig(help)],
        pagePolicies,
        stores,
        blocker,
        pageDoor,
        completed,
        agents: agentsSource,
        hooks,
        downloads,
      },
      place.cwd,
    )
    if (place.worktree !== undefined) {
      askBeforeClosing(cockpit, place.worktree.worktree, place.worktree.opener)
    }
    syncConfigCommands(cockpit.registry)
    cockpits.set(id, cockpit)
    if (place.run !== undefined) runs.set(id, place.run)
    if (hidden) {
      background.add(id)
      // Shown by open-agent or a notification's click, it is an ordinary window.
      win.on('show', () => {
        if (background.delete(id)) agentsChanged()
      })
    }
    const firstPrompt = place.firstPrompt
    if (firstPrompt !== undefined) {
      win.webContents.once('did-finish-load', () => {
        cockpit.prompts.submit(firstPrompt).catch((error: unknown) => {
          console.error('background: the first prompt was not sent:', error)
        })
      })
    }
    cockpit.status.onChange(agentsChanged)
    agentsChanged()
    // A hidden window is not the one the user is at.
    if (!hidden) lastFocused = id
    win.on('focus', () => {
      lastFocused = id
      rebuildMenu()
    })
    win.on('closed', () => {
      cockpits.delete(id)
      background.delete(id)
      runs.delete(id)
      if (lastFocused === id) lastFocused = null
      agentsChanged()
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
  // Session restore (#127): at quit, before any window closes, each window's
  // persistent pages (URL and title only) and its folder go to windows.json
  // in the profile; at start the same windows reopen, each page loaded when
  // it is first shown, and no agent session is resumed (that is #67). The
  // `restore` setting off neither saves nor restores; --no-restore skips the
  // restore once.
  const windowsFile = join(app.getPath('userData'), WINDOWS_FILE)
  app.on('before-quit', () => {
    if (!config.settings.restore) return
    try {
      saveWindows(
        windowsFile,
        // A background session's hidden window is not restored (#158).
        windowsToSave([...cockpits.values()], background).map((cockpit) =>
          savedWindow(
            cockpit.cwd,
            cockpit.pages.list().map((buffer) => ({
              id: buffer.id,
              url: buffer.url,
              title: buffer.title,
              partition: cockpit.pages.partitionOf(buffer.id),
            })),
            cockpit.buffers.current?.id ?? null,
          ),
        ),
      )
    } catch (error) {
      console.error(`Windows not saved: ${error instanceof Error ? error.message : String(error)}`)
    }
  })
  const restoreWindows = (): Cockpit | undefined => {
    if (restoreSkipped(settings.restore, process.argv)) return undefined
    let saved: SavedWindow[]
    try {
      saved = loadWindows(windowsFile)
    } catch (error) {
      console.error(
        `Windows not restored: ${error instanceof Error ? error.message : String(error)}`,
      )
      return undefined
    }
    let restored: Cockpit | undefined
    for (const one of saved) {
      // A folder removed since, a worktree for one, leaves the window in the app's own.
      const cockpit = openCockpit({ cwd: existsSync(one.cwd) ? one.cwd : process.cwd() })
      one.pages.forEach((page, index) => {
        const buffer = cockpit.pages.restorePage(page)
        if (index === one.current) cockpit.buffers.switchTo(buffer.id)
      })
      restored ??= cockpit
    }
    return restored
  }
  const first = restoreWindows() ?? openCockpit()
  // after-init (ADR 0005): the first window's dispatcher is built, so a
  // handler may run a command; its notices reach that window.
  if (hooks.has('after-init')) {
    void hooks.fire('after-init', {
      commands: first.registry.list().map((command) => command.name),
      buffers: first.buffers.list(),
    })
  }
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
