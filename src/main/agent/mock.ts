import type {
  ModelUsage,
  NonNullableUsage,
  Options,
  PermissionResult,
  RewindFilesResult,
  SDKAssistantMessage,
  SDKCompactBoundaryMessage,
  SDKMessage,
  SDKResultError,
  SDKResultMessage,
  SDKSystemMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk'
import type { UUID } from 'node:crypto'
import { join } from 'node:path'
import type { AgentDriver, AgentQueryHandle, RewindFilesOptions } from './session'

/**
 * A deterministic stand-in for the Agent SDK (#58), honored only when
 * NODE_ENV is `test`. Every end-to-end spec runs against it, so the cockpit
 * can be driven without a network, an account or a wall clock.
 *
 * It answers a tiny prompt language, so a spec asks for the frames it needs:
 *
 *   `think: ...`  a thinking block, then the reply
 *   `tool: Name`  a tool call named `Name` through `canUseTool`, then the reply
 *   `edit: ...`   an Edit call on /mock/notes.txt through `canUseTool`, the
 *                 line `beta` replaced by the text, then the reply (#68)
 *   `check: ...`  a Bash call of `npm test -- <text>` through `canUseTool`,
 *                 its result a test runner's summary, so the transcript has
 *                 a tool result that reads as evidence (#81)
 *   `ask: ...`    an AskUserQuestion with three options through `canUseTool`,
 *                 then `You chose: <answer>` (#63)
 *   `plan: ...`   an ExitPlanMode call through `canUseTool` with a two-step
 *                 plan for the text as its `plan`, as the CLI injects the
 *                 plan file's content; allowed, the reply quotes the plan
 *                 as approved, the edited one when `updatedInput` carried
 *                 it, and denied, the reply quotes the feedback (#82)
 *   `I want to build X. Interview me in detail using the AskUserQuestion
 *   tool.` the guide's interview prompt (#85): one AskUserQuestion about X
 *                 through `canUseTool`, then a Write of SPEC.md in the cwd
 *                 through `canUseTool`, with the answer in the spec, then
 *                 `Spec written to SPEC.md.`
 *   `Use subagents to investigate X` the guide's investigation prompt (#85):
 *                 an Agent call on the main thread, then a Read, its result
 *                 and a text inside the subagent, every frame of it with
 *                 `parent_tool_use_id` set, then the summary as the Agent
 *                 result and `Investigated: X`
 *   `stream: ...` text frames `... 1`, `... 2`, one every few ms, until the
 *                 turn is interrupted; the turn then ends as the CLI ends an
 *                 interrupted one, with an error result (#84)
 *   `usage: N`    the reply, with N tokens in the context from here on (#80)
 *   `/compact ...` a compact boundary, then a result, the context back to
 *                 the size of a fresh session, as the CLI does (#80)
 *   anything else the reply `You said: <prompt>`
 *
 * Every reply carries usage the way the API reports it: the input tokens of
 * the request, which grow by TURN_TOKENS a turn, and every result the
 * per-model totals with the window, so the meter has numbers to show (#80).
 * A query that resumes with `forkSession` gets a fresh id, as the CLI gives
 * a fork, so a side question never writes under the session it copied.
 *
 * The frames are the SDK's own types, not a loose imitation, so a spec that
 * passes here is reading the same shapes the real session reads. Every user
 * message read is recorded, text and the size of each image block (#83),
 * on the driver and, for the specs, on `globalThis` under MOCK_RECEIVED_LOG.
 *
 * An interrupt ends the running turn and nothing else: the query goes on
 * reading prompts, as the real one does, so the context is kept (#84). Only
 * `close()` ends the stream. A file rewind is bookkeeping over the Edit calls
 * the query answered (#99): the dry run lists the file of every allowed
 * `edit:` since the user message named, one line in and one out each, and
 * touches nothing; the real run forgets those edits, so the next preview is
 * empty. The query knows only the messages it read itself, so a checkpoint
 * from before a resume is refused with a reason, as the SDK refuses. One
 * driver numbers its sessions: the first is `mock-session`, the next
 * `mock-session-2`, so a fresh session after `new-task` has an id of its own.
 */

const MOCK_MODEL = 'claude-mock-1'
const MOCK_SESSION_ID = 'mock-session'
const MOCK_TOOLS = [
  'Read',
  'Edit',
  'Write',
  'Bash',
  'Agent',
  'AskUserQuestion',
  'ExitPlanMode',
] as const
/** The file every `edit:` prompt edits, and what it held before (#68). */
const MOCK_FILE = '/mock/notes.txt'
const MOCK_FILE_TEXT = 'alpha\nbeta\ngamma\n'
const MOCK_DURATION_MS = 1
/** How often a `stream:` turn yields a text frame. */
const STREAM_INTERVAL_MS = 20
/** A `stream:` turn nobody interrupts still ends, so a spec cannot hang on it. */
const STREAM_LIMIT = 500
const INTERRUPTED = 'Interrupted by the user'
/** The window every mock model has. */
const MOCK_CONTEXT_WINDOW = 200_000
/** What a turn adds to the context, and what a fresh or compacted one holds. */
const TURN_TOKENS = 2_000

/** Where every `plan:` prompt says its plan file is; the file never exists (#82). */
const MOCK_PLAN_FILE = '/mock/plans/plan.md'

/** The guide's interview prompt, as the `interview` command sends it (#85). */
const INTERVIEW_PROMPT =
  /^I want to build (.+?)\. Interview me in detail using the AskUserQuestion tool\./s
/** The guide's investigation prompt, as the `investigate` command sends it (#85). */
const INVESTIGATE_PROMPT = 'Use subagents to investigate '

/** The three options every `ask:` prompt offers; the spec answers with `2` (#63). */
const MOCK_OPTIONS = [
  { label: 'alpha', description: 'The first option.' },
  { label: 'beta', description: 'The second option.' },
  { label: 'gamma', description: 'The third option.' },
] as const

function usageOf(inputTokens: number): NonNullableUsage {
  return {
    cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    fallback_credit: null,
    inference_geo: 'mock',
    input_tokens: inputTokens,
    iterations: [],
    output_tokens: 0,
    output_tokens_details: { thinking_tokens: 0 },
    server_tool_use: { web_fetch_requests: 0, web_search_requests: 0 },
    service_tier: 'standard',
    speed: 'standard',
  }
}

function modelUsageOf(inputTokens: number): ModelUsage {
  return {
    inputTokens,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    webSearchRequests: 0,
    costUSD: 0,
    contextWindow: MOCK_CONTEXT_WINDOW,
    maxOutputTokens: 32_000,
  }
}

/** Counter-based, so two runs of a spec produce the same transcript. */
function mockUuid(counter: number): UUID {
  return `00000000-0000-4000-8000-${String(counter).padStart(12, '0')}` as UUID
}

function promptText(message: SDKUserMessage): string {
  const content = message.message.content
  if (typeof content === 'string') return content
  const parts: string[] = []
  for (const block of content) {
    if (block.type === 'text') parts.push(block.text)
  }
  return parts.join('\n')
}

/**
 * What the mock saw of one user message (#83): the text of every text block
 * and, of every image block, its media type and how many bytes it carried,
 * never the bytes. The specs read this to assert an attached image arrived
 * next to its text.
 */
export type ReceivedBlock =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image'; readonly mediaType: string; readonly bytes: number }
  | { readonly type: string }

export interface ReceivedMessage {
  readonly blocks: readonly ReceivedBlock[]
}

/** Every user message every mock query read, in order, across sessions. */
const RECEIVED: ReceivedMessage[] = []

/** Where the main process exposes the record under test, for `app.evaluate` in a spec. */
export const MOCK_RECEIVED_LOG = '__nemesisMockReceived'

function receivedOf(message: SDKUserMessage): ReceivedMessage {
  const content = message.message.content
  if (typeof content === 'string') return { blocks: [{ type: 'text', text: content }] }
  return {
    blocks: content.map((block): ReceivedBlock => {
      if (block.type === 'text') return { type: 'text', text: block.text }
      if (block.type === 'image' && block.source.type === 'base64') {
        return {
          type: 'image',
          mediaType: block.source.media_type,
          bytes: Buffer.from(block.source.data, 'base64').byteLength,
        }
      }
      return { type: block.type }
    }),
  }
}

/** Resolves after `ms`, or at once when the turn is aborted meanwhile. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve()
      return
    }
    const timer = setTimeout(done, ms)
    function done(): void {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    signal.addEventListener('abort', done, { once: true })
  })
}

class MockQuery implements AgentQueryHandle {
  private readonly prompt: AsyncIterable<SDKUserMessage>
  private readonly options: Options
  private readonly sessionId: string
  /** The running turn's controller: an interrupt aborts it, the next turn gets a new one. */
  private turn = new AbortController()
  private counter = 0
  private turns = 0
  private model: string
  private permissionMode: NonNullable<Options['permissionMode']>
  private closed = false
  /** What the next request carries into the model. */
  private contextTokens = 0
  /** The turn each user message opened, by the uuid it was sent under (#99). */
  private readonly turnOf = new Map<string, number>()
  /** The allowed Edit calls, by the turn that made them, until a rewind forgets them (#99). */
  private edits: { readonly turn: number; readonly file: string }[] = []

  constructor(prompt: AsyncIterable<SDKUserMessage>, options: Options, sessionId: string) {
    this.prompt = prompt
    this.options = options
    this.sessionId =
      options.resume !== undefined && options.forkSession !== true ? options.resume : sessionId
    this.model = options.model ?? MOCK_MODEL
    this.permissionMode = options.permissionMode ?? 'default'
  }

  interrupt(): Promise<unknown> {
    this.turn.abort()
    return Promise.resolve(undefined)
  }

  /** The mock writes no file: see the edits bookkeeping in the file comment (#99). */
  rewindFiles(userMessageId: string, options: RewindFilesOptions = {}): Promise<RewindFilesResult> {
    const turn = this.turnOf.get(userMessageId)
    if (turn === undefined) {
      return Promise.resolve({
        canRewind: false,
        error: 'the mock query has no record of that message',
      })
    }
    const since = this.edits.filter((edit) => edit.turn >= turn)
    const filesChanged = [...new Set(since.map((edit) => edit.file))]
    if (options.dryRun !== true) this.edits = this.edits.filter((edit) => edit.turn < turn)
    return Promise.resolve({
      canRewind: true,
      filesChanged,
      insertions: since.length,
      deletions: since.length,
    })
  }

  setPermissionMode(mode: NonNullable<Options['permissionMode']>): Promise<void> {
    this.permissionMode = mode
    return Promise.resolve()
  }

  setModel(model?: string): Promise<void> {
    this.model = model ?? MOCK_MODEL
    return Promise.resolve()
  }

  close(): void {
    this.closed = true
    this.turn.abort()
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKMessage> {
    yield this.init()
    for await (const message of this.prompt) {
      if (this.closed) return
      RECEIVED.push(receivedOf(message))
      this.turn = new AbortController()
      if (message.uuid !== undefined) this.turnOf.set(message.uuid, this.turns + 1)
      yield* this.answer(promptText(message))
    }
  }

  private async *answer(prompt: string): AsyncGenerator<SDKMessage> {
    this.turns += 1
    this.contextTokens += TURN_TOKENS

    if (/^\/compact(\s|$)/.test(prompt)) {
      const before = this.contextTokens
      this.contextTokens = TURN_TOKENS
      yield this.compactBoundary(before, this.contextTokens)
      yield this.result('Compacted.')
      return
    }

    if (prompt.startsWith('usage:')) {
      const tokens = Number.parseInt(prompt.slice(6).trim(), 10)
      if (Number.isFinite(tokens) && tokens >= 0) this.contextTokens = tokens
      const reply = `Context is now ${this.contextTokens} tokens.`
      yield this.assistant([{ type: 'text', text: reply, citations: null }])
      yield this.result(reply)
      return
    }

    if (prompt.startsWith('stream:')) {
      const word = prompt.slice(7).trim() || 'chunk'
      const signal = this.turn.signal
      for (let n = 1; n <= STREAM_LIMIT && !signal.aborted; n += 1) {
        yield this.assistant([{ type: 'text', text: `${word} ${n}`, citations: null }])
        await sleep(STREAM_INTERVAL_MS, signal)
      }
      yield signal.aborted ? this.interruptedResult() : this.result(`${word} done`)
      return
    }

    if (prompt.startsWith('think:')) {
      yield this.assistant([{ type: 'thinking', thinking: prompt.slice(6).trim(), signature: '' }])
    }

    if (prompt.startsWith('tool:')) {
      const name = prompt.slice(5).trim() || 'Read'
      const toolUseId = `mock-tool-${this.turns}`
      const input = { path: '/mock/notes.txt' }
      yield this.assistant([{ type: 'tool_use', id: toolUseId, name, input }])
      const decision = await this.ask(name, input)
      const allowed = decision.behavior === 'allow'
      yield this.toolResult(toolUseId, allowed ? `${name} ran` : decision.message, !allowed)
      const reply = allowed ? `Ran ${name}.` : `Did not run ${name}.`
      yield this.assistant([{ type: 'text', text: reply, citations: null }])
      yield this.result(reply)
      return
    }

    if (prompt.startsWith('edit:')) {
      const replacement = prompt.slice(5).trim() || 'beta changed'
      const toolUseId = `mock-tool-${this.turns}`
      const input = {
        file_path: MOCK_FILE,
        old_string: MOCK_FILE_TEXT,
        new_string: MOCK_FILE_TEXT.replace('beta', replacement),
      }
      yield this.assistant([{ type: 'tool_use', id: toolUseId, name: 'Edit', input }])
      const decision = await this.ask('Edit', input)
      const allowed = decision.behavior === 'allow'
      if (allowed) this.edits.push({ turn: this.turns, file: MOCK_FILE })
      yield this.toolResult(toolUseId, allowed ? 'Edit ran' : decision.message, !allowed)
      const reply = allowed ? 'Edited notes.txt.' : 'Did not edit notes.txt.'
      yield this.assistant([{ type: 'text', text: reply, citations: null }])
      yield this.result(reply)
      return
    }

    if (prompt.startsWith('check:')) {
      const what = prompt.slice(6).trim() || 'auth'
      const toolUseId = `mock-tool-${this.turns}`
      const input = { command: `npm test -- ${what}`, description: `Run the ${what} tests` }
      yield this.assistant([{ type: 'tool_use', id: toolUseId, name: 'Bash', input }])
      const decision = await this.ask('Bash', input)
      const allowed = decision.behavior === 'allow'
      yield this.toolResult(
        toolUseId,
        allowed
          ? ` Test Files  1 passed (1)\n      Tests  3 passed (3)\n   Duration  0.42s\n`
          : decision.message,
        !allowed,
      )
      const reply = allowed ? `Ran the ${what} tests.` : `Did not run the ${what} tests.`
      yield this.assistant([{ type: 'text', text: reply, citations: null }])
      yield this.result(reply)
      return
    }

    if (prompt.startsWith('ask:')) {
      const question = prompt.slice(4).trim() || 'Which one?'
      const toolUseId = `mock-tool-${this.turns}`
      const input = {
        questions: [{ question, header: 'Choice', options: [...MOCK_OPTIONS], multiSelect: false }],
      }
      yield this.assistant([{ type: 'tool_use', id: toolUseId, name: 'AskUserQuestion', input }])
      const decision = await this.ask('AskUserQuestion', input)
      // The CLI reads the answers off the updated input, keyed by question text.
      const answer =
        decision.behavior === 'allow' ? answerOf(decision.updatedInput, question) : null
      const reply = answer === null ? 'No answer.' : `You chose: ${answer}`
      yield this.toolResult(
        toolUseId,
        decision.behavior === 'allow' ? (answer ?? '') : decision.message,
        decision.behavior !== 'allow',
      )
      yield this.assistant([{ type: 'text', text: reply, citations: null }])
      yield this.result(reply)
      return
    }

    const interview = INTERVIEW_PROMPT.exec(prompt)
    if (interview !== null) {
      const goal = interview[1] ?? 'the feature'
      const askId = `mock-tool-${this.turns}-ask`
      const question = `What matters most for ${goal}?`
      const askInput = {
        questions: [
          { question, header: 'Priority', options: [...MOCK_OPTIONS], multiSelect: false },
        ],
      }
      yield this.assistant([
        { type: 'tool_use', id: askId, name: 'AskUserQuestion', input: askInput },
      ])
      const asked = await this.ask('AskUserQuestion', askInput, askId)
      const priority =
        asked.behavior === 'allow'
          ? (answerOf(asked.updatedInput, question) ?? 'undecided')
          : 'undecided'
      yield this.toolResult(
        askId,
        asked.behavior === 'allow' ? priority : asked.message,
        asked.behavior !== 'allow',
      )
      // The spec goes to SPEC.md in the working directory, as the prompt asks.
      const writeId = `mock-tool-${this.turns}`
      const specPath = join(this.options.cwd ?? process.cwd(), 'SPEC.md')
      const spec = `# Spec: ${goal}\n\n## Decisions\n\n- Priority: ${priority}\n\n## Out of scope\n\n- Everything not named above\n\n## Verification\n\n- Run the gate\n`
      const writeInput = { file_path: specPath, content: spec }
      yield this.assistant([{ type: 'tool_use', id: writeId, name: 'Write', input: writeInput }])
      const written = await this.ask('Write', writeInput)
      const wrote = written.behavior === 'allow'
      yield this.toolResult(writeId, wrote ? `Wrote ${specPath}` : written.message, !wrote)
      const reply = wrote ? 'Spec written to SPEC.md.' : 'Did not write SPEC.md.'
      yield this.assistant([{ type: 'text', text: reply, citations: null }])
      yield this.result(reply)
      return
    }

    if (prompt.startsWith(INVESTIGATE_PROMPT)) {
      const topic = prompt.slice(INVESTIGATE_PROMPT.length).trim() || 'the code'
      const agentId = `mock-tool-${this.turns}`
      const agentInput = { description: 'Investigate', prompt: topic, subagent_type: 'Explore' }
      yield this.assistant([{ type: 'tool_use', id: agentId, name: 'Agent', input: agentInput }])
      // Inside the subagent: every frame names the Agent call as its parent.
      const readId = `${agentId}-read`
      yield this.assistant(
        [{ type: 'tool_use', id: readId, name: 'Read', input: { path: MOCK_FILE } }],
        agentId,
      )
      yield this.toolResult(readId, MOCK_FILE_TEXT, false, agentId)
      yield this.assistant(
        [{ type: 'text', text: `Found 2 files about ${topic}.`, citations: null }],
        agentId,
      )
      yield this.toolResult(agentId, `Summary: ${topic} is handled in notes.txt.`, false)
      const reply = `Investigated: ${topic}`
      yield this.assistant([{ type: 'text', text: reply, citations: null }])
      yield this.result(reply)
      return
    }

    if (prompt.startsWith('plan:')) {
      const goal = prompt.slice(5).trim() || 'do the thing'
      const toolUseId = `mock-tool-${this.turns}`
      const plan = `# Plan\n\n1. ${goal}\n2. Run the gate\n`
      const input = { plan, planFilePath: MOCK_PLAN_FILE }
      yield this.assistant([{ type: 'tool_use', id: toolUseId, name: 'ExitPlanMode', input }])
      const decision = await this.ask('ExitPlanMode', input)
      if (decision.behavior === 'allow') {
        // The CLI reads the edited plan off the updated input, when the user edited it.
        const approved = decision.updatedInput?.['plan']
        const text = typeof approved === 'string' ? approved : plan
        const edited = text !== plan
        yield this.toolResult(
          toolUseId,
          `User has approved your plan${edited ? ' (edited by user)' : ''}.\n\n## Approved Plan:\n${text}`,
          false,
        )
        const reply = `Approved plan${edited ? ', as you edited it' : ''}:\n${text}`
        yield this.assistant([{ type: 'text', text: reply, citations: null }])
        yield this.result(reply)
      } else {
        yield this.toolResult(toolUseId, decision.message, true)
        const reply = `Plan sent back with feedback:\n${decision.message}`
        yield this.assistant([{ type: 'text', text: reply, citations: null }])
        yield this.result(reply)
      }
      return
    }

    const reply = `You said: ${prompt}`
    yield this.assistant([{ type: 'text', text: reply, citations: null }])
    yield this.result(reply)
  }

  /** Routes through the session's permission handler, like the real SDK does. */
  private async ask(
    name: string,
    input: Record<string, unknown>,
    toolUseId = `mock-tool-${this.turns}`,
  ): Promise<PermissionResult> {
    const canUseTool = this.options.canUseTool
    if (canUseTool === undefined) return { behavior: 'allow' }
    const decision = await canUseTool(name, input, {
      signal: this.turn.signal,
      toolUseID: toolUseId,
      requestId: `mock-request-${this.turns}`,
    })
    // A handler that decides nothing has not said yes.
    return decision ?? { behavior: 'deny', message: 'The permission handler made no decision' }
  }

  private init(): SDKSystemMessage {
    return {
      type: 'system',
      subtype: 'init',
      apiKeySource: 'none',
      claude_code_version: 'mock',
      cwd: this.options.cwd ?? process.cwd(),
      tools: [...MOCK_TOOLS],
      mcp_servers: [],
      model: this.model,
      permissionMode: this.permissionMode,
      slash_commands: [],
      output_style: 'default',
      skills: [],
      plugins: [],
      uuid: mockUuid((this.counter += 1)),
      session_id: this.sessionId,
    }
  }

  /** A frame of the main thread, or, with `parent`, one produced inside the subagent that call started. */
  private assistant(
    content: SDKAssistantMessage['message']['content'],
    parent: string | null = null,
  ): SDKAssistantMessage {
    return {
      type: 'assistant',
      parent_tool_use_id: parent,
      uuid: mockUuid((this.counter += 1)),
      session_id: this.sessionId,
      message: {
        id: `mock-message-${this.counter}`,
        container: null,
        content,
        context_management: null,
        diagnostics: null,
        model: this.model,
        role: 'assistant',
        stop_details: null,
        stop_reason: 'end_turn',
        stop_sequence: null,
        type: 'message',
        usage: usageOf(this.contextTokens),
      },
    }
  }

  private compactBoundary(preTokens: number, postTokens: number): SDKCompactBoundaryMessage {
    return {
      type: 'system',
      subtype: 'compact_boundary',
      compact_metadata: { trigger: 'manual', pre_tokens: preTokens, post_tokens: postTokens },
      uuid: mockUuid((this.counter += 1)),
      session_id: this.sessionId,
    }
  }

  private toolResult(
    toolUseId: string,
    text: string,
    isError: boolean,
    parent: string | null = null,
  ): SDKUserMessage {
    return {
      type: 'user',
      parent_tool_use_id: parent,
      uuid: mockUuid((this.counter += 1)),
      session_id: this.sessionId,
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: toolUseId, content: text, is_error: isError },
        ],
      },
    }
  }

  private result(text: string): SDKResultMessage {
    return {
      type: 'result',
      subtype: 'success',
      duration_ms: MOCK_DURATION_MS,
      duration_api_ms: MOCK_DURATION_MS,
      is_error: false,
      num_turns: this.turns,
      result: text,
      stop_reason: 'end_turn',
      total_cost_usd: 0,
      usage: usageOf(this.contextTokens),
      modelUsage: { [this.model]: modelUsageOf(this.contextTokens) },
      permission_denials: [],
      uuid: mockUuid((this.counter += 1)),
      session_id: this.sessionId,
    }
  }

  /** How the CLI ends a turn the user stopped: an error result naming the interrupt. */
  private interruptedResult(): SDKResultError {
    return {
      type: 'result',
      subtype: 'error_during_execution',
      duration_ms: MOCK_DURATION_MS,
      duration_api_ms: MOCK_DURATION_MS,
      is_error: true,
      num_turns: this.turns,
      stop_reason: null,
      total_cost_usd: 0,
      usage: usageOf(this.contextTokens),
      modelUsage: { [this.model]: modelUsageOf(this.contextTokens) },
      permission_denials: [],
      errors: [INTERRUPTED],
      uuid: mockUuid((this.counter += 1)),
      session_id: this.sessionId,
    }
  }
}

function answerOf(
  updatedInput: Record<string, unknown> | undefined,
  question: string,
): string | null {
  const answers = updatedInput?.['answers']
  if (typeof answers !== 'object' || answers === null) return null
  const answer = (answers as Record<string, unknown>)[question]
  return typeof answer === 'string' ? answer : null
}

/**
 * The mock driver. It refuses to exist outside the test environment: a
 * cockpit that silently answered with canned text would be worse than one
 * that fails to start.
 */
export function mockDriver(): AgentDriver & { readonly received: readonly ReceivedMessage[] } {
  if (process.env['NODE_ENV'] !== 'test') {
    throw new Error('The mock Agent SDK is available only when NODE_ENV is test')
  }
  // The specs read the record off the main process; nothing else is test only here.
  ;(globalThis as { [MOCK_RECEIVED_LOG]?: readonly ReceivedMessage[] })[MOCK_RECEIVED_LOG] =
    RECEIVED
  let sessions = 0
  return {
    received: RECEIVED,
    query: ({ prompt, options }) => {
      sessions += 1
      const sessionId = sessions === 1 ? MOCK_SESSION_ID : `${MOCK_SESSION_ID}-${sessions}`
      return new MockQuery(prompt, options, sessionId)
    },
  }
}
