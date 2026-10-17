import type {
  CanUseTool,
  Options,
  SDKMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk'
import type {
  AgentEvent,
  AgentEventListener,
  AgentPermissionMode,
  AgentTurnEndEvent,
  PermissionDecision,
  PermissionHandler,
} from './events'

/**
 * The cockpit's engine (#58): one Claude Agent SDK query per session, running
 * in the main process, turned into the typed events of events.ts.
 *
 * Two rules shape this file. Authentication comes from the `claude` CLI login,
 * so no API key is read or passed anywhere. And every tool call goes through
 * the permission handler; the policy behind it is #55, the interface is here.
 *
 * This file is also run straight through Node's type stripping by the headless
 * harness (scripts/agent-smoke.mts), so it carries no TypeScript that needs
 * code generation: no enum, no namespace, no constructor parameter property,
 * and relative imports that survive to runtime name their `.ts` extension.
 */

/** Anything the session can talk to: the real SDK query, or the mock. */
export interface AgentQueryHandle extends AsyncIterable<SDKMessage> {
  interrupt(): Promise<unknown>
  setPermissionMode(mode: AgentPermissionMode): Promise<void>
  setModel(model?: string): Promise<void>
  close(): void
}

/** The slice of the SDK the cockpit uses. `mock.ts` is the other implementation. */
export interface AgentDriver {
  query(params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }): AgentQueryHandle
}

export interface AgentSessionOptions {
  /** The working directory the agent runs in. */
  readonly cwd: string
  readonly model?: string | undefined
  readonly permissionMode?: AgentPermissionMode | undefined
  /** Resume a session by its id instead of starting a new one. */
  readonly resume?: string | undefined
  /** Who answers a tool permission request. Denies everything when omitted. */
  readonly permissionHandler?: PermissionHandler | undefined
  /** Injected by the tests; production resolves the driver from NODE_ENV. */
  readonly driver?: AgentDriver | undefined
}

export class AgentSessionError extends Error {
  override readonly name = 'AgentSessionError'
}

/**
 * The default handler: no. A session whose owner installed no policy must not
 * run a tool because nobody said otherwise (SECURITY.org, T4).
 */
export const denyEveryTool: PermissionHandler = {
  requestPermission(request): Promise<PermissionDecision> {
    return Promise.resolve({
      behavior: 'deny',
      message: `No permission handler is installed, so ${request.toolName} was denied.`,
    })
  },
}

/** The user messages the session feeds the SDK, as an async iterable it can read. */
class MessageQueue implements AsyncIterable<SDKUserMessage> {
  private readonly pending: SDKUserMessage[] = []
  private waiting: ((message: SDKUserMessage | null) => void) | null = null
  private ended = false

  push(message: SDKUserMessage): void {
    if (this.ended) throw new AgentSessionError('The session input is closed')
    const waiting = this.waiting
    if (waiting === null) {
      this.pending.push(message)
      return
    }
    this.waiting = null
    waiting(message)
  }

  end(): void {
    if (this.ended) return
    this.ended = true
    const waiting = this.waiting
    if (waiting !== null) {
      this.waiting = null
      waiting(null)
    }
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    for (;;) {
      const next = this.pending.shift()
      if (next !== undefined) {
        yield next
        continue
      }
      if (this.ended) return
      const message = await new Promise<SDKUserMessage | null>((resolve) => {
        this.waiting = resolve
      })
      if (message === null) return
      yield message
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** Text blocks only. An image or a document in a tool result is not text. */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (isRecord(block) && block['type'] === 'text' && typeof block['text'] === 'string') {
      parts.push(block['text'])
    }
  }
  return parts.join('\n')
}

/**
 * The whole translation from the SDK's frames to the cockpit's events. Pure,
 * so the unit tests read it directly; frames the cockpit has no use for map to
 * nothing rather than to a placeholder.
 */
export function eventsFromMessage(message: SDKMessage): readonly AgentEvent[] {
  if (message.type === 'system' && message.subtype === 'init') {
    return [
      {
        type: 'started',
        sessionId: message.session_id,
        model: message.model,
        permissionMode: message.permissionMode,
        cwd: message.cwd,
        tools: message.tools,
      },
    ]
  }

  if (message.type === 'assistant') {
    const events: AgentEvent[] = []
    for (const block of message.message.content) {
      if (block.type === 'text') {
        events.push({ type: 'assistant-text', text: block.text })
      } else if (block.type === 'thinking') {
        events.push({ type: 'assistant-thinking', text: block.thinking })
      } else if (block.type === 'tool_use') {
        events.push({
          type: 'tool-use',
          toolUseId: block.id,
          name: block.name,
          input: isRecord(block.input) ? block.input : {},
        })
      }
    }
    return events
  }

  if (message.type === 'user') {
    const content = message.message.content
    if (typeof content === 'string') return []
    const events: AgentEvent[] = []
    for (const block of content) {
      if (block.type !== 'tool_result') continue
      events.push({
        type: 'tool-result',
        toolUseId: block.tool_use_id,
        isError: block.is_error === true,
        text: textOf(block.content),
      })
    }
    return events
  }

  if (message.type === 'result') {
    return [
      {
        type: 'turn-end',
        isError: message.is_error,
        result: message.subtype === 'success' ? message.result : message.errors.join('; '),
        durationMs: message.duration_ms,
        numTurns: message.num_turns,
      },
    ]
  }

  return []
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * One agent session: start it, send it messages, read its events, stop it.
 * Nothing here writes to stdout; prompts and tool output stay in the events
 * and never reach a log (SECURITY.org).
 */
export class AgentSession {
  private readonly options: AgentSessionOptions
  private readonly permissions: PermissionHandler
  private readonly listeners = new Set<AgentEventListener>()
  private readonly input = new MessageQueue()
  private driver: AgentDriver | null
  private handle: AgentQueryHandle | null = null
  private reader: Promise<void> | null = null
  private sessionIdValue: string | null
  private modelValue: string | null
  private permissionModeValue: AgentPermissionMode
  private interrupted = false

  constructor(options: AgentSessionOptions) {
    this.options = options
    this.permissions = options.permissionHandler ?? denyEveryTool
    this.driver = options.driver ?? null
    this.sessionIdValue = options.resume ?? null
    this.modelValue = options.model ?? null
    this.permissionModeValue = options.permissionMode ?? 'default'
  }

  /** The SDK's id for this session, known once it has started. Resume takes it. */
  get sessionId(): string | null {
    return this.sessionIdValue
  }

  /** The model the SDK reported, or the one that was asked for before it answered. */
  get model(): string | null {
    return this.modelValue
  }

  get permissionMode(): AgentPermissionMode {
    return this.permissionModeValue
  }

  get running(): boolean {
    return this.handle !== null
  }

  /** Subscribe to the event stream. The returned function unsubscribes. */
  on(listener: AgentEventListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** Resolves with the next turn-end event. The harness and the specs wait on it. */
  waitForTurn(): Promise<AgentTurnEndEvent> {
    return new Promise((resolve, reject) => {
      const off = this.on((event) => {
        if (event.type === 'turn-end') {
          off()
          resolve(event)
        } else if (event.type === 'error') {
          off()
          reject(new AgentSessionError(event.message))
        } else if (event.type === 'stopped') {
          off()
          reject(new AgentSessionError('The session stopped before the turn ended'))
        }
      })
    })
  }

  async start(): Promise<void> {
    if (this.handle !== null) throw new AgentSessionError('The session is already started')
    const driver = this.driver ?? (await resolveDriver())
    this.driver = driver
    const handle = driver.query({ prompt: this.input, options: this.sdkOptions() })
    this.handle = handle
    this.reader = this.read(handle)
  }

  /** Queue a message for the agent. Starts the session when it is not running yet. */
  async send(text: string): Promise<void> {
    if (this.handle === null) await this.start()
    // The query is already bound to its session, so the frame carries no id.
    this.input.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
    })
  }

  async setPermissionMode(mode: AgentPermissionMode): Promise<void> {
    this.permissionModeValue = mode
    if (this.handle !== null) await this.handle.setPermissionMode(mode)
  }

  async setModel(model: string): Promise<void> {
    this.modelValue = model
    if (this.handle !== null) await this.handle.setModel(model)
  }

  /** Interrupt the agent and close the stream. Safe to call twice. */
  async stop(): Promise<void> {
    const handle = this.handle
    if (handle === null) return
    this.interrupted = true
    try {
      await handle.interrupt()
    } catch {
      // A query that already ended cannot be interrupted, and that is fine.
    }
    this.input.end()
    handle.close()
    await this.reader
    this.handle = null
    this.reader = null
  }

  private sdkOptions(): Options {
    return {
      cwd: this.options.cwd,
      permissionMode: this.permissionModeValue,
      canUseTool: this.canUseTool,
      ...(this.options.model === undefined ? {} : { model: this.options.model }),
      ...(this.options.resume === undefined ? {} : { resume: this.options.resume }),
    }
  }

  /** The SDK asks here before every tool call. The handler owns the answer. */
  private readonly canUseTool: CanUseTool = async (toolName, input, options) => {
    const decision = await this.permissions.requestPermission({
      toolName,
      toolUseId: options.toolUseID,
      input,
      signal: options.signal,
      ...(options.title === undefined ? {} : { title: options.title }),
    })
    if (decision.behavior === 'allow') {
      return {
        behavior: 'allow',
        ...(decision.updatedInput === undefined ? {} : { updatedInput: decision.updatedInput }),
      }
    }
    return { behavior: 'deny', message: decision.message }
  }

  private async read(handle: AgentQueryHandle): Promise<void> {
    try {
      for await (const message of handle) {
        for (const event of eventsFromMessage(message)) {
          if (event.type === 'started') {
            this.sessionIdValue = event.sessionId
            this.modelValue = event.model
            this.permissionModeValue = event.permissionMode
          }
          this.emit(event)
        }
      }
    } catch (error) {
      this.emit({ type: 'error', message: describe(error) })
    } finally {
      this.emit({ type: 'stopped', reason: this.interrupted ? 'interrupted' : 'ended' })
    }
  }

  private emit(event: AgentEvent): void {
    for (const listener of [...this.listeners]) listener(event)
  }
}

export function createAgentSession(options: AgentSessionOptions): AgentSession {
  return new AgentSession(options)
}

/**
 * The mock is honored only under test. Everywhere else the real SDK is loaded,
 * lazily, so neither the mock nor the SDK is pulled in until a session starts.
 */
export async function resolveDriver(): Promise<AgentDriver> {
  if (process.env['NODE_ENV'] === 'test') {
    const { mockDriver } = await import('./mock.ts')
    return mockDriver()
  }
  const { query } = await import('@anthropic-ai/claude-agent-sdk')
  return { query: (params) => query(params) }
}
