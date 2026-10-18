import type {
  NonNullableUsage,
  Options,
  PermissionResult,
  SDKAssistantMessage,
  SDKMessage,
  SDKResultMessage,
  SDKSystemMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk'
import type { UUID } from 'node:crypto'
import type { AgentDriver, AgentQueryHandle } from './session'

/**
 * A deterministic stand-in for the Agent SDK (#58), honored only when
 * NODE_ENV is `test`. Every end-to-end spec runs against it, so the cockpit
 * can be driven without a network, an account or a wall clock.
 *
 * It answers a tiny prompt language, so a spec asks for the frames it needs:
 *
 *   `think: ...`  a thinking block, then the reply
 *   `tool: Name`  a tool call named `Name` through `canUseTool`, then the reply
 *   `ask: ...`    an AskUserQuestion with three options through `canUseTool`,
 *                 then `You chose: <answer>` (#63)
 *   anything else the reply `You said: <prompt>`
 *
 * The frames are the SDK's own types, not a loose imitation, so a spec that
 * passes here is reading the same shapes the real session reads.
 */

const MOCK_MODEL = 'claude-mock-1'
const MOCK_SESSION_ID = 'mock-session'
const MOCK_TOOLS = ['Read', 'Write', 'Bash', 'AskUserQuestion'] as const
const MOCK_DURATION_MS = 1

/** The three options every `ask:` prompt offers; the spec answers with `2` (#63). */
const MOCK_OPTIONS = [
  { label: 'alpha', description: 'The first option.' },
  { label: 'beta', description: 'The second option.' },
  { label: 'gamma', description: 'The third option.' },
] as const

const MOCK_USAGE: NonNullableUsage = {
  cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  fallback_credit: null,
  inference_geo: 'mock',
  input_tokens: 0,
  iterations: [],
  output_tokens: 0,
  output_tokens_details: { thinking_tokens: 0 },
  server_tool_use: { web_fetch_requests: 0, web_search_requests: 0 },
  service_tier: 'standard',
  speed: 'standard',
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

class MockQuery implements AgentQueryHandle {
  private readonly prompt: AsyncIterable<SDKUserMessage>
  private readonly options: Options
  private readonly sessionId: string
  private readonly aborter = new AbortController()
  private counter = 0
  private turns = 0
  private model: string
  private permissionMode: NonNullable<Options['permissionMode']>
  private interrupted = false

  constructor(prompt: AsyncIterable<SDKUserMessage>, options: Options) {
    this.prompt = prompt
    this.options = options
    this.sessionId = options.resume ?? MOCK_SESSION_ID
    this.model = options.model ?? MOCK_MODEL
    this.permissionMode = options.permissionMode ?? 'default'
  }

  interrupt(): Promise<unknown> {
    this.interrupted = true
    this.aborter.abort()
    return Promise.resolve(undefined)
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
    this.interrupted = true
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKMessage> {
    yield this.init()
    for await (const message of this.prompt) {
      if (this.interrupted) return
      yield* this.answer(promptText(message))
    }
  }

  private async *answer(prompt: string): AsyncGenerator<SDKMessage> {
    this.turns += 1

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

    const reply = `You said: ${prompt}`
    yield this.assistant([{ type: 'text', text: reply, citations: null }])
    yield this.result(reply)
  }

  /** Routes through the session's permission handler, like the real SDK does. */
  private async ask(name: string, input: Record<string, unknown>): Promise<PermissionResult> {
    const canUseTool = this.options.canUseTool
    if (canUseTool === undefined) return { behavior: 'allow' }
    const decision = await canUseTool(name, input, {
      signal: this.aborter.signal,
      toolUseID: `mock-tool-${this.turns}`,
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

  private assistant(content: SDKAssistantMessage['message']['content']): SDKAssistantMessage {
    return {
      type: 'assistant',
      parent_tool_use_id: null,
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
        usage: MOCK_USAGE,
      },
    }
  }

  private toolResult(toolUseId: string, text: string, isError: boolean): SDKUserMessage {
    return {
      type: 'user',
      parent_tool_use_id: null,
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
      usage: MOCK_USAGE,
      modelUsage: {},
      permission_denials: [],
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
export function mockDriver(): AgentDriver {
  if (process.env['NODE_ENV'] !== 'test') {
    throw new Error('The mock Agent SDK is available only when NODE_ENV is test')
  }
  return {
    query: ({ prompt, options }) => new MockQuery(prompt, options),
  }
}
