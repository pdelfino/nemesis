import { app, BrowserWindow } from 'electron'
import { join } from 'node:path'
import { PermissionBridge } from './agent/permission-bridge'
import { installSessionBridge } from './agent/session-bridge'
import { installBufferBridge } from './buffer-bridge'
import { createCockpitBuffers } from './buffers'
import { installKeyBridge } from './commands/key-bridge'
import { createCockpitDispatcher, resolveCockpitDeps } from './commands/keyscheme'
import { installPaletteBridge } from './commands/palette-bridge'
import { assertWebContentsHardened } from './security/assert-web-preferences'
import { applyNavigationPolicy } from './security/navigation-policy'
import { internalPagePreferences } from './security/web-preferences'
import { defaultSettings, loadSettings, SETTINGS_FILE, type Settings } from './settings'
import { SessionRecorder } from './transcripts'

// Tests point the app at a throwaway profile (formalized by the harness, #46).
const userData = process.env['NEMESIS_USER_DATA']
if (userData) app.setPath('userData', userData)

// The mark (#91). A development run is the stock Electron binary, which shows
// the Electron logo in the Dock and the app switcher unless the app sets its
// own; the packaged .app carries the icon in its bundle instead (#35), so the
// path into the checkout is only resolved when there is a checkout to resolve.
const iconPath = app.isPackaged ? undefined : join(__dirname, '../../resources/icon-512.png')

app.on('web-contents-created', (_event, contents) => {
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
    // Served from file:// until #50 moves internal pages to the nemesis:// scheme.
    void win.loadFile(join(__dirname, '../renderer/index.html'))
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

void app.whenReady().then(() => {
  // app.dock exists on macOS only.
  if (iconPath && app.dock) app.dock.setIcon(iconPath)
  const settings = readSettings()
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
  installSessionBridge({ cwd: process.cwd(), permissions, recorder, model: settings.model })
  // The palette reads a choice for a command, and help answers in a buffer (#65).
  const deps = resolveCockpitDeps({ buffers, permissions })
  installPaletteBridge({ prompter: deps.prompter, help: deps.help })
  // Keys mean nothing until the registry and the keymaps are up (#59).
  installKeyBridge(createCockpitDispatcher(deps))
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
