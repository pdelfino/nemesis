import type {
  AgentEvent,
  PromptQueueState,
  PromptReceipt,
  PromptState,
  TranscriptGoto,
} from './agent'
import type { BufferInfo, BufferList, BufferSpec } from './buffers'
import type { DispatchRecord, KeyBindings, KeyOutcome, KeyPress } from './keys'
import type { HelpContent, PaletteAnswer, PaletteOutcome, PaletteRequest } from './palette'

/**
 * The surface internal pages see as `window.nemesis`. Implemented by the
 * preload script, consumed by the renderer. Grows only through typed IPC
 * (SECURITY.org, T1; completed by #53).
 */
export interface NemesisApi {
  readonly name: 'nemesis'
  readonly version: string
  /** Reports a key press to the main process, which owns the keymaps (#59). */
  sendKey(press: KeyPress): Promise<KeyOutcome>
  /** The shape of the keymaps: which chords are the cockpit's, so the editor keeps the rest (#61). */
  bindings(): Promise<KeyBindings>
  /** The buffer list as the main process holds it now (#60). */
  buffers(): Promise<BufferList>
  /** Follows the buffer list: every create, switch and kill calls back (#60). */
  onBuffersChanged(listener: (list: BufferList) => void): void
  /** Sends a prompt to the agent, or queues it while a turn is running (#61). */
  sendPrompt(text: string): Promise<PromptReceipt>
  /** Parks the prompt draft in the main process, so a reload does not lose it (#61). */
  saveDraft(text: string): Promise<void>
  /** The draft, the history and the queue, for the prompt buffer to rebuild itself (#61). */
  promptState(): Promise<PromptState>
  /** Follows the prompt queue: every send and every finished turn calls back (#61). */
  onPromptQueueChanged(listener: (state: PromptQueueState) => void): void
  /** Every event of the cockpit's agent session, unchanged (#61; the transcript renders them, #62). */
  onAgentEvent(listener: (event: AgentEvent) => void): void
  /** The main process wants a choice: the palette opens over the candidates (#65). */
  onPaletteOpen(listener: (request: PaletteRequest) => void): void
  /** Answers a palette read with the candidate picked, or null for a cancel (#65). */
  answerPalette(answer: PaletteAnswer): Promise<PaletteOutcome>
  /** The help buffer has new text: describe-command or describe-key answered (#65). */
  onHelpShown(listener: (content: HelpContent) => void): void
  /** The transcript's point should go to this line: a search match was opened (#69). */
  onTranscriptGoto(listener: (target: TranscriptGoto) => void): void
  /** Test-only: the commands the keys dispatched. Exposed when NODE_ENV=test (#59). */
  readonly dispatchLog?: () => Promise<readonly DispatchRecord[]>
  /** Test-only: opens a buffer. Exposed when NODE_ENV=test (#60). */
  readonly createBuffer?: (spec: BufferSpec) => Promise<BufferInfo>
}

declare global {
  interface Window {
    nemesis: NemesisApi
  }
}

export const APP_NAME = 'Nemesis' as const
