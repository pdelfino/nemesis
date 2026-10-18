import { contextBridge, ipcRenderer } from 'electron'
import type { AgentEvent, PromptQueueState, PromptReceipt, PromptState } from '../shared/agent'
import {
  AGENT_EVENT_CHANNEL,
  PROMPT_DRAFT_CHANNEL,
  PROMPT_QUEUE_CHANNEL,
  PROMPT_SEND_CHANNEL,
  PROMPT_STATE_CHANNEL,
} from '../shared/agent'
import type { NemesisApi } from '../shared/api'
import type { BufferInfo, BufferList, BufferSpec } from '../shared/buffers'
import { BUFFER_CREATE_CHANNEL, BUFFERS_CHANGED_CHANNEL, BUFFERS_CHANNEL } from '../shared/buffers'
import type { DispatchRecord, KeyBindings, KeyOutcome, KeyPress } from '../shared/keys'
import { BINDINGS_CHANNEL, DISPATCH_LOG_CHANNEL, KEY_CHANNEL } from '../shared/keys'

// The only bridge between internal pages and the main process (SECURITY.org, T1).
// Typed functions only, never a raw ipcRenderer. Completed by #53.
const base = {
  name: 'nemesis',
  version: '0.0.1',
  sendKey: (press: KeyPress): Promise<KeyOutcome> => ipcRenderer.invoke(KEY_CHANNEL, press),
  bindings: (): Promise<KeyBindings> => ipcRenderer.invoke(BINDINGS_CHANNEL),
  buffers: (): Promise<BufferList> => ipcRenderer.invoke(BUFFERS_CHANNEL),
  // The IpcRendererEvent never crosses the bridge: the page sees the payload only.
  onBuffersChanged: (listener: (list: BufferList) => void): void => {
    ipcRenderer.on(BUFFERS_CHANGED_CHANNEL, (_event, list: BufferList) => listener(list))
  },
  sendPrompt: (text: string): Promise<PromptReceipt> =>
    ipcRenderer.invoke(PROMPT_SEND_CHANNEL, text),
  saveDraft: (text: string): Promise<void> => ipcRenderer.invoke(PROMPT_DRAFT_CHANNEL, text),
  promptState: (): Promise<PromptState> => ipcRenderer.invoke(PROMPT_STATE_CHANNEL),
  onPromptQueueChanged: (listener: (state: PromptQueueState) => void): void => {
    ipcRenderer.on(PROMPT_QUEUE_CHANNEL, (_event, state: PromptQueueState) => listener(state))
  },
  onAgentEvent: (listener: (event: AgentEvent) => void): void => {
    ipcRenderer.on(AGENT_EVENT_CHANNEL, (_event, agentEvent: AgentEvent) => listener(agentEvent))
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
