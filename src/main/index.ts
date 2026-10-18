import { app, BrowserWindow } from 'electron'
import { join } from 'node:path'
import { installSessionBridge } from './agent/session-bridge'
import { installBufferBridge } from './buffer-bridge'
import { createCockpitBuffers } from './buffers'
import { installKeyBridge } from './commands/key-bridge'
import { createCockpitDispatcher, createCockpitRegistry } from './commands/keyscheme'
import { assertWebContentsHardened } from './security/assert-web-preferences'
import { internalPagePreferences } from './security/web-preferences'

// Tests point the app at a throwaway profile (formalized by the harness, #46).
const userData = process.env['NEMESIS_USER_DATA']
if (userData) app.setPath('userData', userData)

app.on('web-contents-created', (_event, contents) => {
  // Interim guard until #48 lands: no page may attach a <webview>.
  contents.on('will-attach-webview', (event) => event.preventDefault())
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
    webPreferences: internalPagePreferences(join(__dirname, '../preload/index.js')),
  })
  win.once('ready-to-show', () => win.show())

  // Interim guards until #48 lands: no new windows, no navigation away from the internal page.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (event) => event.preventDefault())

  const devServer = process.env['ELECTRON_RENDERER_URL']
  if (!app.isPackaged && devServer) {
    void win.loadURL(devServer)
  } else {
    // Served from file:// until #50 moves internal pages to the nemesis:// scheme.
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
  return win
}

void app.whenReady().then(() => {
  // The buffer list is the spine: the keymap and, later, the palette act on
  // it, so it exists before the window that shows it (#60).
  const buffers = createCockpitBuffers()
  installBufferBridge(buffers)
  // One agent session per cockpit, in the folder the app was started in; the
  // SDK loads the CLI's own settings, so the model and the permission rules are
  // the CLI's (#61). It starts on the first prompt, not at launch.
  installSessionBridge({ cwd: process.cwd() })
  // Keys mean nothing until the registry and the keymaps are up (#59).
  installKeyBridge(createCockpitDispatcher(createCockpitRegistry(buffers)))
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
