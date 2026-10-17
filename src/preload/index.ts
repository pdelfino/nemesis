import { contextBridge } from 'electron'
import type { NemesisApi } from '../shared/api'

// The only bridge between internal pages and the main process (SECURITY.org, T1).
// Typed functions only, never a raw ipcRenderer. Completed by #53.
const api: NemesisApi = Object.freeze({
  name: 'nemesis',
  version: '0.0.1',
})

contextBridge.exposeInMainWorld('nemesis', api)
