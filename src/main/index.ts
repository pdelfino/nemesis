import {
  app,
  BrowserWindow,
  clipboard,
  desktopCapturer,
  nativeImage,
  nativeTheme,
  session,
  shell,
} from 'electron'
import { join } from 'node:path'
import type { ClipboardImage } from './agent/images'
import { PermissionBridge } from './agent/permission-bridge'
import { installSessionBridge, type EventSource } from './agent/session-bridge'
import { SessionManager } from './agent/session-manager'
import { installBufferBridge } from './buffer-bridge'
import { createCockpitBuffers } from './buffers'
import {
  confirm,
  CONFIRM_SOURCES,
  DOWNLOAD_SOURCE,
  EXTERNAL_SOURCE,
  OPEN_FILE_SOURCE,
  VERIFY_SOURCE,
} from './commands/confirm'
import { installKeyBridge } from './commands/key-bridge'
import {
  cockpitKeymapLayers,
  createCockpitDispatcher,
  createCockpitRegistry,
  resolveCockpitDeps,
  setUserKeymap,
} from './commands/keyscheme'
import { installPaletteBridge } from './commands/palette-bridge'
import { Prompter } from './commands/prompter'
import { defineCommand } from './commands/registry'
import { ConfigEval } from './config/eval'
import { Journal, journalPath } from './config/journal'
import { ConfigLoader, configPath, renderProblem, type ConfigTarget } from './config/loader'
import { DiffBuffers } from './diffs'
import { EnvironmentBuffers } from './environment'
import { UrlFetcher } from './fetch-url'
import { WorkingFiles } from './files'
import { fetchIssueWithGh, IssueAttachment } from './issues'
import { CockpitMcp } from './mcp/server'
import { McpDoor } from './mcp/socket'
import { installMenu } from './menu'
import { installNotifications } from './notify/install'
import { PlanBuffers } from './plans'
import { Repl } from './repl'
import { Screenshots, SCREENSHOTS_FOLDER } from './screenshots'
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
import { SpecBuffers } from './specs'
import { defaultSettings, loadSettings, SETTINGS_FILE, type Settings } from './settings'
import { TranscriptSearch } from './transcript-search'
import { SessionRecorder } from './transcripts'
import { Verifier, verifyQuestion } from './verify'

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
// buffer before anything lands or launches. The prompter exists this early so
// the two policies can ask through it; the palette commands share it below.
const prompter = new Prompter()
const downloads = new DownloadPolicy({
  quarantineDir: join(app.getPath('downloads'), QUARANTINE_FOLDER),
  confirm: (request) => confirm(prompter, DOWNLOAD_SOURCE, describeDownload(request)),
})
const external = new ExternalPolicy({
  confirm: (request) => confirm(prompter, EXTERNAL_SOURCE, describeExternal(request)),
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

/** One stream of the cockpit's own notices out of several policies. */
function mergeNotices(...sources: readonly EventSource[]): EventSource {
  return {
    on: (listener) => {
      const offs = sources.map((source) => source.on(listener))
      return () => {
        for (const off of offs) off()
      }
    },
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
  }
  // app.dock exists on macOS only.
  if (iconPath && app.dock) app.dock.setIcon(iconPath)
  // The buffer list is the spine: the keymap and, later, the palette act on
  // it, so it exists before the window that shows it (#60).
  const buffers = createCockpitBuffers()
  installBufferBridge(buffers)
  // The config file (#71, ADR 0006): run and checked whole before anything
  // reads a setting, against the cockpit's command names, so the settings it
  // overrides are in force from the start and a failing file changes
  // nothing. Its commands and keys are committed once the registry exists
  // below; the error, if any, waits for the window.
  let dispatcher: ReturnType<typeof createCockpitDispatcher> | null = null
  const initFile = configPath({ home: app.getPath('home'), env: process.env, argv: process.argv })
  const config = new ConfigLoader({
    path: initFile,
    base: readSettings,
    buffers: () => buffers.list(),
    run: (name) =>
      dispatcher === null
        ? Promise.reject(new Error('Commands run once the cockpit is up, not while it starts'))
        : dispatcher.registry.run(name, { source: 'config' }),
  })
  const firstLoad = config.stage(
    new Set([
      ...createCockpitRegistry()
        .list()
        .map((command) => command.name),
      RELOAD_CONFIG,
    ]),
  )
  const settings = config.settings
  // The appearance (#33): `system` follows the OS, `light` and `dark` pin it.
  // Set before the window exists, so the renderer's prefers-color-scheme is
  // right on its first paint and the renderer never reads the settings.
  nativeTheme.themeSource = settings.theme
  // One agent session per cockpit, in the folder the app was started in; the
  // SDK loads the CLI's own settings, so the permission rules are the CLI's
  // and so is the model unless the settings name one (#61, #64). It starts on
  // the first prompt, not at launch. A tool the rules ask about waits on a key
  // through the permission bridge (#63). Every event is written to the session
  // folder as it arrives (#64).
  const permissions = new PermissionBridge(buffers)
  const recorder = new SessionRecorder({ sessionsDir: settings.sessionsDir })
  // The same folder, read back: what resume-session lists and replays (#67),
  // and what search-transcripts scans (#69).
  const sessions = new SessionIndex({ sessionsDir: settings.sessionsDir })
  const transcripts = new TranscriptSearch({ sessionsDir: settings.sessionsDir })
  // The guide's plan mode (#82): the one tool that leaves it, ExitPlanMode,
  // is taken here in front of the bridge and becomes a plan buffer; every
  // other request reaches the bridge untouched. An approval tells the manager
  // to leave plan mode, which is why the two reference each other.
  const plans: PlanBuffers = new PlanBuffers(buffers, permissions, {
    leavePlanMode: (): Promise<void> => agent.leavePlanMode(),
  })
  // The manager holds that session and swaps it on new-task or a rewind (#84).
  // The model is read when a session starts, so a reload's model is the
  // next session's (#71).
  const agent: SessionManager = new SessionManager({
    cwd: process.cwd(),
    get model() {
      return config.settings.model
    },
    permissionHandler: plans,
    requests: permissions,
    // The cockpit's own MCP server, in process (#28): the agent inside sees
    // the catalog an outside client does, minus the rows that would loop.
    mcpServers: () => ({
      nemesis: { type: 'sdk', name: 'nemesis', instance: mcp.serve('in-app') },
    }),
  })
  // Walking away (#90): a finished turn, a request or an error is a macOS
  // notification, and a Telegram push when its two variables are set, with
  // the session's name, the elapsed time and the tool-call count only.
  installNotifications({ agent, permissions, buffers, env: process.env })
  // The Edit and Write calls of the session, listed and opened as diff
  // buffers (#68). The collector reads the live events and a resumed
  // session's history before the bridge pushes them, so list-diffs is never
  // behind the window; `C-c C-o` asks in the prompt buffer, then hands the
  // file to the system through `shell.openPath`, a door the environment
  // panel below shares.
  const diffs = new DiffBuffers(buffers, {
    confirm: (question) => confirm(prompter, OPEN_FILE_SOURCE, question),
    open: (path) => shell.openPath(path),
  })
  agent.on((event) => diffs.observe(event))
  agent.onHistory((history) => {
    for (const event of history) diffs.observe(event)
  })
  // The spec an interview ends with (#85): the agent's Write of SPEC.md,
  // once it went through, opens as a spec buffer with the fresh-session key.
  // Live events only: a resumed history reopens no spec.
  const specs = new SpecBuffers(buffers)
  agent.on((event) => specs.observe(event))
  // The environment of the working directory as one buffer (#86): the
  // CLAUDE.md files, rules, hooks, skills, servers and subagents off disk
  // and off the session's init frame. A listed file opens through the same
  // door as a diff's: the question in the prompt buffer, then shell.openPath.
  // Under test a home named by NEMESIS_HOME stands in for the user's, so a
  // spec reads a fixture and never the developer's own ~/.claude.
  const testHome = process.env['NEMESIS_HOME']
  const home =
    process.env['NODE_ENV'] === 'test' && testHome !== undefined && testHome.length > 0
      ? testHome
      : app.getPath('home')
  const environment = new EnvironmentBuffers(buffers, {
    cwd: process.cwd(),
    home,
    started: () => agent.started,
    confirm: (question) => confirm(prompter, OPEN_FILE_SOURCE, question),
    open: (path) => shell.openPath(path),
    config: () => config.status,
  })
  // The verify key (#81): the check of the attached issue, else the settings'
  // verify entry, else npm run gate, run as a child of the cockpit with the
  // user's permissions in the folder it was started in, never through the
  // agent's tool path. The issue comes through the user's own gh login, and
  // its command, remote text, is confirmed in the prompt buffer before its
  // first run (#98).
  const issues = new IssueAttachment({ cwd: process.cwd(), fetch: fetchIssueWithGh })
  const verifier = new Verifier({
    cwd: process.cwd(),
    // Read on every check, so a reload's verify is the next check's (#71).
    get settingsCommand() {
      return config.settings.verify
    },
    issueBody: () => issues.current?.body ?? null,
    confirm: (command) => confirm(prompter, VERIFY_SOURCE, verifyQuestion(command)),
  })
  // A window of the screen into the prompt as an image (#81): the system's
  // capture under the user's screen-recording permission, the file written
  // under the sessions folder, the one place session data goes.
  const screenshots = new Screenshots({
    dir: join(settings.sessionsDir, SCREENSHOTS_FOLDER),
    capturer: {
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
    },
  })
  // The guide's rich prompts (#83): the files `@` lists come from git in the
  // folder the app was started in; a URL the user asks for is fetched once,
  // within the limits of fetch-url.ts, and wrapped as untrusted content.
  const files = new WorkingFiles({ cwd: process.cwd() })
  const fetcher = new UrlFetcher()
  // Eval in the config scope (#72): the forms run in the main process with
  // the init file's `nemesis` object, and a definition is applied to the
  // running cockpit and journaled beside init.ts until it is promoted or
  // discarded. The evaluator needs the registry, built below, so it is
  // reached through `evaluator` once the cockpit is up.
  const journal =
    initFile === null ? null : new Journal({ path: journalPath(initFile), configFile: initFile })
  let evaluator: ConfigEval | null = null
  const repl = new Repl(buffers, {
    journal,
    evaluate: (form) =>
      evaluator === null
        ? Promise.resolve({
            ok: false,
            text: 'Eval runs once the cockpit is up, not while it starts',
            defined: null,
            journal: null,
          })
        : evaluator.evaluate(form),
  })
  const notices = mergeNotices(
    permissionPolicy,
    downloads,
    external,
    diffs,
    plans,
    specs,
    issues,
    verifier,
    screenshots,
    fetcher,
    environment,
    transport,
    config,
    repl,
  )
  // The MCP server over the command table (#28, ADR 0007 and 0008): a thin
  // relay to the registry, the buffers, the prompter, the session manager
  // and the transcript search. The registry and the queue exist below; the
  // server reads them at call time.
  const mcp: CockpitMcp = new CockpitMcp({
    get registry() {
      return cockpit.registry
    },
    buffers,
    prompter,
    agent,
    get prompts() {
      return prompts
    },
    sessionsDir: settings.sessionsDir,
    sessionFolder: () => recorder.folder,
    notices,
    cwd: process.cwd(),
    version: app.getVersion(),
    // A yes-per-call question with the window closed opens one, as the Dock does.
    showWindow: () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    },
  })
  const prompts = installSessionBridge({
    agent,
    permissions,
    recorder,
    notices: mergeNotices(notices, mcp),
  })
  // The palette reads a choice for a command, and help answers in a buffer (#65);
  // the same prompter reads the yes or no of a download or an external link (#51).
  const deps = resolveCockpitDeps({
    buffers,
    permissions,
    prompter,
    agent,
    prompts,
    sessions,
    transcripts,
    diffs,
    plans,
    specs,
    verifier,
    issues,
    screenshots,
    files,
    clipboard: { readImage: readClipboardImage },
    fetcher,
    environment,
    repl,
  })
  for (const source of CONFIRM_SOURCES) prompter.addSource(source)
  installPaletteBridge({
    prompter: deps.prompter,
    help: deps.help,
    transcripts,
    diffs,
    plans,
    specs,
    environment,
    repl,
    journal,
  })
  // Keys mean nothing until the registry and the keymaps are up (#59).
  const cockpit = createCockpitDispatcher(deps)
  dispatcher = cockpit
  installKeyBridge(cockpit)
  // What a config load swaps (#71): its commands in the registry, the user
  // keymap layer the resolver reads on every key, the settings read at use
  // time, and the menu bar, which lists every command with its chord as text
  // (#30) and is built again so the labels follow. The palette's commands
  // source reads the registry and the layers on every open.
  const target: ConfigTarget = {
    registry: cockpit.registry,
    setUserKeymap,
    applySettings: (next) => {
      nativeTheme.themeSource = next.theme
    },
    rebuilt: () => installMenu(cockpit.registry, cockpitKeymapLayers(), { isDev: !app.isPackaged }),
  }
  cockpit.registry.register(
    defineCommand({
      name: RELOAD_CONFIG,
      doc: 'Run the config file again; a failing file leaves the previous config live.',
      run: () => {
        const result = config.reload(target)
        if (result.ok) {
          config.notify(result.line)
          mcp.toolsChanged()
          return
        }
        deps.help.show(renderProblem(result.problem))
        config.notify(`Config not reloaded: ${result.problem.message}`)
      },
    }),
  )
  if (firstLoad.ok) config.commit(firstLoad.config, target)
  else target.rebuilt()
  evaluator = new ConfigEval({
    loader: config,
    target,
    journal,
    buffers: () => buffers.list(),
    run: (name) => cockpit.registry.run(name, { source: 'config' }),
  })
  // The door of ADR 0007: mcp.sock and mcp.token in the profile, both 0600,
  // for bin/nemesis-mcp. It lives as long as main does, window or not.
  const door = new McpDoor({
    dir: app.getPath('userData'),
    accept: (transport) => {
      mcp.connect(transport).catch((error: unknown) => {
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
  const win = createWindow()
  // The mode line's journal count is pushed on every change; a page that
  // loads, or loads again, gets the count as it stands.
  if (journal !== null) {
    win.webContents.on('did-finish-load', () => {
      win.webContents.send(JOURNAL_CHANGED_CHANNEL, { unpromoted: journal.count })
    })
  }
  // A load error at start is shown once the window can show it, and the
  // app runs on the defaults.
  if (!firstLoad.ok) {
    const problem = firstLoad.problem
    win.webContents.once('did-finish-load', () => {
      deps.help.show(renderProblem(problem))
      config.notify(`Config not loaded: ${problem.message}`)
    })
  }
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
