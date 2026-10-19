import type { HookCallback, Options } from '@anthropic-ai/claude-agent-sdk'
import { isAbsolute, relative, resolve } from 'node:path'
import type { AgentEvent, AgentEventListener, PermissionRequest } from './events'

/**
 * The side-effect rule of the agent and web boundary (#55; SECURITY.org, T4).
 * A page can carry text written to steer the model, so while the window has
 * a page buffer open, a tool that acts on the world needs the user's yes,
 * every call, and while a page is the current buffer it is denied outright.
 *
 * - A side-effect tool is Bash, WebFetch, Write, Edit or NotebookEdit on a
 *   path outside the session folder, and an MCP tool whose name says it
 *   sends, submits, posts, purchases, pays, uploads or downloads.
 * - The `PreToolUse` hook of `hooks()` answers `ask` for such a tool while
 *   any page buffer is open, so the SDK goes to `canUseTool` even when the
 *   CLI's own rules would have allowed it, and the permission bridge asks
 *   in the transcript; `mustAsk` keeps the bridge's `a` list from answering
 *   for it meanwhile. While the current buffer is a page from a domain not
 *   on the allowlist, the hook answers `deny`, with no question at all.
 *   Option A of the issue, picked on 2026-OCTOBER-17: the allowlist is empty
 *   in version 1, so every page counts; option B adds entries later.
 * - With no page buffer open the hook decides nothing and the CLI's rules
 *   apply as before. The policy never answers `allow`: the callback stays
 *   the one place a yes comes from.
 * - Each decision is a notice in the transcript, naming the tool, its
 *   arguments and the origin, next to the tool call itself.
 *
 * Plain data, no Electron: the unit tests drive it with a fake page state.
 */

/** What the policy reads of the window's page buffers, when a tool is called. */
export interface PageState {
  /** True while the window has at least one page buffer. */
  pageOpen(): boolean
  /** The origin of the current buffer when it is a page, else null. */
  currentOrigin(): string | null
}

/** Tools that act whatever their arguments. */
const ALWAYS_SIDE_EFFECT = new Set(['Bash', 'WebFetch'])

/** Tools that write the file their input names, and the input field that names it. */
const FILE_TOOLS: Readonly<Record<string, string>> = {
  Write: 'file_path',
  Edit: 'file_path',
  NotebookEdit: 'notebook_path',
}

/** An MCP tool whose name reads as one of these verbs leaves the machine or brings something onto it. */
const MCP_SIDE_EFFECT = /send|submit|post|publish|purchase|buy|order|pay|checkout|upload|download/i

/**
 * Whether a call of `toolName` with `input` has a side effect in the sense of
 * T4. A file tool without a path it names is counted as one: the policy
 * does not guess where an unnamed write lands.
 */
export function isSideEffectTool(
  toolName: string,
  input: Record<string, unknown>,
  folder: string,
): boolean {
  if (ALWAYS_SIDE_EFFECT.has(toolName)) return true
  const field = FILE_TOOLS[toolName]
  if (field !== undefined) {
    const path = input[field]
    return typeof path !== 'string' || !insideFolder(path, folder)
  }
  if (toolName.startsWith('mcp__')) {
    return MCP_SIDE_EFFECT.test(toolName.slice(toolName.lastIndexOf('__') + 2))
  }
  return false
}

/** True when `path`, taken from `folder`, does not step out of it. */
export function insideFolder(path: string, folder: string): boolean {
  const base = resolve(folder)
  const step = relative(base, resolve(base, path))
  return step === '' || (!step.startsWith('..') && !isAbsolute(step))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** The arguments as one line of the notice; the transcript shows them in full on the call. */
function argumentsOf(input: Record<string, unknown>): string {
  try {
    return JSON.stringify(input)
  } catch {
    return '(arguments could not be shown)'
  }
}

export interface PagePolicyOptions {
  /** The session folder: a file tool inside it is not a side effect. */
  readonly folder: string
  readonly pages: PageState
}

export class PagePolicy {
  private readonly options: PagePolicyOptions
  private readonly listeners = new Set<AgentEventListener>()

  constructor(options: PagePolicyOptions) {
    this.options = options
  }

  /** The cockpit merges these into the transcript's notices. */
  on(listener: AgentEventListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** True when the request must be put to the user even if `a` allowed the tool before. */
  mustAsk(request: Pick<PermissionRequest, 'toolName' | 'input'>): boolean {
    return (
      this.options.pages.pageOpen() &&
      isSideEffectTool(request.toolName, request.input, this.options.folder)
    )
  }

  /** The hooks every agent session of the window starts with. */
  hooks(): NonNullable<Options['hooks']> {
    return { PreToolUse: [{ hooks: [this.preToolUse] }] }
  }

  private readonly preToolUse: HookCallback = (input) => {
    if (input.hook_event_name !== 'PreToolUse') return Promise.resolve({})
    const args = isRecord(input.tool_input) ? input.tool_input : {}
    const name = input.tool_name
    if (!this.mustAsk({ toolName: name, input: args })) return Promise.resolve({})
    const origin = this.options.pages.currentOrigin()
    if (origin !== null) {
      const reason = `${name} has side effects and a page buffer from ${origin} is the current buffer; it was denied without a question (SECURITY.org, T4).`
      this.notify(
        `Page boundary: denied ${name} ${argumentsOf(args)}, a page from ${origin} is current.`,
      )
      return Promise.resolve({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: reason,
        },
      })
    }
    this.notify(
      `Page boundary: ${name} ${argumentsOf(args)} needs a yes while a page buffer is open.`,
    )
    return Promise.resolve({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'ask',
        permissionDecisionReason: `${name} has side effects and a page buffer is open (SECURITY.org, T4).`,
      },
    })
  }

  private notify(text: string): void {
    const event: AgentEvent = { type: 'notice', text }
    for (const listener of [...this.listeners]) listener(event)
  }
}
