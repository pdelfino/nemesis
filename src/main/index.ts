import { app, BrowserWindow, desktopCapturer, nativeTheme, session, shell } from 'electron'
import { join } from 'node:path'
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
} from './commands/confirm'
import { installKeyBridge } from './commands/key-bridge'
import {
  cockpitKeymapLayers,
  createCockpitDispatcher,
  resolveCockpitDeps,
} from './commands/keyscheme'
import { installPaletteBridge } from './commands/palette-bridge'
import { Prompter } from './commands/prompter'
import { DiffBuffers } from './diffs'
import { fetchIssueWithGh, IssueAttachment } from './issues'
import { installMenu } from './menu'
import { PlanBuffers } from './plans'
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
import { internalPagePreferences } from './security/web-preferences'
import { SessionIndex } from './sessions'
import { SpecBuffers } from './specs'
import { defaultSettings, loadSettings, SETTINGS_FILE, type Settings } from './settings'
import { TranscriptSearch } from './transcript-search'
import { SessionRecorder } from './transcripts'
import { Verifier } from './verify'

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
  // only, and it opens no windows (#48).
  applyNavigationPolicy(win.webContents, 'internal')

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
  const settings = readSettings()
  // The appearance (#33): `system` follows the OS, `light` and `dark` pin it.
  // Set before the window exists, so the renderer's prefers-color-scheme is
  // right on its first paint and the renderer never reads the settings.
  nativeTheme.themeSource = settings.theme
  // The buffer list is the spine: the keymap and, later, the palette act on
  // it, so it exists before the window that shows it (#60).
  const buffers = createCockpitBuffers()
  installBufferBridge(buffers)
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
  const agent: SessionManager = new SessionManager({
    cwd: process.cwd(),
    model: settings.model,
    permissionHandler: plans,
  })
  // The Edit and Write calls of the session, listed and opened as diff
  // buffers (#68). The collector reads the live events and a resumed
  // session's history before the bridge pushes them, so list-diffs is never
  // behind the window; `C-c C-o` asks in the prompt buffer, then hands the
  // file to the system through the one `shell.openPath` call site.
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
  // The verify key (#81): the check of the attached issue, else the settings'
  // verify entry, else npm run gate, run as a child of the cockpit with the
  // user's permissions in the folder it was started in, never through the
  // agent's tool path. The issue comes through the user's own gh login.
  const issues = new IssueAttachment({ cwd: process.cwd(), fetch: fetchIssueWithGh })
  const verifier = new Verifier({
    cwd: process.cwd(),
    settingsCommand: settings.verify,
    issueBody: () => issues.current?.body ?? null,
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
  const prompts = installSessionBridge({
    agent,
    permissions,
    recorder,
    notices: mergeNotices(
      permissionPolicy,
      downloads,
      external,
      diffs,
      plans,
      specs,
      issues,
      verifier,
      screenshots,
    ),
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
  })
  for (const source of CONFIRM_SOURCES) prompter.addSource(source)
  installPaletteBridge({
    prompter: deps.prompter,
    help: deps.help,
    transcripts,
    diffs,
    plans,
    specs,
  })
  // Keys mean nothing until the registry and the keymaps are up (#59).
  const dispatcher = createCockpitDispatcher(deps)
  installKeyBridge(dispatcher)
  // The menu bar lists every command with its chord as text (#30). Built once
  // here; a reload of the keymaps (#71) calls installMenu again.
  installMenu(dispatcher.registry, cockpitKeymapLayers(), { isDev: !app.isPackaged })
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
