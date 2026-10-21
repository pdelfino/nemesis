import type { ModelInfo, RewindFilesResult, SlashCommand } from '@anthropic-ai/claude-agent-sdk'
import type {
  AgentEffortLevel,
  AgentEvent,
  AgentEventListener,
  AgentEvidenceEvent,
  AgentPermissionMode,
  AgentStartedEvent,
  AgentTurnEndEvent,
  PermissionHandler,
} from './events'
import type { SessionAttentionListener } from '../../shared/notify'
import { AttentionTracker } from './attention'
import { CorrectionCounter, NUDGE_AFTER, nudgeText } from './corrections'
import type {
  AgentDriver,
  AgentSession,
  AgentSessionOptions,
  Checkpoint,
  ToolCall,
  UserImageBlock,
  UserPriority,
} from './session'
import { AgentSessionError, createAgentSession, denyEveryTool, resolveDriver } from './session'
import { checkPassed, gatePrompt } from '../verify'

/**
 * The session manager (#84): the one place that holds the cockpit's current
 * agent session and can replace it. The guide's course corrections are its
 * methods: `interrupt` stops the running turn and keeps the context, `newTask`
 * drops the session for a fresh one in the same window, `rewind` takes the
 * files or the conversation back to a checkpoint through what the SDK
 * exposes, and `lastToolCalls` feeds the undo prompt. `resume` (#67) picks
 * a past session up by the SDK's id, with its recorded history shown first.
 * `previewRewind` (#99) is the SDK's dry run of a file rewind, so the cockpit
 * shows the files before it asks and touches nothing until the yes.
 * `sideQuestion` (#80) asks a throwaway copy of the session, so the answer
 * never enters its history, and the correction counter (#80) watches the
 * user turns and nudges at the second correction in a row. The permission
 * mode lives here too (#82): the next session starts in it, the running one
 * is told when it changes, and `togglePlanMode` is the guide's plan mode as
 * a key, with the mode it replaced kept for when the plan is approved.
 * The attention stream (#90) says when the user is wanted: a finished turn,
 * a permission request or a question, an error, for the notifications.
 * The stop gate (#113) holds a turn's end: gated, a turn that ended well
 * runs the check, and a red one goes back as the next prompt until it is
 * green or the cap is reached; only then does the turn end for the user.
 *
 * Listeners subscribe once, here, and hear every session the manager runs in
 * turn: the prompt queue, the recorder and the window never learn that the
 * session underneath changed, except through the events that say so. The
 * manager's own notices go down the same stream.
 *
 * Plain data and no Electron types, like session.ts, so the unit tests drive
 * it with the mock driver and the bridge wires it to the window.
 */

export interface SessionManagerOptions {
  readonly cwd: string
  /** The model from the settings; null leaves the choice to the CLI. */
  readonly model: string | null
  readonly permissionHandler: PermissionHandler
  /**
   * The in-process MCP servers each session the manager starts gets (#28).
   * A factory, since the MCP SDK binds a server instance to one transport,
   * and every session connects its own.
   */
  readonly mcpServers?: (() => AgentSessionOptions['mcpServers']) | undefined
  /** The SDK hooks each session the manager starts gets: the page boundary of #55. */
  readonly hooks?: AgentSessionOptions['hooks'] | undefined
  /** Injected by the tests; production resolves the driver from NODE_ENV. */
  readonly driver?: AgentDriver | undefined
  /** The permission bridge's announcements, read for the "needs you" moment (#90). */
  readonly requests?: { on(listener: AgentEventListener): () => void } | undefined
  /** The clock the attention stream measures turns with; the tests pass their own. */
  readonly now?: (() => number) | undefined
  /** What the stop gate runs and sends through (#113); without it the gate cannot go on. */
  readonly stopGate?: StopGateOptions | undefined
}

/**
 * The stop gate's doors (#113). The check is the Verifier's (#81): a child
 * of the cockpit, never a tool call of the agent, with the confirmation of
 * an attached issue's command (#98) as it is for the verify key. The retry
 * goes through the prompt queue, so it waits its turn behind anything the
 * user queued and reads in the transcript as any other prompt.
 */
export interface StopGateOptions {
  /** Runs the check; null when the user refused an attached issue's command. */
  readonly verify: () => Promise<AgentEvidenceEvent | null>
  readonly submit: (text: string) => Promise<unknown>
  /** The retry cap from the settings, read at each turn end. */
  readonly retries: () => number
}

/**
 * The guide's own words, the first time the gate goes on in a window: the
 * check as a goal, so an unattended run finishes correctly instead of
 * merely stopping. Shown in the mode line until the next prompt.
 */
export const STOP_GATE_REMINDER =
  'Stop gate: set the check as the goal, so the run finishes correctly instead of merely stopping. A red check goes back as the next prompt; M-x toggle-stop-gate turns it off.'

/** What a rewind restores. `summarize` is not among them: the SDK exposes no such call. */
export type RewindTarget = 'conversation' | 'code' | 'both'

/** Hears the recorded events of a session being resumed, oldest first (#67). */
export type SessionHistoryListener = (history: readonly AgentEvent[]) => void

export const REWIND_TARGETS: readonly RewindTarget[] = ['conversation', 'code', 'both']

/** Every effort level the SDK takes, lowest first: the choice when the model lists none of its own (#190). */
export const EFFORT_LEVELS: readonly AgentEffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max']

/**
 * The guide's callout, the first time plan mode goes on in a session (#82):
 * not every task needs a plan. Shown in the mode line until the next prompt.
 */
export const PLAN_MODE_REMINDER =
  'Plan mode: small, clear changes skip planning; C-c C-p turns it off again.'

/** The checkpoint list a rewind buffer shows, with the actions the SDK exposes (#84). */
export function describeCheckpoints(checkpoints: readonly Checkpoint[]): string {
  const lines: string[] = ['Checkpoints, one per prompt sent, oldest first.']
  if (checkpoints.length === 0) {
    lines.push('', 'None yet: send a prompt and it opens the first one.')
  } else {
    lines.push('')
    for (const checkpoint of checkpoints) lines.push(describeCheckpoint(checkpoint))
  }
  lines.push(
    '',
    'Restore conversation: the session goes back to before the checkpoint; later turns are dropped.',
    'Restore code: files the agent edited since the checkpoint go back to their state then.',
    'Restore both: the two together.',
    'Summarize from here: not available, the Agent SDK exposes no such call.',
  )
  return lines.join('\n')
}

/**
 * The help buffer before a file rewind is confirmed (#99): the files the
 * SDK's dry run says would change, with its counts, and for a rewind of both
 * how many turns the conversation drops too (`dropped` is null for code alone).
 */
export function describeRewindPreview(
  checkpoint: Checkpoint,
  result: RewindFilesResult,
  dropped: number | null,
): string {
  const files = result.filesChanged ?? []
  const lines: string[] = [
    `Rewind to checkpoint ${checkpoint.index}: the files that would change.`,
    '',
  ]
  if (files.length === 0) lines.push('None: no file changed since the checkpoint.')
  for (const file of files) lines.push(`  ${file}`)
  lines.push(
    '',
    `${count(files.length, 'file')}, ${count(result.insertions ?? 0, 'insertion')}, ${count(result.deletions ?? 0, 'deletion')}.`,
  )
  if (dropped !== null) {
    lines.push(
      `The conversation goes back to before the checkpoint as well: ${count(dropped, 'turn')} dropped.`,
    )
  }
  return lines.join('\n')
}

/** The question before the files are restored (#99), from the dry run's count. */
export function rewindFilesQuestion(checkpoint: Checkpoint, result: RewindFilesResult): string {
  return `Restore ${count(result.filesChanged?.length ?? 0, 'file')} to checkpoint ${checkpoint.index}?`
}

/** The one question before a conversation-only rewind (#99): how many turns go. */
export function rewindConversationQuestion(checkpoint: Checkpoint, dropped: number): string {
  return `Restore the conversation to before checkpoint ${checkpoint.index}, dropping ${count(dropped, 'turn')}?`
}

/** How many turns a conversation rewind to `checkpoint` drops: it and every later one. */
export function turnsDropped(checkpoints: readonly Checkpoint[], checkpoint: Checkpoint): number {
  return checkpoints.filter((c) => c.index >= checkpoint.index).length
}

function count(n: number, noun: string, plural = `${noun}s`): string {
  return `${n} ${n === 1 ? noun : plural}`
}

/** One checkpoint on one line: its number, when, and the first line of the prompt. */
export function describeCheckpoint(checkpoint: Checkpoint): string {
  return `${checkpoint.index}. ${timeOf(checkpoint.at)}  ${firstLine(checkpoint.text)}`
}

/**
 * The guide's "undo that", with the tool calls of the last turn quoted as
 * data so the agent knows which actions are meant (#84). Arguments are cut
 * to a line each; the agent has the full calls in its own context.
 */
export function undoPrompt(calls: readonly ToolCall[]): string {
  if (calls.length === 0) return 'Undo that.'
  const quoted = calls.map((call) => `${call.name} ${compactInput(call.input)}`)
  return ['Undo that. The last tool calls were:', '', '```', ...quoted, '```'].join('\n')
}

const INPUT_LIMIT = 200

function compactInput(input: Record<string, unknown>): string {
  let json: string
  try {
    json = JSON.stringify(input)
  } catch {
    json = '{}'
  }
  return json.length > INPUT_LIMIT ? `${json.slice(0, INPUT_LIMIT - 3)}...` : json
}

function firstLine(text: string): string {
  const line = text
    .split('\n')
    .map((candidate) => candidate.trim())
    .find((candidate) => candidate.length > 0)
  return line ?? '(empty prompt)'
}

function timeOf(at: number): string {
  const date = new Date(at)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export class SessionManager {
  private readonly options: SessionManagerOptions
  private readonly listeners = new Set<AgentEventListener>()
  private readonly historyListeners = new Set<SessionHistoryListener>()
  private readonly attentionListeners = new Set<SessionAttentionListener>()
  private readonly attention: AttentionTracker
  private driver: AgentDriver | null
  private session: AgentSession | null = null
  private offSession: (() => void) | null = null
  private readonly corrections = new CorrectionCounter()
  /** The mode the next session starts in and the running one was told (#82). */
  private mode: AgentPermissionMode = 'default'
  /** What plan mode replaced, so an approved plan goes back to it. */
  private beforePlan: AgentPermissionMode = 'default'
  /** The guide's callout went out already in this session. */
  private planReminded = false
  /** The init frame of the running session, as its `started` event carries it (#86). */
  private startedEvent: AgentStartedEvent | null = null
  /** The stop gate is on (#113). */
  private gated = false
  /** The guide's words about the gate went out already in this window. */
  private gateReminded = false
  /** Retry prompts the gate sent for the current task. */
  private gateRetries = 0
  /** The retry prompt in flight, so its own user turn does not start a new task. */
  private gateRetryText: string | null = null
  /** Moves when the session stops, so a check that outlived its session sends nothing. */
  private gateEpoch = 0
  /** What the last `supportedModels()` answered, for the palette (#190). */
  private modelList: readonly ModelInfo[] = []
  /** What the last `effortLevels()` answered, for the palette (#190). */
  private effortList: readonly AgentEffortLevel[] = []
  /** What the last `supportedCommands()` answered, for the palette (#192). */
  private commandList: readonly SlashCommand[] = []

  constructor(options: SessionManagerOptions) {
    this.options = options
    this.driver = options.driver ?? null
    this.attention = new AttentionTracker(options.now)
    options.requests?.on((event) => this.attend(event))
  }

  /** Subscribe to every session's events, this one and the next. */
  on(listener: AgentEventListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /**
   * The second stream (#67): the recorded events of a session being resumed,
   * read back from its folder. The window shows them ahead of the session's
   * own events; the recorder never hears them, since they came from the file
   * it would write them to.
   */
  onHistory(listener: SessionHistoryListener): () => void {
    this.historyListeners.add(listener)
    return () => {
      this.historyListeners.delete(listener)
    }
  }

  /**
   * The third stream (#90): the moments the user is wanted, derived from
   * every event the manager relays and every request the bridge announces.
   * Each carries the session's name, the elapsed time and the tool-call
   * count, and nothing of the conversation.
   */
  onAttention(listener: SessionAttentionListener): () => void {
    this.attentionListeners.add(listener)
    return () => {
      this.attentionListeners.delete(listener)
    }
  }

  /** The SDK's id of the current session, once it has started. */
  get sessionId(): string | null {
    return this.session?.sessionId ?? null
  }

  /**
   * The init frame of the running session, for the environment panel (#86):
   * null before the first start and again once the session stopped, so the
   * panel never shows the servers of a session that is gone.
   */
  get started(): AgentStartedEvent | null {
    return this.startedEvent
  }

  /** True while a turn is running. */
  get busy(): boolean {
    return this.session?.busy ?? false
  }

  /** The permission mode the session runs in, or the next one will (#82). */
  get permissionMode(): AgentPermissionMode {
    return this.mode
  }

  /**
   * Sets the mode for the running session and the ones after it, and says
   * so down the stream, for the mode line and the transcript (#82).
   */
  async setPermissionMode(mode: AgentPermissionMode): Promise<void> {
    this.mode = mode
    if (this.session !== null) await this.session.setPermissionMode(mode)
    this.emit({ type: 'permission-mode', mode })
  }

  /** The current session's model, or the setting's before one has started (#190). */
  get model(): string | null {
    return this.session?.model ?? this.options.model
  }

  /** The current session's effort level, null while the model's default applies (#190). */
  get effort(): AgentEffortLevel | null {
    return this.session?.effort ?? null
  }

  /** The models the last `supportedModels()` listed, for the palette to read (#190). */
  get models(): readonly ModelInfo[] {
    return this.modelList
  }

  /** The effort levels the last `effortLevels()` listed, for the palette to read (#190). */
  get efforts(): readonly AgentEffortLevel[] {
    return this.effortList
  }

  /** The slash commands the last `supportedCommands()` listed, for the palette to read (#192). */
  get commands(): readonly SlashCommand[] {
    return this.commandList
  }

  /**
   * What `/` completes in the prompt (#192): the SDK's list while a session
   * runs, the names of its init frame when the SDK does not answer, and
   * null before a session has started. It never starts one: a completion
   * is no reason to spend a session.
   */
  async supportedCommands(): Promise<readonly SlashCommand[] | null> {
    const started = this.startedEvent
    if (this.session === null || started === null) return null
    try {
      this.commandList = await this.session.supportedCommands()
    } catch {
      this.commandList = (started.slashCommands ?? []).map((name) => ({
        name,
        description: '',
        argumentHint: '',
      }))
    }
    return this.commandList
  }

  /** What the current session can switch to (#190); asks the SDK, starting a session if none runs. */
  async supportedModels(): Promise<readonly ModelInfo[]> {
    this.modelList = await (await this.current()).supportedModels()
    return this.modelList
  }

  /**
   * The effort levels the current session's model takes (#190), or every
   * level the SDK knows when it does not name the model.
   */
  async effortLevels(): Promise<readonly AgentEffortLevel[]> {
    this.effortList = (await (await this.current()).effortLevels()) ?? EFFORT_LEVELS
    return this.effortList
  }

  /**
   * Switches the current session's model (#190). The session only: the
   * `model` setting stays what new sessions start with. The mode line and
   * the transcript hear it down the stream.
   */
  async setModel(model: string): Promise<void> {
    const session = await this.current()
    await session.setModel(model)
    this.emit({ type: 'model', model: session.model, effort: session.effort })
  }

  /**
   * Sets the current session's effort level (#190); a level its model does
   * not list is refused with an AgentSessionError that says which it lists.
   */
  async setEffort(level: AgentEffortLevel): Promise<void> {
    const session = await this.current()
    await session.setEffort(level)
    this.emit({ type: 'model', model: session.model, effort: session.effort })
  }

  /**
   * The guide's plan mode as a key (#82): on, the agent reads and plans and
   * runs no tool until a plan is approved; off, back to the mode it replaced.
   * The first time it goes on in a session, the guide's callout follows as a
   * nudge: a small, clear change needs no plan.
   */
  async togglePlanMode(): Promise<AgentPermissionMode> {
    if (this.mode === 'plan') {
      await this.setPermissionMode(this.beforePlan)
      return this.mode
    }
    this.beforePlan = this.mode
    await this.setPermissionMode('plan')
    if (!this.planReminded) {
      this.planReminded = true
      this.emit({ type: 'nudge', text: PLAN_MODE_REMINDER })
    }
    return this.mode
  }

  /** A plan was approved (#82): the session goes on in the mode plan mode replaced. */
  async leavePlanMode(): Promise<void> {
    if (this.mode === 'plan') await this.setPermissionMode(this.beforePlan)
  }

  /** True while the stop gate is on (#113). */
  get stopGate(): boolean {
    return this.gated
  }

  /**
   * `toggle-stop-gate` (#113): on, every turn that ends well runs the check
   * before it ends for the user. Off by default; the guide's words follow
   * the first time it goes on. The mode line hears the state either way.
   */
  toggleStopGate(): boolean {
    if (this.options.stopGate === undefined) {
      this.emit({ type: 'notice', text: 'Stop gate: no check is wired in this window.' })
      return this.gated
    }
    this.gated = !this.gated
    this.gateRetries = 0
    this.gateRetryText = null
    this.announceGate()
    this.emit({
      type: 'notice',
      text: this.gated
        ? `Stop gate on: every turn ends with the check, up to ${count(this.gateCap(), 'retry', 'retries')}.`
        : 'Stop gate off: turns end without the check.',
    })
    if (this.gated && !this.gateReminded) {
      this.gateReminded = true
      this.emit({ type: 'nudge', text: STOP_GATE_REMINDER })
    }
    return this.gated
  }

  /**
   * Names the session (#104): one event down the stream, which the recorder
   * appends to the session's log and the window reads for the title and
   * the mode line. Given before the session started, the event waits in the
   * recorder with everything else and lands when the session is named by
   * the SDK; a second name later is another event, and the latest wins.
   */
  nameSession(name: string): void {
    this.emit({ type: 'named', name })
  }

  /** The prompt queue sends through here; a fresh session starts on demand. */
  async send(
    text: string,
    images: readonly UserImageBlock[] = [],
    priority?: UserPriority,
  ): Promise<void> {
    await (await this.current()).send(text, images, priority)
  }

  /** The guide's Esc: stop the running turn, keep the session (#84). */
  async interrupt(): Promise<boolean> {
    if (this.session === null) return false
    this.attention.interrupted()
    return this.session.interrupt()
  }

  /**
   * The guide's cure for the kitchen-sink session: the current session is
   * stopped and dropped, and the next prompt starts a fresh one, with no
   * context carried over (#84). The old session's events end with `stopped`.
   */
  async newTask(): Promise<void> {
    const old = this.session
    if (old === null) return
    const off = this.detach()
    await old.stop()
    off()
    this.emit({ type: 'notice', text: 'New task: the next prompt starts a fresh session.' })
  }

  /**
   * Picks a past session up where its folder left off (#67), as `claude
   * --resume` does: the current session, if any, is stopped and dropped, the
   * recorded history goes to the history listeners, and a session under the
   * old SDK id starts, so the next prompt continues that conversation and
   * the recorder appends to that folder. The old prompts opened no
   * checkpoints here, so rewind reaches only the turns sent from now on.
   * Resuming the current session changes nothing and says so.
   */
  async resume(sessionId: string, history: readonly AgentEvent[]): Promise<void> {
    if (this.session !== null && this.session.sessionId === sessionId) {
      this.emit({ type: 'notice', text: `Resume: ${sessionId} is already the current session.` })
      return
    }
    const old = this.session
    if (old !== null) {
      const off = this.detach()
      await old.stop()
      off()
    }
    if (this.driver === null) this.driver = await resolveDriver()
    for (const listener of [...this.historyListeners]) listener(history)
    // A resumed session keeps the name it was given, for the notifications (#90).
    for (const event of history) if (event.type === 'named') this.attention.observe(event)
    const turns = history.filter((event) => event.type === 'user-text').length
    this.emit({
      type: 'notice',
      text: `Resumed session ${sessionId}: ${turns} earlier turn${turns === 1 ? '' : 's'} shown above; the next prompt continues it.`,
    })
    const next = this.create({ resume: sessionId })
    try {
      await next.start()
    } catch (error) {
      this.emit({ type: 'error', message: describe(error) })
    }
  }

  /**
   * The guide's `/btw` (#80): the question goes to a fork of the current
   * session, which has the conversation so far but is a session of its own,
   * and the fork is stopped once it has answered. Nothing of it reaches the
   * listeners, the recorder or the window, so the history is as it was.
   * With no session yet, a fresh throwaway session answers.
   */
  async sideQuestion(text: string): Promise<string> {
    if (this.driver === null) this.driver = await resolveDriver()
    const sessionId = this.session?.sessionId ?? null
    // A side question reads; it never acts. Every tool is denied whatever the
    // session's own policy allows, so no permission request of the aside can
    // reach the request buffer, the transcript or the recorder (review of #80).
    const aside = createAgentSession({
      cwd: this.options.cwd,
      permissionHandler: denyEveryTool,
      driver: this.driver,
      ...(this.options.model === null ? {} : { model: this.options.model }),
      ...(sessionId === null ? {} : { resume: sessionId, fork: true }),
    })
    const parts: string[] = []
    aside.on((event) => {
      if (event.type === 'assistant-text') parts.push(event.text)
    })
    try {
      const turn = aside.waitForTurn()
      await aside.send(text)
      const end = await turn
      if (end.isError) throw new AgentSessionError(end.result)
      return parts.join('\n')
    } finally {
      await aside.stop()
    }
  }

  /**
   * The `correct` command (#80): the next prompt is a correction, whatever
   * its first word. Counts it now, so the nudge can come before it is typed.
   */
  markCorrection(): void {
    this.nudgeAt(this.corrections.mark())
  }

  /** Consecutive corrections so far, for a test or a mode line. */
  get correctionStreak(): number {
    return this.corrections.streak
  }

  checkpoints(): readonly Checkpoint[] {
    return this.session?.checkpoints() ?? []
  }

  lastToolCalls(): readonly ToolCall[] {
    return this.session?.lastToolCalls() ?? []
  }

  /**
   * Takes the files, the conversation or both back to `checkpoint` (#84).
   * Files go through the SDK's rewindFiles; the conversation is a resume of
   * the same session cut at the entry ahead of the checkpoint, which drops
   * the turns after it, or a fresh session when the checkpoint is the first.
   * Every outcome is a notice in the stream, so the transcript says what
   * happened and the session folder keeps it.
   */
  async rewind(checkpoint: Checkpoint, target: RewindTarget): Promise<void> {
    const session = this.holding(checkpoint)
    if (session === null) return
    if (target === 'code' || target === 'both') {
      let result: RewindFilesResult
      try {
        result = await session.rewindFiles(checkpoint)
      } catch (error) {
        result = { canRewind: false, error: describe(error) }
      }
      this.emit({ type: 'notice', text: describeRewindFiles(checkpoint, result) })
      if (!result.canRewind && target === 'both') return
    }
    if (target === 'conversation' || target === 'both') {
      await this.restoreConversation(session, checkpoint)
    }
  }

  /**
   * The SDK's dry run of a file rewind to `checkpoint` (#99): what the real
   * one would change, and nothing changed. A refusal is a notice with the
   * SDK's reason, so the flow that asked ends there and the transcript says why.
   */
  async previewRewind(checkpoint: Checkpoint): Promise<RewindFilesResult> {
    const session = this.holding(checkpoint)
    if (session === null) return { canRewind: false, error: 'not in this session' }
    let result: RewindFilesResult
    try {
      result = await session.rewindFiles(checkpoint, { dryRun: true })
    } catch (error) {
      result = { canRewind: false, error: describe(error) }
    }
    if (!result.canRewind) {
      this.emit({
        type: 'notice',
        text: `Rewind: files cannot be restored to checkpoint ${checkpoint.index}: ${result.error ?? 'the SDK refused'}.`,
      })
    }
    return result
  }

  /** The user said no to a rewind (#99): the answer is in the transcript, nothing else moves. */
  declineRewind(checkpoint: Checkpoint): void {
    this.emit({
      type: 'notice',
      text: `Rewind: checkpoint ${checkpoint.index} left as is, nothing restored.`,
    })
  }

  /** Stops the session for good: at quit. */
  async stop(): Promise<void> {
    const session = this.session
    if (session === null) return
    const off = this.detach()
    await session.stop()
    off()
  }

  /** The session the checkpoint belongs to, or null and a notice when it is not the current one. */
  private holding(checkpoint: Checkpoint): AgentSession | null {
    const session = this.session
    if (session !== null && session.checkpoints().some((c) => c.uuid === checkpoint.uuid)) {
      return session
    }
    this.emit({
      type: 'notice',
      text: `Rewind: checkpoint ${checkpoint.index} is not in this session.`,
    })
    return null
  }

  private async restoreConversation(session: AgentSession, checkpoint: Checkpoint): Promise<void> {
    const sessionId = session.sessionId
    const kept = session.checkpoints().filter((c) => c.index < checkpoint.index)
    const off = this.detach()
    await session.stop()
    off()
    const fresh = checkpoint.before === null || sessionId === null
    const next = this.create(
      fresh
        ? {}
        : { resume: sessionId, resumeAt: checkpoint.before ?? undefined, checkpoints: kept },
    )
    this.emit({
      type: 'notice',
      text: fresh
        ? `Rewind: conversation restored to before checkpoint ${checkpoint.index}; the next prompt starts a fresh session.`
        : `Rewind: conversation restored to before checkpoint ${checkpoint.index}; ${kept.length} checkpoint${kept.length === 1 ? '' : 's'} kept.`,
    })
    try {
      await next.start()
    } catch (error) {
      this.emit({ type: 'error', message: describe(error) })
    }
  }

  private async current(): Promise<AgentSession> {
    if (this.session !== null) return this.session
    if (this.driver === null) this.driver = await resolveDriver()
    return this.create({})
  }

  private create(
    extra: Pick<Parameters<typeof createAgentSession>[0], 'resume' | 'resumeAt' | 'checkpoints'>,
  ): AgentSession {
    const session = createAgentSession({
      cwd: this.options.cwd,
      permissionHandler: this.options.permissionHandler,
      ...(this.driver === null ? {} : { driver: this.driver }),
      ...(this.options.model === null ? {} : { model: this.options.model }),
      permissionMode: this.mode,
      ...(this.options.mcpServers === undefined ? {} : { mcpServers: this.options.mcpServers() }),
      ...(this.options.hooks === undefined ? {} : { hooks: this.options.hooks }),
      ...extra,
    })
    this.session = session
    this.offSession = session.on((event) => {
      this.emit(event)
      this.watch(event)
    })
    return session
  }

  /**
   * The correction counter reads the user turns as they go by (#80): a turn
   * that opens with "no" or "wrong" is a correction, any other ends the
   * streak, and a session that stops starts the count over. The nudge goes
   * down the stream after the turn it answers. The mode follows what the
   * SDK reports at start, and the plan-mode callout is owed again to the
   * next session (#82).
   */
  private watch(event: AgentEvent): void {
    if (event.type === 'user-text') {
      this.nudgeAt(this.corrections.observe(event.text))
      this.gateTask(event.text)
    } else if (event.type === 'started') {
      this.mode = event.permissionMode
      this.startedEvent = event
    } else if (event.type === 'turn-end' && this.holdsTurnEnd(event)) {
      void this.gate(event)
    } else if (event.type === 'stopped') {
      this.corrections.reset()
      this.planReminded = false
      this.startedEvent = null
      this.gateEpoch += 1
      this.gateRetryText = null
      if (this.gateRetries > 0) {
        this.gateRetries = 0
        this.announceGate()
      }
    }
  }

  /** A gated turn that ended well waits on the check; an error or an interrupt ends as it is. */
  private holdsTurnEnd(event: AgentEvent): event is AgentTurnEndEvent {
    return (
      event.type === 'turn-end' &&
      !event.isError &&
      this.gated &&
      this.options.stopGate !== undefined
    )
  }

  /** A user turn that is not the gate's own retry is a new task: its count starts over. */
  private gateTask(text: string): void {
    if (this.gateRetryText !== null && text === this.gateRetryText) {
      this.gateRetryText = null
      return
    }
    if (this.gateRetries > 0) {
      this.gateRetries = 0
      this.announceGate()
    }
  }

  /**
   * The gate on one turn end (#113): the check runs, green ends the turn,
   * red under the cap goes back as the next prompt and the turn goes on,
   * red at the cap ends it with a notice. The attention stream hears the
   * turn end only when the turn ends for the user, so a notification says
   * done once, after the check.
   */
  private async gate(turnEnd: AgentTurnEndEvent): Promise<void> {
    const gate = this.options.stopGate
    if (gate === undefined) return
    const epoch = this.gateEpoch
    let evidence: AgentEvidenceEvent | null
    try {
      evidence = await gate.verify()
    } catch (error) {
      this.emit({ type: 'notice', text: `Stop gate: ${describe(error)}; the turn ends.` })
      this.attend(turnEnd)
      return
    }
    if (epoch !== this.gateEpoch) return
    if (evidence === null) {
      this.emit({ type: 'notice', text: 'Stop gate: the check was not run; the turn ends.' })
      this.attend(turnEnd)
      return
    }
    if (checkPassed(evidence) || !this.gated) {
      this.attend(turnEnd)
      return
    }
    const cap = this.gateCap()
    if (this.gateRetries >= cap) {
      this.emit({
        type: 'notice',
        text: `Stop gate: the check still fails after ${count(cap, 'retry', 'retries')}; the turn ends.`,
      })
      this.attend(turnEnd)
      return
    }
    this.gateRetries += 1
    this.announceGate()
    const text = gatePrompt(evidence)
    this.gateRetryText = text
    try {
      await gate.submit(text)
    } catch (error) {
      this.gateRetryText = null
      this.emit({
        type: 'notice',
        text: `Stop gate: the retry could not be sent: ${describe(error)}`,
      })
      this.attend(turnEnd)
    }
  }

  private gateCap(): number {
    return this.options.stopGate?.retries() ?? 0
  }

  private announceGate(): void {
    this.emit({
      type: 'stop-gate',
      on: this.gated,
      retries: this.gateRetries,
      cap: this.gateCap(),
    })
  }

  private nudgeAt(streak: number): void {
    if (streak >= NUDGE_AFTER) this.emit({ type: 'nudge', text: nudgeText(streak) })
  }

  /**
   * Forgets the current session, so a send meanwhile starts a new one, and
   * hands back its unsubscribe: the caller stops the old session first, so
   * its `stopped` still reaches the listeners, then calls it.
   */
  private detach(): () => void {
    this.session = null
    const off = this.offSession ?? (() => {})
    this.offSession = null
    return off
  }

  private emit(event: AgentEvent): void {
    for (const listener of [...this.listeners]) listener(event)
    if (!this.holdsTurnEnd(event)) this.attend(event)
  }

  private attend(event: AgentEvent): void {
    const raised = this.attention.observe(event)
    if (raised === null) return
    for (const listener of [...this.attentionListeners]) listener(raised)
  }
}

function describeRewindFiles(checkpoint: Checkpoint, result: RewindFilesResult): string {
  if (!result.canRewind) {
    return `Rewind: files not restored to checkpoint ${checkpoint.index}: ${result.error ?? 'the SDK refused'}.`
  }
  const count = result.filesChanged?.length ?? 0
  return `Rewind: files restored to checkpoint ${checkpoint.index}, ${count} file${count === 1 ? '' : 's'} changed.`
}
