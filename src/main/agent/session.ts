import type {
  CanUseTool,
  ModelUsage,
  Options,
  RewindFilesResult,
  SDKAssistantMessage,
  SDKMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
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

/** The SDK's options to `rewindFiles`: `dryRun` previews without restoring (#99). */
export interface RewindFilesOptions {
  readonly dryRun?: boolean
}

/**
 * An image content block of a user message, as the SDK's own type spells it
 * (#83): what `attach-image` sends next to the text of the same message.
 */
export type UserImageBlock = Extract<
  Exclude<SDKUserMessage['message']['content'], string>[number],
  { type: 'image' }
>

/** Anything the session can talk to: the real SDK query, or the mock. */
export interface AgentQueryHandle extends AsyncIterable<SDKMessage> {
  interrupt(): Promise<unknown>
  setPermissionMode(mode: AgentPermissionMode): Promise<void>
  setModel(model?: string): Promise<void>
  /**
   * Restores the files the agent touched since the user message named (#84);
   * a dry run reports what would change and touches nothing (#99).
   */
  rewindFiles(userMessageId: string, options?: RewindFilesOptions): Promise<RewindFilesResult>
  close(): void
}

/**
 * One checkpoint per user turn (#84): the point the rewind buffer lists and
 * the SDK can take the files or the conversation back to. `uuid` is the id
 * the user message was sent under, which `rewindFiles` takes; `before` is
 * the SDK's uuid for the last assistant message ahead of it, which a resume
 * at that point takes, or null when nothing came before.
 */
export interface Checkpoint {
  /** 1 for the first prompt of the session. */
  readonly index: number
  readonly uuid: string
  readonly before: string | null
  /** The prompt, as the user sent it. */
  readonly text: string
  /** When the prompt was sent, in ms since the epoch. */
  readonly at: number
}

/** A tool call the assistant made, as the undo prompt quotes it (#84). */
export interface ToolCall {
  readonly name: string
  readonly input: Record<string, unknown>
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
  /** With `resume`: keep the conversation up to this chain entry only (#84). */
  readonly resumeAt?: string | undefined
  /** With `resume`: the checkpoints the kept conversation still has (#84). */
  readonly checkpoints?: readonly Checkpoint[] | undefined
  /**
   * With `resume`: a copy of that session under a new id, so what is said
   * here never reaches the original (#80). A side question runs this way.
   */
  readonly fork?: true | undefined
  /** Who answers a tool permission request. Denies everything when omitted. */
  readonly permissionHandler?: PermissionHandler | undefined
  /**
   * In-process MCP servers (#28): the cockpit's own catalog, so the agent
   * inside sees the tools an outside client does. Their calls still pass
   * `canUseTool`, so the permission bridge asks as for any tool.
   */
  readonly mcpServers?: Options['mcpServers'] | undefined
  /**
   * The SDK hooks the session starts with: the page boundary's `PreToolUse`
   * (#55), which answers before `canUseTool` is asked and never instead of it.
   */
  readonly hooks?: Options['hooks'] | undefined
  /** Injected by the tests; production resolves the driver from NODE_ENV. */
  readonly driver?: AgentDriver | undefined
}

export class AgentSessionError extends Error {
  override readonly name = 'AgentSessionError'
}

/**
 * The guide's `/compact <instructions>`, typed in the prompt buffer and sent
 * by `C-c C-k` (#80). The CLI under the SDK runs it as the local command it
 * is; the session opens no checkpoint for it, since it is not a prompt.
 */
const COMPACT_COMMAND = /^\s*\/compact(\s|$)/

export function isCompactCommand(text: string): boolean {
  return COMPACT_COMMAND.test(text)
}

/** The text that compacts with `instruction`, or without one when it is blank. */
export function compactCommand(instruction: string): string {
  const trimmed = instruction.trim()
  return trimmed.length === 0 ? '/compact' : `/compact ${trimmed}`
}

/**
 * What the last request carried into the model (#80): the input tokens plus
 * what was read from and written to the cache, which together are the
 * conversation as the model saw it. The output tokens are not in the window
 * yet; the next request will carry them as input.
 */
export function usedTokensOf(message: SDKAssistantMessage): number {
  const usage = message.message.usage
  return (
    usage.input_tokens +
    (usage.cache_read_input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0)
  )
}

/**
 * The window of the main model, from the per-model totals a result carries
 * (#80): the entry under the session's model name, or failing that the one
 * that carried the most tokens, since subagents and helpers run under other
 * names. Null until a result has said.
 */
export function contextWindowOf(
  modelUsage: Readonly<Record<string, ModelUsage>>,
  model: string | null,
): number | null {
  const own = model === null ? undefined : modelUsage[model]
  if (own !== undefined && own.contextWindow > 0) return own.contextWindow
  let best: ModelUsage | null = null
  for (const usage of Object.values(modelUsage)) {
    if (usage.contextWindow <= 0) continue
    if (best === null || tokensOf(usage) > tokensOf(best)) best = usage
  }
  return best?.contextWindow ?? null
}

function tokensOf(usage: ModelUsage): number {
  return usage.inputTokens + usage.cacheReadInputTokens + usage.cacheCreationInputTokens
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
        // What the session can reach, for the environment panel (#86). The
        // names are the frame's own, data to show and never to run.
        claudeCodeVersion: message.claude_code_version,
        mcpServers: message.mcp_servers.map(({ name, status }) => ({ name, status })),
        skills: [...message.skills],
        ...(message.agents === undefined ? {} : { agents: [...message.agents] }),
        slashCommands: [...message.slash_commands],
        plugins: message.plugins.map(({ name, version }) => ({
          name,
          ...(version === undefined ? {} : { version }),
        })),
      },
    ]
  }

  // A frame produced inside a subagent names the main-thread tool call that
  // started it; the events carry that id, so the transcript can nest them (#85).
  const child =
    message.type === 'assistant' || message.type === 'user'
      ? parentOf(message.parent_tool_use_id)
      : {}

  if (message.type === 'assistant') {
    const events: AgentEvent[] = []
    for (const block of message.message.content) {
      if (block.type === 'text') {
        events.push({ type: 'assistant-text', text: block.text, ...child })
      } else if (block.type === 'thinking') {
        events.push({ type: 'assistant-thinking', text: block.thinking, ...child })
      } else if (block.type === 'tool_use') {
        events.push({
          type: 'tool-use',
          toolUseId: block.id,
          name: block.name,
          input: isRecord(block.input) ? block.input : {},
          ...child,
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
        ...child,
      })
    }
    return events
  }

  if (message.type === 'system' && message.subtype === 'compact_boundary') {
    const { trigger, pre_tokens, post_tokens } = message.compact_metadata
    const after = post_tokens === undefined ? '' : `, ${post_tokens} after`
    return [
      {
        type: 'notice',
        text: `Compacted the conversation (${trigger}): ${pre_tokens} tokens before${after}.`,
      },
    ]
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

function parentOf(id: string | null): { readonly parentToolUseId?: string } {
  return id === null ? {} : { parentToolUseId: id }
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
  private inTurn = false
  private readonly checkpointList: Checkpoint[]
  /** The SDK's uuid of the last assistant message seen: the chain entry a resume keeps up to. */
  private lastEntry: string | null
  private readonly toolCalls: ToolCall[] = []
  /** The last request's tokens and the model's window, for the meter (#80). */
  private usedTokens: number | null = null
  private windowTokens: number | null = null

  constructor(options: AgentSessionOptions) {
    this.options = options
    this.permissions = options.permissionHandler ?? denyEveryTool
    this.driver = options.driver ?? null
    this.sessionIdValue = options.resume ?? null
    this.modelValue = options.model ?? null
    this.permissionModeValue = options.permissionMode ?? 'default'
    this.checkpointList = [...(options.checkpoints ?? [])]
    this.lastEntry = options.resumeAt ?? null
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

  /** True from a send until the turn it started ends. */
  get busy(): boolean {
    return this.inTurn
  }

  /** The checkpoints so far, oldest first: one per prompt sent (#84). */
  checkpoints(): readonly Checkpoint[] {
    return [...this.checkpointList]
  }

  /** The tool calls of the latest turn, in order; what `undo` quotes (#84). */
  lastToolCalls(): readonly ToolCall[] {
    return [...this.toolCalls]
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

  /**
   * Queue a message for the agent. Starts the session when it is not running
   * yet. Images (#83) go out as content blocks next to the text in the same
   * message; the events, the checkpoint and the transcript carry the text
   * alone, whose marker lines stand for them.
   */
  async send(text: string, images: readonly UserImageBlock[] = []): Promise<void> {
    if (this.handle === null) await this.start()
    // The user's turn joins the stream before anything the agent answers to
    // it, so a listener reads the conversation in order (#62).
    this.emit({ type: 'user-text', text })
    // The message goes out under a uuid of ours, so the checkpoint it opens
    // can be named back to the SDK (#84). The query is already bound to its
    // session, so the frame carries no session id.
    const uuid = randomUUID()
    // A compaction is a command to the CLI, not a prompt: no checkpoint (#80).
    if (!isCompactCommand(text)) {
      this.checkpointList.push({
        index: this.checkpointList.length + 1,
        uuid,
        before: this.lastEntry,
        text,
        at: Date.now(),
      })
    }
    this.toolCalls.length = 0
    this.inTurn = true
    this.input.push({
      type: 'user',
      message: {
        role: 'user',
        content: images.length === 0 ? text : [{ type: 'text', text }, ...images],
      },
      parent_tool_use_id: null,
      uuid,
    })
  }

  /**
   * Stops the running turn and keeps the session, as Esc does in the CLI
   * (#84): the context stays, the next prompt continues it. Resolves to
   * false when no turn was running.
   */
  async interrupt(): Promise<boolean> {
    const handle = this.handle
    if (handle === null || !this.inTurn) return false
    await handle.interrupt()
    return true
  }

  /**
   * Restores the files the agent touched since the checkpoint (#84), or with
   * `dryRun` reports which would change and restores nothing (#99).
   */
  async rewindFiles(
    checkpoint: Checkpoint,
    options: RewindFilesOptions = {},
  ): Promise<RewindFilesResult> {
    if (this.handle === null) await this.start()
    const handle = this.handle
    if (handle === null) throw new AgentSessionError('The session did not start')
    return handle.rewindFiles(checkpoint.uuid, options)
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
      // Files are snapshotted before an edit, so a checkpoint can restore them (#84).
      enableFileCheckpointing: true,
      ...(this.options.model === undefined ? {} : { model: this.options.model }),
      ...(this.options.mcpServers === undefined ? {} : { mcpServers: this.options.mcpServers }),
      ...(this.options.hooks === undefined ? {} : { hooks: this.options.hooks }),
      ...(this.options.resume === undefined ? {} : { resume: this.options.resume }),
      ...(this.options.resumeAt === undefined ? {} : { resumeSessionAt: this.options.resumeAt }),
      ...(this.options.fork === true && this.options.resume !== undefined
        ? { forkSession: true }
        : {}),
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
        if (message.type === 'assistant' && message.parent_tool_use_id === null) {
          this.lastEntry = message.uuid
          this.usedTokens = usedTokensOf(message)
        }
        if (message.type === 'result') {
          this.windowTokens = contextWindowOf(message.modelUsage, this.modelValue)
        }
        if (message.type === 'system' && message.subtype === 'compact_boundary') {
          const after = message.compact_metadata.post_tokens
          if (after !== undefined) this.usedTokens = after
        }
        for (const event of eventsFromMessage(message)) {
          if (event.type === 'started') {
            this.sessionIdValue = event.sessionId
            this.modelValue = event.model
            this.permissionModeValue = event.permissionMode
          } else if (event.type === 'tool-use') {
            this.toolCalls.push({ name: event.name, input: event.input })
          } else if (event.type === 'turn-end') {
            this.inTurn = false
          }
          this.emit(event)
        }
        // The meter is told once a turn, after the result that carries the
        // window: the last request's tokens against it (#80).
        if (message.type === 'result' && this.usedTokens !== null && this.windowTokens !== null) {
          this.emit({
            type: 'context-usage',
            usedTokens: this.usedTokens,
            windowTokens: this.windowTokens,
          })
        }
      }
    } catch (error) {
      this.emit({ type: 'error', message: describe(error) })
    } finally {
      this.inTurn = false
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
  const executable = unpackedClaudeExecutable()
  if (executable === undefined) return { query: (params) => query(params) }
  return {
    query: (params) =>
      query({ ...params, options: { ...params.options, pathToClaudeCodeExecutable: executable } }),
  }
}

/**
 * In the packaged app the SDK resolves its CLI binary to a path inside
 * app.asar, which cannot be executed. electron-builder.yml unpacks it next to
 * the asar (#35), so point the SDK there. In development and in the headless
 * harness the unpacked copy does not exist and the SDK's own lookup is used.
 */
export function unpackedClaudeExecutable(
  resourcesPath: string | undefined = process.resourcesPath,
): string | undefined {
  if (resourcesPath === undefined) return undefined
  const binary = process.platform === 'win32' ? 'claude.exe' : 'claude'
  const path = join(
    resourcesPath,
    'app.asar.unpacked',
    'node_modules',
    '@anthropic-ai',
    `claude-agent-sdk-${process.platform}-${process.arch}`,
    binary,
  )
  return existsSync(path) ? path : undefined
}
