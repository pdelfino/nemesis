import { contextBridge, ipcRenderer } from 'electron'
import type { NemesisApi } from '../shared/api'
import type { DispatchRecord, KeyOutcome, KeyPress } from '../shared/keys'
import { DISPATCH_LOG_CHANNEL, KEY_CHANNEL } from '../shared/keys'

// The only bridge between internal pages and the main process (SECURITY.org, T1).
// Typed functions only, never a raw ipcRenderer. Completed by #53.
const base = {
  name: 'nemesis',
  version: '0.0.1',
  sendKey: (press: KeyPress): Promise<KeyOutcome> => ipcRenderer.invoke(KEY_CHANNEL, press),
} satisfies NemesisApi

// The dispatch log is how the end-to-end specs see what a chord ran (#59).
// It exists only under test; the shipped surface does not carry it.
const api: NemesisApi = Object.freeze(
  process.env['NODE_ENV'] === 'test'
    ? {
        ...base,
        dispatchLog: (): Promise<readonly DispatchRecord[]> =>
          ipcRenderer.invoke(DISPATCH_LOG_CHANNEL),
      }
    : base,
)

contextBridge.exposeInMainWorld('nemesis', api)
