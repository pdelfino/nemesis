import type { AgentState, AgentsContent } from '../shared/agents'
import type { BufferInfo } from '../shared/buffers'
import { formatCost } from '../shared/context'
import type { SessionAttentionEvent } from '../shared/notify'
import { sessionLabel } from './agent/attention'
import type { AgentEvent } from './agent/events'
import type { BufferRegistry } from './buffers'
import { CommandError } from './commands/registry'
import { formatElapsed } from './notify/text'

/**
 * Every session on one screen (#157). Each window runs one session (#70);
 * `AgentStatus` follows one session's state off its events and the
 * attention stream (#90), and `AgentsBuffers` shows every window's in one
 * read-only `agents` buffer, refreshed on every change while it is open.
 *
 * Only counts and times are kept, never the text of an event, so the buffer
 * carries nothing of any transcript: a window's name, the session's name,
 * its folder, its state, the elapsed time, the tool calls and the cost (#191).
 */

/** One session's state as the `agents` buffer reads it. */
export interface AgentSnapshot {
  readonly session: string
  readonly state: AgentState
  /** When the running turn started; null between turns. */
  readonly turnStartedAt: number | null
  /** How long the last turn took, once one ended; null before. */
  readonly lastTurnMs: number | null
  /** Tool calls in the running turn, or in the last one between turns. */
  readonly toolCalls: number
  /** The session's cost so far, the SDK's estimate (#191); null before the first result. */
  readonly costUsd: number | null
}

export type AgentStatusListener = () => void

/**
 * One session's state, from its events and its attention stream. A turn
 * that ends without a `session-finished` or `session-error` after it was one
 * the user interrupted (the attention stream raises nothing for those), so
 * it reads `idle`, as a turn the user stopped is not news.
 */
export class AgentStatus {
  private readonly now: () => number
  private readonly listeners = new Set<AgentStatusListener>()
  private readonly open = new Set<string>()
  private name: string | null = null
  private sessionId: string | null = null
  private state: AgentState = 'idle'
  private turnStartedAt: number | null = null
  private lastTurnMs: number | null = null
  private toolCalls = 0
  private costUsd: number | null = null

  constructor(now: () => number = Date.now) {
    this.now = now
  }

  onChange(listener: AgentStatusListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  get snapshot(): AgentSnapshot {
    return {
      session: sessionLabel(this.name, this.sessionId),
      state: this.state,
      turnStartedAt: this.turnStartedAt,
      lastTurnMs: this.lastTurnMs,
      toolCalls: this.toolCalls,
      costUsd: this.costUsd,
    }
  }

  /** An event of the session manager or of the permission bridge. */
  observe(event: AgentEvent): void {
    switch (event.type) {
      case 'named':
        this.name = event.name
        break
      case 'started':
        this.sessionId = event.sessionId
        break
      case 'user-text':
        if (this.turnStartedAt === null) {
          this.turnStartedAt = this.now()
          this.toolCalls = 0
        }
        if (this.open.size === 0) this.state = 'working'
        break
      case 'tool-use':
        this.toolCalls += 1
        break
      case 'permission-request':
        this.open.add(event.requestId)
        this.state = 'waits on you'
        break
      case 'permission-answered':
        this.open.delete(event.requestId)
        if (this.open.size === 0 && this.state === 'waits on you') {
          this.state = this.turnStartedAt === null ? 'idle' : 'working'
        }
        break
      case 'turn-end':
        this.endTurn()
        if (event.costUsd !== undefined) this.costUsd = event.costUsd
        if (this.open.size === 0) this.state = 'idle'
        break
      case 'error':
        this.endTurn()
        this.state = 'error'
        break
      case 'stopped':
        this.endTurn()
        this.open.clear()
        this.sessionId = null
        this.costUsd = null
        this.state = 'idle'
        break
      default:
        return
    }
    this.changed()
  }

  /** The attention stream: it alone tells a finished turn from an interrupted one. */
  attend(event: SessionAttentionEvent): void {
    if (event.type === 'session-finished') this.state = 'finished'
    else if (event.type === 'session-error') this.state = 'error'
    else return
    this.changed()
  }

  private endTurn(): void {
    if (this.turnStartedAt !== null) {
      this.lastTurnMs = Math.max(0, this.now() - this.turnStartedAt)
    }
    this.turnStartedAt = null
  }

  private changed(): void {
    for (const listener of [...this.listeners]) listener()
  }
}

/** One window's session, as the `agents` buffer lists it. */
export interface AgentLine extends AgentSnapshot {
  readonly windowId: number
  readonly windowName: string
  /** The folder the session runs in (#87). */
  readonly cwd: string
  /**
   * The buffer `open-agent` makes current: the window's pending request when
   * there is one, as a notification's click does (#90), else its prompt buffer.
   */
  readonly targetBufferId: string | null
  /** The window was opened hidden by `new-background-session` and not shown since (#158). */
  readonly background: boolean
  /** The fan-out run the session belongs to, by its label (#160); null for any other session. */
  readonly run: string | null
}

/** Every window's session, and a word when any of them changes. */
export interface AgentsSource {
  list(): readonly AgentLine[]
  onChange(listener: () => void): () => void
}

export const AGENTS_TITLE = 'Agents'
export const AGENTS_ELEMENT_ID = 'agents'

/** The detail after the state: the running turn's time, else the last turn's, and the tool calls. */
function detail(line: AgentSnapshot, now: number): string {
  const calls = `${line.toolCalls} tool call${line.toolCalls === 1 ? '' : 's'}`
  if (line.turnStartedAt !== null) return `for ${formatElapsed(now - line.turnStartedAt)}, ${calls}`
  if ((line.state === 'finished' || line.state === 'error') && line.lastTurnMs !== null) {
    return `after ${formatElapsed(line.lastTurnMs)}, ${calls}`
  }
  return ''
}

/** A folder under the home, written from `~`. */
function shortFolder(cwd: string, home: string): string {
  if (home.length > 0 && (cwd === home || cwd.startsWith(`${home}/`))) {
    return `~${cwd.slice(home.length)}`
  }
  return cwd
}

/**
 * The buffer's text: a header with the counts, then one line per session in
 * window order, `here` marking the window the buffer is shown in, and the
 * folder under it.
 */
export function renderAgents(
  lines: readonly AgentLine[],
  options: { readonly here: number; readonly home: string; readonly now: number },
): string {
  const waiting = lines.filter((line) => line.state === 'waits on you').length
  const working = lines.filter((line) => line.state === 'working').length
  const counts = [
    `${lines.length} session${lines.length === 1 ? '' : 's'}`,
    ...(working > 0 ? [`${working} working`] : []),
    ...(waiting > 0 ? [`${waiting} waits on you`] : []),
  ]
  const header = `Agents: ${counts.join(', ')}`
  if (lines.length === 0) return `${header}\n`
  const windows = lines.map((line) =>
    line.windowId === options.here
      ? `${line.windowName} (here)`
      : line.background
        ? `${line.windowName} (background)`
        : line.windowName,
  )
  const windowWidth = Math.max(...windows.map((name) => name.length))
  const sessionWidth = Math.max(...lines.map((line) => line.session.length))
  const row = (line: AgentLine, index: number): string => {
    const cost = line.costUsd === null ? '' : formatCost(line.costUsd)
    const state = [line.state, detail(line, options.now), cost]
      .filter((part) => part !== '')
      .join(', ')
    const first = `${(windows[index] ?? '').padEnd(windowWidth)}  ${line.session.padEnd(sessionWidth)}  ${state}`
    return `${first}\n${' '.repeat(windowWidth + 2)}${shortFolder(line.cwd, options.home)}`
  }
  // The sessions of no run first, then each fan-out run under its heading (#160).
  const rows = lines.flatMap((line, index) => (line.run === null ? [row(line, index)] : []))
  const runs = [...new Set(lines.flatMap((line) => (line.run === null ? [] : [line.run])))]
  for (const run of runs) {
    const members = lines.filter((line) => line.run === run)
    const count = (state: AgentState): number =>
      members.filter((line) => line.state === state).length
    rows.push(
      `\nFan-out "${run}": ${members.length} session${members.length === 1 ? '' : 's'}, ${count('finished')} finished, ${count('waits on you')} waiting, ${count('error')} failed`,
    )
    lines.forEach((line, index) => {
      if (line.run === run) rows.push(row(line, index))
    })
  }
  return `${header}\n\n${rows.join('\n')}\n`
}

export type AgentsShownListener = (content: AgentsContent) => void

export interface AgentsBuffersOptions {
  readonly source: AgentsSource
  /** The id of the window this buffer lives in. */
  readonly here: number
  readonly home: string
  /** Makes a window current with one of its buffers: `open-agent`'s act. */
  readonly switchTo: (windowId: number, bufferId: string) => void
  readonly now?: () => number
  /** How often an open buffer redraws a running turn's elapsed time, in ms; 0 never. */
  readonly tickMs?: number
}

/**
 * The `agents` buffer of one window (#157): shown by `agents`, redrawn on
 * every change of any session while it is open, and every second while a
 * turn runs, so the elapsed time moves. `RET` is `open-agent`, a palette
 * over the same lines, since the renderer keeps the point to itself.
 */
export class AgentsBuffers {
  private readonly buffers: BufferRegistry
  private readonly options: AgentsBuffersOptions
  private readonly listeners = new Set<AgentsShownListener>()
  private bufferId: string | null = null
  private pending = false
  private ticker: ReturnType<typeof setInterval> | null = null
  private readonly offSource: () => void

  constructor(buffers: BufferRegistry, options: AgentsBuffersOptions) {
    this.buffers = buffers
    this.options = options
    buffers.subscribe((list) => {
      if (this.bufferId !== null && !list.buffers.some((buffer) => buffer.id === this.bufferId)) {
        this.bufferId = null
        this.stopTicker()
      }
    })
    this.offSource = options.source.onChange(() => this.schedule())
  }

  /** The bridge subscribes and pushes the text to the window. */
  onShown(listener: AgentsShownListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** The `agents` buffer, when one is open. */
  get buffer(): BufferInfo | null {
    return this.bufferId === null ? null : (this.buffers.get(this.bufferId) ?? null)
  }

  /** The id of the window this buffer lives in. */
  get here(): number {
    return this.options.here
  }

  /** Every window's session, in window order. */
  lines(): readonly AgentLine[] {
    return this.options.source.list()
  }

  /** The rendered list as it stands now. */
  text(): string {
    return renderAgents(this.lines(), {
      here: this.options.here,
      home: this.options.home,
      now: (this.options.now ?? Date.now)(),
    })
  }

  /** Shows the list in its buffer and gives it the point. */
  show(): BufferInfo {
    const buffer =
      this.buffer ??
      this.buffers.create({ kind: 'agents', title: AGENTS_TITLE, elementId: AGENTS_ELEMENT_ID })
    this.bufferId = buffer.id
    // The window gets the text before the point moves to it.
    this.push()
    this.buffers.switchTo(buffer.id)
    this.startTicker()
    return buffer
  }

  /** `open-agent`: the window of `windowId` forward, on its pending request or its prompt buffer. */
  open(windowId: number): void {
    const line = this.lines().find((one) => one.windowId === windowId)
    if (line === undefined) throw new CommandError('That window is closed')
    if (line.targetBufferId === null) throw new CommandError('That window has no buffer to open')
    this.options.switchTo(line.windowId, line.targetBufferId)
  }

  /** Stops the ticker and the subscription: the window is going away. */
  dispose(): void {
    this.stopTicker()
    this.offSource()
  }

  /** One redraw for every burst of changes: a turn's end and its attention come together. */
  private schedule(): void {
    if (this.bufferId === null || this.pending) return
    this.pending = true
    queueMicrotask(() => {
      this.pending = false
      this.push()
    })
  }

  private push(): void {
    const bufferId = this.bufferId
    if (bufferId === null) return
    const text = this.text()
    for (const listener of [...this.listeners]) listener({ bufferId, text })
  }

  private startTicker(): void {
    const every = this.options.tickMs ?? 1000
    if (every <= 0 || this.ticker !== null) return
    this.ticker = setInterval(() => {
      if (this.lines().some((line) => line.turnStartedAt !== null)) this.push()
    }, every)
    this.ticker.unref?.()
  }

  private stopTicker(): void {
    if (this.ticker !== null) clearInterval(this.ticker)
    this.ticker = null
  }
}
