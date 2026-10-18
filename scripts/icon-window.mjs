// The Electron entry scripts/icon.mjs drives through Playwright: one blank,
// frameless, transparent window that icon.mjs loads the mark into and
// screenshots at each size. It is not the app; nothing from src/ runs here.
import { app, BrowserWindow } from 'electron'

void app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 1024,
    height: 1024,
    useContentSize: true,
    frame: false,
    transparent: true,
    show: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  })
  void win.loadURL('about:blank')
})
