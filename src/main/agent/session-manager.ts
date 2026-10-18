import type { RewindFilesResult } from '@anthropic-ai/claude-agent-sdk'
import type { AgentEvent, AgentEventListener, PermissionHandler } from './events'
import type { AgentDriver, AgentSession, Checkpoint, ToolCall } from './session'
import { createAgentSession, resolveDriver } from './session'

/**
 * The session manager (#84): the one place that holds the cockpit's current
 * agent session and can replace it. The guide's course corrections are its
 * methods: `interrupt` stops the running turn and keeps the context, `newTask`
 * drops the session for a fresh one in the same window, `rewind` takes the
 * files or the conversation back to a checkpoint through what the SDK
 * exposes, and `lastToolCalls` feeds the undo prompt. `resume` (#67) picks
 * a past session up by the SDK's id, with its recorded history shown first.
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
  /** Injected by the tests; production resolves the driver from NODE_ENV. */
  readonly driver?: AgentDriver | undefined
}

/** What a rewind restores. `summarize` is not among them: the SDK exposes no such call. */
export type RewindTarget = 'conversation' | 'code' | 'both'

/** Hears the recorded events of a session being resumed, oldest first (#67). */
export type SessionHistoryListener = (history: readonly AgentEvent[]) => void

export const REWIND_TARGETS: readonly RewindTarget[] = ['conversation', 'code', 'both']

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
  private driver: AgentDriver | null
  private session: AgentSession | null = null
  private offSession: (() => void) | null = null

  constructor(options: SessionManagerOptions) {
    this.options = options
    this.driver = options.driver ?? null
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

  /** The SDK's id of the current session, once it has started. */
  get sessionId(): string | null {
    return this.session?.sessionId ?? null
  }

  /** True while a turn is running. */
  get busy(): boolean {
    return this.session?.busy ?? false
  }

  /** The prompt queue sends through here; a fresh session starts on demand. */
  async send(text: string): Promise<void> {
    await (await this.current()).send(text)
  }

  /** The guide's Esc: stop the running turn, keep the session (#84). */
  async interrupt(): Promise<boolean> {
    if (this.session === null) return false
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
    const session = this.session
    if (session === null || !session.checkpoints().some((c) => c.uuid === checkpoint.uuid)) {
      this.emit({
        type: 'notice',
        text: `Rewind: checkpoint ${checkpoint.index} is not in this session.`,
      })
      return
    }
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

  /** Stops the session for good: at quit. */
  async stop(): Promise<void> {
    const session = this.session
    if (session === null) return
    const off = this.detach()
    await session.stop()
    off()
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
      ...extra,
    })
    this.session = session
    this.offSession = session.on((event) => this.emit(event))
    return session
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
  }
}

function describeRewindFiles(checkpoint: Checkpoint, result: RewindFilesResult): string {
  if (!result.canRewind) {
    return `Rewind: files not restored to checkpoint ${checkpoint.index}: ${result.error ?? 'the SDK refused'}.`
  }
  const count = result.filesChanged?.length ?? 0
  return `Rewind: files restored to checkpoint ${checkpoint.index}, ${count} file${count === 1 ? '' : 's'} changed.`
}
