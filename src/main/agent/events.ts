import type { EffortLevel, PermissionMode } from '@anthropic-ai/claude-agent-sdk'

/**
 * What the cockpit sees of an agent session (#58). Buffers, the transcript and
 * every later IPC payload read these, never the SDK's own message shapes: the
 * translation happens once, in session.ts, so one file changes when the SDK
 * grows a frame.
 */

/** The SDK's permission modes, under the name the cockpit uses for them. */
export type AgentPermissionMode = PermissionMode

/** The SDK's effort levels (#190), under the name the cockpit uses for them. */
export type AgentEffortLevel = EffortLevel

/** One MCP server as the init frame reports it (#86): its config name and its connection status. */
export interface AgentMcpServer {
  readonly name: string
  readonly status: string
}

/** One plugin as the init frame reports it (#86); the version only when its manifest declares one. */
export interface AgentPlugin {
  readonly name: string
  readonly version?: string | undefined
}

/**
 * The session is up: the SDK has answered with its init frame. The frame's
 * lists of what the session can reach (#86) ride along for the environment
 * panel; a history recorded before they were kept carries none of them.
 */
export interface AgentStartedEvent {
  readonly type: 'started'
  readonly sessionId: string
  readonly model: string
  readonly permissionMode: AgentPermissionMode
  readonly cwd: string
  readonly tools: readonly string[]
  readonly claudeCodeVersion?: string | undefined
  readonly mcpServers?: readonly AgentMcpServer[] | undefined
  readonly skills?: readonly string[] | undefined
  readonly agents?: readonly string[] | undefined
  readonly slashCommands?: readonly string[] | undefined
  readonly plugins?: readonly AgentPlugin[] | undefined
}

/**
 * A message the user sent to the agent, emitted by the session as it takes
 * the text, before anything the agent answers. The transcript (#62) shows the
 * conversation in order from this one stream.
 */
export interface AgentUserTextEvent {
  readonly type: 'user-text'
  readonly text: string
  /** Sent into a turn that was running, past the queue (#194). */
  readonly steered?: true | undefined
}

/**
 * Set on an event that happened inside a subagent (#85): the id of the tool
 * call, on the main thread, that started it. The transcript shows these as
 * collapsed child blocks, so an investigation delegated to subagents leaves
 * the main view clean. Absent on everything the main thread did itself.
 */
export interface AgentChildEvent {
  readonly parentToolUseId?: string | undefined
}

/** One finished text block from the assistant. */
export interface AgentTextEvent extends AgentChildEvent {
  readonly type: 'assistant-text'
  readonly text: string
}

/** One finished thinking block. The transcript shows it folded (#62). */
export interface AgentThinkingEvent extends AgentChildEvent {
  readonly type: 'assistant-thinking'
  readonly text: string
}

/** The assistant asked for a tool. The arguments are data, never instructions. */
export interface AgentToolUseEvent extends AgentChildEvent {
  readonly type: 'tool-use'
  readonly toolUseId: string
  readonly name: string
  readonly input: Record<string, unknown>
}

/** What a tool returned, paired with its call by `toolUseId`. */
export interface AgentToolResultEvent extends AgentChildEvent {
  readonly type: 'tool-result'
  readonly toolUseId: string
  readonly isError: boolean
  readonly text: string
}

/**
 * The turn is over. `result` is the assistant's final text, or the errors.
 * The cost (#191) is the SDK's estimate at list price, from the result's
 * `total_cost_usd`: the session's total so far and what this turn added. The
 * mode line and the agents list show it; the bridge leaves it out of the
 * session log, so the folder's format stays what it was.
 */
export interface AgentTurnEndEvent {
  readonly type: 'turn-end'
  readonly isError: boolean
  readonly result: string
  readonly durationMs: number
  readonly numTurns: number
  readonly costUsd?: number | undefined
  readonly turnCostUsd?: number | undefined
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

/** One option of an AskUserQuestion question, as the tool's input spells it. */
export interface AgentQuestionOption {
  readonly label: string
  readonly description: string
}

/** One AskUserQuestion question. The cockpit numbers the options; a digit picks one (#63). */
export interface AgentQuestion {
  readonly question: string
  /** The tool's short tag for the question, shown in the mode line. */
  readonly header: string
  readonly options: readonly AgentQuestionOption[]
  readonly multiSelect: boolean
}

/**
 * The permission bridge is waiting on the user (#63). A request is a block in
 * the transcript and a buffer in the mode line until it is answered. When the
 * tool is AskUserQuestion, `questions` carries what it asks, parsed from the
 * input; the input itself is still data, never instructions.
 */
export interface AgentPermissionRequestEvent {
  readonly type: 'permission-request'
  /** The bridge's own id, so an answer names the request it closes. */
  readonly requestId: string
  readonly toolUseId: string
  readonly toolName: string
  readonly input: Record<string, unknown>
  /** The SDK's own prompt sentence, when it supplied one. */
  readonly title?: string | undefined
  readonly questions?: readonly AgentQuestion[] | undefined
}

/** One question of a pending AskUserQuestion was answered; more may remain. */
export interface AgentQuestionAnsweredEvent {
  readonly type: 'question-answered'
  readonly requestId: string
  /** Position of the question in the request, 0 first. */
  readonly index: number
  readonly header: string
  readonly answer: string
}

/**
 * How a request was closed. `allow` once, `allow-session` for the rest of the
 * session, `deny` with the message the agent got, `answered` for a question
 * whose answers went back, `aborted` when the SDK withdrew the request.
 */
export interface AgentPermissionAnsweredEvent {
  readonly type: 'permission-answered'
  readonly requestId: string
  readonly toolName: string
  readonly outcome: 'allow' | 'allow-session' | 'deny' | 'answered' | 'aborted'
  readonly message?: string | undefined
}

/**
 * A one-line notice from the cockpit itself, not from the agent: a site
 * permission refused by the policy in src/main/security/permissions.ts (#49).
 * The transcript shows it as a note, so the user knows why a page "does not
 * work", and the session folder keeps it with the rest.
 */
export interface AgentNoticeEvent {
  readonly type: 'notice'
  readonly text: string
  /** Where it came from (config, hook, download, permission); the messages log (#170) reads it. */
  readonly source?: string
}

/**
 * How full the context window is (#80): the tokens the last request to the
 * model carried, against the window the SDK reports for that model. The
 * mode line draws the meter from this; the recorder keeps it, so a resumed
 * session shows where it left off.
 */
export interface AgentContextUsageEvent {
  readonly type: 'context-usage'
  readonly usedTokens: number
  readonly windowTokens: number
}

/**
 * A suggestion from the cockpit, not from the agent (#80): the guide's
 * advice at the moment it applies, two corrections in a row for one. The
 * mode line shows it until the next prompt; the transcript notes it.
 */
export interface AgentNudgeEvent {
  readonly type: 'nudge'
  readonly text: string
}

/**
 * The permission mode changed (#82): plan mode toggled on or off, or a plan
 * approved and the session back in the mode plan mode replaced. The mode
 * line shows the mode at all times from this and from `started`; the
 * transcript notes it.
 */
export interface AgentPermissionModeEvent {
  readonly type: 'permission-mode'
  readonly mode: AgentPermissionMode
}

/** Where the `verify` key took its command from (#81), in the order it looks. */
export type VerifySource = 'issue' | 'settings' | 'default'

/**
 * Evidence (#81): what the check the `verify` key ran came to, the output
 * verbatim with the exit code and the time it took. Emitted by the cockpit,
 * not by the agent: the check ran with the user's permissions, outside the
 * agent's tool path, and the agent sees nothing of it unless the user sends
 * it. The transcript shows it folded with the status in the header; the Org
 * file keeps the output as an example block.
 */
export interface AgentEvidenceEvent {
  readonly type: 'evidence'
  readonly command: string
  readonly source: VerifySource
  /** Null when the process was killed by a signal or never started. */
  readonly exitCode: number | null
  readonly signal: string | null
  readonly durationMs: number
  /** stdout and stderr as they arrived, the tail when there was too much. */
  readonly output: string
}

/**
 * The user named the session (#104): `name-session` appends this to the
 * event log like every other event, so the on-disk format gains one event
 * type and no file is rewritten. Renaming appends another; the latest wins.
 * The sessions palette, the window title and the mode line read it.
 */
export interface AgentNamedEvent {
  readonly type: 'named'
  readonly name: string
}

/**
 * The stop gate (#113): on, the end of every turn runs the check and a red
 * result goes back to the session as the next prompt, up to `cap` times.
 * Emitted when the gate is toggled and when its retry count moves, so the
 * mode line shows `gate` and the count from the event push it already
 * reads. One more event type in the log, as `named` was (#104): an older
 * reader skips the line.
 */
export interface AgentStopGateEvent {
  readonly type: 'stop-gate'
  readonly on: boolean
  /** Retry prompts sent for the current task so far. */
  readonly retries: number
  readonly cap: number
}

/**
 * The model or the effort level of the running session changed (#190):
 * `set-model` and `set-effort` switch them mid-session. The mode line shows
 * both from this and from `started`; the transcript notes it. The switch is
 * for this session only, so the recorder leaves it out of the session log.
 */
export interface AgentModelEvent {
  readonly type: 'model'
  /** Null when the session has not yet said which model it runs. */
  readonly model: string | null
  /** Null while the model's default effort applies. */
  readonly effort: AgentEffortLevel | null
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
  | AgentPermissionRequestEvent
  | AgentQuestionAnsweredEvent
  | AgentPermissionAnsweredEvent
  | AgentNoticeEvent
  | AgentContextUsageEvent
  | AgentNudgeEvent
  | AgentPermissionModeEvent
  | AgentEvidenceEvent
  | AgentNamedEvent
  | AgentStopGateEvent
  | AgentModelEvent

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
