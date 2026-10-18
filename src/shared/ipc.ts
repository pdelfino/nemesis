/**
 * Every IPC channel, with what crosses it (#53, SECURITY.org T1).
 *
 * The bridge between an internal page and the main process is this table:
 * the preload invokes and listens through it, and `handle()` in
 * src/main/ipc.ts registers a handler through it, so a channel without a
 * payload type, an answer type and a parser does not compile. The names
 * themselves stay next to the vocabulary each one carries (keys, buffers,
 * prompts, the palette); this file only ties name to shape.
 */

import type {
  AGENT_EVENT_CHANNEL,
  AgentEvent,
  PROMPT_DRAFT_CHANNEL,
  PROMPT_INSERT_CHANNEL,
  PROMPT_QUEUE_CHANNEL,
  PROMPT_SEND_CHANNEL,
  PROMPT_STATE_CHANNEL,
  PromptInsert,
  PromptQueueState,
  PromptReceipt,
  PromptState,
  TRANSCRIPT_GOTO_CHANNEL,
  TranscriptGoto,
} from './agent'
import type {
  BUFFER_CREATE_CHANNEL,
  BufferInfo,
  BufferList,
  BUFFERS_CHANGED_CHANNEL,
  BUFFERS_CHANNEL,
  BufferSpec,
} from './buffers'
import type { DIFF_SHOWN_CHANNEL, DiffContent } from './diff'
import type {
  BINDINGS_CHANNEL,
  DISPATCH_LOG_CHANNEL,
  DispatchRecord,
  KEY_CHANNEL,
  KeyBindings,
  KeyOutcome,
  KeyPress,
} from './keys'
import type { PLAN_ANSWER_CHANNEL, PLAN_SHOWN_CHANNEL, PlanAnswer, PlanContent } from './plan'
import type { SPEC_SHOWN_CHANNEL, SpecContent } from './spec'
import type {
  HELP_SHOWN_CHANNEL,
  HelpContent,
  PALETTE_ANSWER_CHANNEL,
  PALETTE_OPEN_CHANNEL,
  PaletteAnswer,
  PaletteOutcome,
  PaletteRequest,
} from './palette'

/**
 * Renderer to main, one request and one answer: `ipcRenderer.invoke` on the
 * preload side, `handle()` on the main side. A `payload` of `undefined` is a
 * call with no argument.
 */
export interface InvokeChannels {
  readonly [KEY_CHANNEL]: { payload: KeyPress; answer: KeyOutcome }
  readonly [BINDINGS_CHANNEL]: { payload: undefined; answer: KeyBindings }
  readonly [DISPATCH_LOG_CHANNEL]: { payload: undefined; answer: readonly DispatchRecord[] }
  readonly [BUFFERS_CHANNEL]: { payload: undefined; answer: BufferList }
  readonly [BUFFER_CREATE_CHANNEL]: { payload: BufferSpec; answer: BufferInfo }
  readonly [PROMPT_SEND_CHANNEL]: { payload: string; answer: PromptReceipt }
  readonly [PROMPT_DRAFT_CHANNEL]: { payload: string; answer: void }
  readonly [PROMPT_STATE_CHANNEL]: { payload: undefined; answer: PromptState }
  readonly [PALETTE_ANSWER_CHANNEL]: { payload: PaletteAnswer; answer: PaletteOutcome }
  readonly [PLAN_ANSWER_CHANNEL]: { payload: PlanAnswer; answer: void }
}

/** Main to renderer, pushed: `webContents.send` on one side, `ipcRenderer.on` on the other. */
export interface PushChannels {
  readonly [BUFFERS_CHANGED_CHANNEL]: BufferList
  readonly [PROMPT_QUEUE_CHANNEL]: PromptQueueState
  readonly [AGENT_EVENT_CHANNEL]: AgentEvent
  readonly [PALETTE_OPEN_CHANNEL]: PaletteRequest
  readonly [HELP_SHOWN_CHANNEL]: HelpContent
  readonly [TRANSCRIPT_GOTO_CHANNEL]: TranscriptGoto
  readonly [DIFF_SHOWN_CHANNEL]: DiffContent
  readonly [PLAN_SHOWN_CHANNEL]: PlanContent
  readonly [SPEC_SHOWN_CHANNEL]: SpecContent
  readonly [PROMPT_INSERT_CHANNEL]: PromptInsert
}

export type InvokeChannel = keyof InvokeChannels
export type InvokePayload<C extends InvokeChannel> = InvokeChannels[C]['payload']
export type InvokeAnswer<C extends InvokeChannel> = InvokeChannels[C]['answer']
/** The argument list of an invoke: nothing for a channel without a payload. */
export type InvokeArgs<C extends InvokeChannel> =
  InvokePayload<C> extends undefined ? [] : [payload: InvokePayload<C>]

export type PushChannel = keyof PushChannels
export type PushPayload<C extends PushChannel> = PushChannels[C]
