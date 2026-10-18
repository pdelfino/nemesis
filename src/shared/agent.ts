/**
 * The prompt and agent vocabulary shared by the main process and the renderer
 * (#61). The main process owns the one agent session, the queue of prompts
 * waiting for it, the history of the prompts sent and the draft being typed;
 * the prompt buffer in the window is a view of that state, so a reload or a
 * failed send loses no text.
 *
 * Agent events cross the bridge unchanged, in the shapes src/main/agent/events.ts
 * defines: the transcript (#62) and the permission prompt (#63) read them.
 */

import type { AgentEvent, AgentQuestion } from '../main/agent/events'

export type { AgentEvent, AgentQuestion }

/** A prompt waiting its turn. The text came from the renderer and goes back to it. */
export interface QueuedPrompt {
  readonly id: string
  readonly text: string
}

/** Whether the agent is in a turn, and what waits behind it. */
export interface PromptQueueState {
  readonly busy: boolean
  readonly queued: readonly QueuedPrompt[]
}

/**
 * What the main process answers to a send: the prompt went now, it waits, or
 * the text answered the pending question instead of starting a turn (#63).
 */
export interface PromptReceipt {
  readonly id: string
  readonly status: 'sent' | 'queued' | 'answered'
  /** Place in the queue, 1 first; 0 when the prompt was sent at once. */
  readonly position: number
}

/** Everything the prompt buffer needs to rebuild itself after a reload. */
export interface PromptState {
  readonly draft: string
  readonly history: readonly string[]
  readonly queue: PromptQueueState
}

/** A prompt, or a draft, longer than this is refused rather than truncated. */
export const MAX_PROMPT_LENGTH = 1_000_000

/** The renderer sends a prompt; the answer is a receipt. */
export const PROMPT_SEND_CHANNEL = 'nemesis:prompt-send' as const
/** The renderer parks the draft in the main process as it types. */
export const PROMPT_DRAFT_CHANNEL = 'nemesis:prompt-draft' as const
/** The renderer asks for draft, history and queue once at load. */
export const PROMPT_STATE_CHANNEL = 'nemesis:prompt-state' as const
/** The main process pushes the queue state on every send and every finished turn. */
export const PROMPT_QUEUE_CHANNEL = 'nemesis:prompt-queue' as const
/** The main process pushes every agent event, unchanged. */
export const AGENT_EVENT_CHANNEL = 'nemesis:agent-event' as const

/**
 * Where the transcript's point should go (#69): the line of a search match,
 * as the window shows it, once the session it belongs to is shown again.
 */
export interface TranscriptGoto {
  readonly text: string
}

/** The main process pushes a line for the transcript buffer to move its point to. */
export const TRANSCRIPT_GOTO_CHANNEL = 'nemesis:transcript-goto' as const

/**
 * Text a command adds to the prompt being composed (#81): a verification
 * criterion from `attach-check`, the path of a screenshot. The editor in
 * the window holds the draft, so the text goes there and is appended after
 * what is typed; the main process never rewrites the draft itself. A file
 * mention (#83) goes `at` the point instead, where the `@` was typed.
 */
export interface PromptInsert {
  readonly text: string
  /** Where the text goes: after everything typed, or at the point. */
  readonly at?: 'point'
}

/** The main process pushes text for the prompt buffer to append. */
export const PROMPT_INSERT_CHANNEL = 'nemesis:prompt-insert' as const
