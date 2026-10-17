import { contextBridge, ipcRenderer } from 'electron'
import type { NemesisApi } from '../shared/api'
import type { BufferInfo, BufferList, BufferSpec } from '../shared/buffers'
import { BUFFER_CREATE_CHANNEL, BUFFERS_CHANGED_CHANNEL, BUFFERS_CHANNEL } from '../shared/buffers'
import type { DispatchRecord, KeyOutcome, KeyPress } from '../shared/keys'
import { DISPATCH_LOG_CHANNEL, KEY_CHANNEL } from '../shared/keys'

// The only bridge between internal pages and the main process (SECURITY.org, T1).
// Typed functions only, never a raw ipcRenderer. Completed by #53.
const base = {
  name: 'nemesis',
  version: '0.0.1',
  sendKey: (press: KeyPress): Promise<KeyOutcome> => ipcRenderer.invoke(KEY_CHANNEL, press),
  buffers: (): Promise<BufferList> => ipcRenderer.invoke(BUFFERS_CHANNEL),
  // The IpcRendererEvent never crosses the bridge: the page sees the list only.
  onBuffersChanged: (listener: (list: BufferList) => void): void => {
    ipcRenderer.on(BUFFERS_CHANGED_CHANNEL, (_event, list: BufferList) => listener(list))
  },
} satisfies NemesisApi

// The dispatch log is how the end-to-end specs see what a chord ran (#59), and
// create-buffer is how they open a second transcript (#60). Both are gated at
// runtime on NODE_ENV=test: the shipped bundle carries the code and exposes
// neither unless the process was launched with that variable set.
const api: NemesisApi = Object.freeze(
  process.env['NODE_ENV'] === 'test'
    ? {
        ...base,
        dispatchLog: (): Promise<readonly DispatchRecord[]> =>
          ipcRenderer.invoke(DISPATCH_LOG_CHANNEL),
        createBuffer: (spec: BufferSpec): Promise<BufferInfo> =>
          ipcRenderer.invoke(BUFFER_CREATE_CHANNEL, spec),
      }
    : base,
)

contextBridge.exposeInMainWorld('nemesis', api)
