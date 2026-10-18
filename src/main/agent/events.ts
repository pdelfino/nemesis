import type { PermissionMode } from '@anthropic-ai/claude-agent-sdk'

/**
 * What the cockpit sees of an agent session (#58). Buffers, the transcript and
 * every later IPC payload read these, never the SDK's own message shapes: the
 * translation happens once, in session.ts, so one file changes when the SDK
 * grows a frame.
 */

/** The SDK's permission modes, under the name the cockpit uses for them. */
export type AgentPermissionMode = PermissionMode

/** The session is up: the SDK has answered with its init frame. */
export interface AgentStartedEvent {
  readonly type: 'started'
  readonly sessionId: string
  readonly model: string
  readonly permissionMode: AgentPermissionMode
  readonly cwd: string
  readonly tools: readonly string[]
}

/**
 * A message the user sent to the agent, emitted by the session as it takes
 * the text, before anything the agent answers. The transcript (#62) shows the
 * conversation in order from this one stream.
 */
export interface AgentUserTextEvent {
  readonly type: 'user-text'
  readonly text: string
}

/** One finished text block from the assistant. */
export interface AgentTextEvent {
  readonly type: 'assistant-text'
  readonly text: string
}

/** One finished thinking block. The transcript shows it folded (#62). */
export interface AgentThinkingEvent {
  readonly type: 'assistant-thinking'
  readonly text: string
}

/** The assistant asked for a tool. The arguments are data, never instructions. */
export interface AgentToolUseEvent {
  readonly type: 'tool-use'
  readonly toolUseId: string
  readonly name: string
  readonly input: Record<string, unknown>
}

/** What a tool returned, paired with its call by `toolUseId`. */
export interface AgentToolResultEvent {
  readonly type: 'tool-result'
  readonly toolUseId: string
  readonly isError: boolean
  readonly text: string
}

/** The turn is over. `result` is the assistant's final text, or the errors. */
export interface AgentTurnEndEvent {
  readonly type: 'turn-end'
  readonly isError: boolean
  readonly result: string
  readonly durationMs: number
  readonly numTurns: number
}

/** The stream itself failed. The session is over; the message is safe to show. */
export interface AgentErrorEvent {
  readonly type: 'error'
  readonly message: string
}

/** The stream ended, either on its own or because `stop()` interrupted it. */
export interface AgentStoppedEvent {
  readonly type: 'stopped'
  readonly reason: 'interrupted' | 'ended'
}

export type AgentEvent =
  | AgentStartedEvent
  | AgentUserTextEvent
  | AgentTextEvent
  | AgentThinkingEvent
  | AgentToolUseEvent
  | AgentToolResultEvent
  | AgentTurnEndEvent
  | AgentErrorEvent
  | AgentStoppedEvent

export type AgentEventListener = (event: AgentEvent) => void

/** A tool the agent wants to run, handed to the permission handler. */
export interface PermissionRequest {
  readonly toolName: string
  /** Pairs the request with the `tool-use` event the UI already showed. */
  readonly toolUseId: string
  readonly input: Record<string, unknown>
  /** Aborted when the SDK gives up on the request. */
  readonly signal: AbortSignal
  /** The SDK's own prompt sentence, when it supplied one. Prefer it in the UI. */
  readonly title?: string | undefined
}

export type PermissionDecision =
  | { readonly behavior: 'allow'; readonly updatedInput?: Record<string, unknown> | undefined }
  | { readonly behavior: 'deny'; readonly message: string }

/**
 * The seam the permission policy plugs into. This issue (#58) owns the
 * interface and nothing else: the policy that decides is #55, and the UI that
 * asks the user is the permission prompt (#63). Both implement this.
 */
export interface PermissionHandler {
  requestPermission(request: PermissionRequest): Promise<PermissionDecision>
}
