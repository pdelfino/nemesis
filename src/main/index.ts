import { app, BrowserWindow } from 'electron'
import { join } from 'node:path'
import { installKeyBridge } from './commands/key-bridge'
import { internalPagePreferences } from './security/web-preferences'

// Tests point the app at a throwaway profile (formalized by the harness, #46).
const userData = process.env['NEMESIS_USER_DATA']
if (userData) app.setPath('userData', userData)

// Interim guard until #48 lands: no page may attach a <webview>.
app.on('web-contents-created', (_event, contents) => {
  contents.on('will-attach-webview', (event) => event.preventDefault())
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
  // Keys mean nothing until the registry and the keymaps are up (#59).
  installKeyBridge()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
