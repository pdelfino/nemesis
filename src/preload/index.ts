import { contextBridge, ipcRenderer } from 'electron'
import {
  AGENT_EVENT_CHANNEL,
  PROMPT_DRAFT_CHANNEL,
  PROMPT_INSERT_CHANNEL,
  PROMPT_QUEUE_CHANNEL,
  PROMPT_SEND_CHANNEL,
  PROMPT_STATE_CHANNEL,
  TRANSCRIPT_GOTO_CHANNEL,
} from '../shared/agent'
import type { NemesisApi } from '../shared/api'
import type { BufferSpec } from '../shared/buffers'
import { BUFFER_CREATE_CHANNEL, BUFFERS_CHANGED_CHANNEL, BUFFERS_CHANNEL } from '../shared/buffers'
import { DIFF_SHOWN_CHANNEL } from '../shared/diff'
import { ENVIRONMENT_SHOWN_CHANNEL } from '../shared/environment'
import type {
  InvokeAnswer,
  InvokeArgs,
  InvokeChannel,
  PushChannel,
  PushPayload,
} from '../shared/ipc'
import { BINDINGS_CHANNEL, DISPATCH_LOG_CHANNEL, KEY_CHANNEL } from '../shared/keys'
import { HELP_SHOWN_CHANNEL, PALETTE_ANSWER_CHANNEL, PALETTE_OPEN_CHANNEL } from '../shared/palette'
import { PLAN_ANSWER_CHANNEL, PLAN_SHOWN_CHANNEL } from '../shared/plan'
import { JOURNAL_CHANGED_CHANNEL, REPL_SHOWN_CHANNEL } from '../shared/repl'
import { REVIEW_SHOWN_CHANNEL } from '../shared/review'
import { SPEC_SHOWN_CHANNEL } from '../shared/spec'

// The only bridge between internal pages and the main process (SECURITY.org,
// T1; #53). Typed functions only, never a raw ipcRenderer: every call goes
// through the channel table in src/shared/ipc.ts, the same table the main
// process registers its validated handlers through, so the two sides cannot
// disagree on a payload or an answer without failing to compile.
function invoke<C extends InvokeChannel>(
  channel: C,
  ...args: InvokeArgs<C>
): Promise<InvokeAnswer<C>> {
  return ipcRenderer.invoke(channel, ...args) as Promise<InvokeAnswer<C>>
}

// The IpcRendererEvent never crosses the bridge: the page sees the payload only.
function on<C extends PushChannel>(channel: C, listener: (payload: PushPayload<C>) => void): void {
  ipcRenderer.on(channel, (_event, payload: PushPayload<C>) => listener(payload))
}

const base = {
  name: 'nemesis',
  version: '0.0.1',
  sendKey: (press) => invoke(KEY_CHANNEL, press),
  bindings: () => invoke(BINDINGS_CHANNEL),
  buffers: () => invoke(BUFFERS_CHANNEL),
  onBuffersChanged: (listener) => on(BUFFERS_CHANGED_CHANNEL, listener),
  sendPrompt: (text) => invoke(PROMPT_SEND_CHANNEL, text),
  saveDraft: (text) => invoke(PROMPT_DRAFT_CHANNEL, text),
  promptState: () => invoke(PROMPT_STATE_CHANNEL),
  onPromptQueueChanged: (listener) => on(PROMPT_QUEUE_CHANNEL, listener),
  onAgentEvent: (listener) => on(AGENT_EVENT_CHANNEL, listener),
  onPaletteOpen: (listener) => on(PALETTE_OPEN_CHANNEL, listener),
  answerPalette: (answer) => invoke(PALETTE_ANSWER_CHANNEL, answer),
  onHelpShown: (listener) => on(HELP_SHOWN_CHANNEL, listener),
  onTranscriptGoto: (listener) => on(TRANSCRIPT_GOTO_CHANNEL, listener),
  onDiffShown: (listener) => on(DIFF_SHOWN_CHANNEL, listener),
  onPlanShown: (listener) => on(PLAN_SHOWN_CHANNEL, listener),
  answerPlan: (answer) => invoke(PLAN_ANSWER_CHANNEL, answer),
  onSpecShown: (listener) => on(SPEC_SHOWN_CHANNEL, listener),
  onReviewShown: (listener) => on(REVIEW_SHOWN_CHANNEL, listener),
  onPromptInsert: (listener) => on(PROMPT_INSERT_CHANNEL, listener),
  onEnvironmentShown: (listener) => on(ENVIRONMENT_SHOWN_CHANNEL, listener),
  // Eval (#72) is two pushes and no invoke: the form is read through the
  // palette answer channel like any other free text, and evaluated in the
  // main process on a command the user ran.
  onReplShown: (listener) => on(REPL_SHOWN_CHANNEL, listener),
  onJournalChanged: (listener) => on(JOURNAL_CHANGED_CHANNEL, listener),
} satisfies NemesisApi

// The dispatch log is how the end-to-end specs see what a chord ran (#59), and
// create-buffer is how they open a second transcript (#60). Both are gated at
// runtime on NODE_ENV=test: the shipped bundle carries the code and exposes
// neither unless the process was launched with that variable set.
const api: NemesisApi = Object.freeze(
  process.env['NODE_ENV'] === 'test'
    ? {
        ...base,
        dispatchLog: () => invoke(DISPATCH_LOG_CHANNEL),
        createBuffer: (spec: BufferSpec) => invoke(BUFFER_CREATE_CHANNEL, spec),
      }
    : base,
)

contextBridge.exposeInMainWorld('nemesis', api)
