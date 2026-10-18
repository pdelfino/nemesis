import type { BufferInfo } from '../shared/buffers'
import type { PlanAnswer, PlanContent } from '../shared/plan'
import { MAX_PROMPT_LENGTH } from '../shared/agent'
import { PLAN_OUTCOMES } from '../shared/plan'
import type {
  AgentEvent,
  AgentEventListener,
  PermissionDecision,
  PermissionHandler,
  PermissionRequest,
} from './agent/events'
import type { BufferRegistry } from './buffers'
import { CommandError } from './commands/registry'

/**
 * The plan buffers (#82): the guide's "edit the plan before approving" as a
 * buffer. In plan mode the agent asks to leave it through the ExitPlanMode
 * tool, which runs nothing: the CLI injects the plan it wrote as the call's
 * `plan`, an allow lifts the read-only restrictions, an allow with the plan
 * in `updatedInput` is an approval of the edited plan, and a deny's message
 * is the feedback the agent revises against. That call arrives here like
 * any other tool call, through the permission handler seam of session.ts.
 *
 * This handler sits in front of the permission bridge and takes only that
 * one tool: every other request goes to the bridge untouched, so no guard is
 * relaxed, and the one it takes becomes a `plan` buffer, the plan as
 * editable text, with the point, until `C-c C-c` approves it as edited or
 * `C-c C-k` rejects it with the edited text as feedback. A killed plan
 * buffer is a rejection: the agent must not wait on a plan nobody can see.
 * Every outcome is a notice in the stream, so the transcript says what
 * happened and the session folder keeps it; an approval also tells the
 * session manager to leave plan mode, since the SDK does not say so.
 *
 * Plain data, no Electron types, like the bridge: the unit tests drive it
 * with a bare registry and a fake next handler, and the palette bridge wires
 * its content and the window's answer.
 */

export const EXIT_PLAN_MODE = 'ExitPlanMode'

/** The renderer element the plan buffers show in (src/renderer/index.html). */
export const PLAN_ELEMENT_ID = 'plan'

export const PLAN_TITLE = 'Plan'

/** What the agent is told when the user rejects without a word of their own. */
const REJECTED_WITHOUT_NOTES = 'The user rejected the plan in the cockpit without notes.'
const PLAN_KILLED = 'The user closed the plan buffer without approving the plan; keep planning.'
const PLAN_ABORTED = 'The plan request was withdrawn before the user answered.'

export interface PlanBuffersOptions {
  /** A plan was approved: the session goes on in the mode plan mode replaced. */
  readonly leavePlanMode: () => Promise<void>
}

export type PlanShownListener = (content: PlanContent) => void

/** A plan shown to the user and not yet answered. */
export interface PendingPlan {
  readonly bufferId: string
  readonly text: string
}

interface Entry {
  readonly request: PermissionRequest
  readonly bufferId: string
  readonly text: string
  readonly resolve: (decision: PermissionDecision) => void
}

/** The plan an ExitPlanMode call carries, or nothing when the call did not. Shape only, no trust. */
export function planText(input: Record<string, unknown>): string {
  const plan = input['plan']
  return typeof plan === 'string' ? plan : ''
}

/** What the agent revises against: the user's words, the edited plan, as data. */
export function planFeedback(text: string): string {
  const trimmed = text.trim()
  if (trimmed.length === 0) return REJECTED_WITHOUT_NOTES
  return `The user rejected the plan in the cockpit. The plan as they edited it, which is their feedback:\n\n${trimmed}`
}

export class PlanBuffers implements PermissionHandler {
  private readonly buffers: BufferRegistry
  private readonly next: PermissionHandler
  private readonly options: PlanBuffersOptions
  private readonly shownListeners = new Set<PlanShownListener>()
  private readonly listeners = new Set<AgentEventListener>()
  private readonly entries: Entry[] = []
  /** The buffer that was current before the first pending plan took the point. */
  private returnTo: string | null = null

  constructor(buffers: BufferRegistry, next: PermissionHandler, options: PlanBuffersOptions) {
    this.buffers = buffers
    this.next = next
    this.options = options
    buffers.subscribe((list) => {
      for (const entry of [...this.entries]) {
        if (!list.buffers.some((buffer) => buffer.id === entry.bufferId)) {
          this.settle(entry, { behavior: 'deny', message: PLAN_KILLED }, 'killed')
        }
      }
    })
  }

  /** The bridge subscribes and pushes the content of a plan buffer to the window. */
  onShown(listener: PlanShownListener): () => void {
    this.shownListeners.add(listener)
    return () => {
      this.shownListeners.delete(listener)
    }
  }

  /** The session bridge subscribes: a notice is shown and recorded like any event. */
  on(listener: AgentEventListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** Unanswered plans, oldest first. The keys answer the first one. */
  get pending(): readonly PendingPlan[] {
    return this.entries.map((entry) => ({ bufferId: entry.bufferId, text: entry.text }))
  }

  requestPermission(request: PermissionRequest): Promise<PermissionDecision> {
    if (request.toolName !== EXIT_PLAN_MODE) return this.next.requestPermission(request)
    if (request.signal.aborted) {
      return Promise.resolve({ behavior: 'deny', message: PLAN_ABORTED })
    }
    return new Promise((resolve) => {
      const text = planText(request.input)
      if (this.entries.length === 0) this.returnTo = this.buffers.current?.id ?? null
      const buffer = this.buffers.create({
        kind: 'plan',
        title: PLAN_TITLE,
        elementId: PLAN_ELEMENT_ID,
      })
      const entry: Entry = { request, bufferId: buffer.id, text, resolve }
      this.entries.push(entry)
      this.notify(
        'Plan received: C-c C-c in the plan buffer approves it as edited, C-c C-k rejects it with the text as feedback.',
      )
      // The window gets the text before the point moves to it.
      for (const listener of [...this.shownListeners]) listener({ bufferId: buffer.id, text })
      // The first pending plan holds the point; a later one waits its turn.
      if (this.entries[0] === entry) this.buffers.switchTo(buffer.id)
      request.signal.addEventListener(
        'abort',
        () => this.settle(entry, { behavior: 'deny', message: PLAN_ABORTED }, 'aborted'),
        { once: true },
      )
    })
  }

  /** The window's answer for one plan buffer (#82). Unknown buffer: the plan was answered already. */
  answer(answer: PlanAnswer): void {
    const entry = this.entries.find((candidate) => candidate.bufferId === answer.bufferId)
    if (entry === undefined) throw new CommandError('No plan is pending in that buffer')
    if (answer.outcome === 'approve') this.approve(entry, answer.text)
    else this.reject(entry, answer.text)
  }

  /** The plan of `buffer`, for a test or a mode line. */
  shown(buffer: BufferInfo): PendingPlan | null {
    const entry = this.entries.find((candidate) => candidate.bufferId === buffer.id)
    return entry === undefined ? null : { bufferId: entry.bufferId, text: entry.text }
  }

  /**
   * `C-c C-c`: the plan runs. The edited text goes back as the plan when it
   * differs from what the agent wrote, the way the CLI reports a plan edited
   * before approval; untouched, the call is allowed as it was.
   */
  private approve(entry: Entry, text: string): void {
    const edited = text !== entry.text
    this.settle(
      entry,
      edited
        ? { behavior: 'allow', updatedInput: { ...entry.request.input, plan: text } }
        : { behavior: 'allow' },
      edited ? 'approved-edited' : 'approved',
    )
    this.options.leavePlanMode().catch((error: unknown) => {
      console.error('plan: leaving plan mode failed:', error)
    })
  }

  /** `C-c C-k`: the plan does not run, and the edited text is what the agent revises against. */
  private reject(entry: Entry, text: string): void {
    this.settle(entry, { behavior: 'deny', message: planFeedback(text) }, 'rejected')
  }

  private settle(
    entry: Entry,
    decision: PermissionDecision,
    outcome: 'approved' | 'approved-edited' | 'rejected' | 'killed' | 'aborted',
  ): void {
    const index = this.entries.indexOf(entry)
    if (index === -1) return
    this.entries.splice(index, 1)
    entry.resolve(decision)
    this.notify(describeOutcome(outcome))
    if (this.buffers.get(entry.bufferId) !== undefined) this.buffers.kill(entry.bufferId)
    // The point goes to the next plan, or back to where it was before the first.
    const next = this.entries[0]
    const target = next?.bufferId ?? this.returnTo
    if (target !== null && target !== undefined && this.buffers.get(target) !== undefined) {
      this.buffers.switchTo(target)
    }
    if (next === undefined) this.returnTo = null
  }

  private notify(text: string): void {
    const event: AgentEvent = { type: 'notice', text }
    for (const listener of [...this.listeners]) listener(event)
  }
}

function describeOutcome(
  outcome: 'approved' | 'approved-edited' | 'rejected' | 'killed' | 'aborted',
): string {
  switch (outcome) {
    case 'approved':
      return 'Plan approved: the session leaves plan mode and starts the work.'
    case 'approved-edited':
      return 'Plan approved as edited: the session leaves plan mode and starts the work.'
    case 'rejected':
      return 'Plan rejected: the edited text went back as feedback; still in plan mode.'
    case 'killed':
      return 'Plan buffer killed: the agent was told to keep planning.'
    case 'aborted':
      return 'Plan request withdrawn before it was answered.'
  }
}

/** Validates a plan answer that came over IPC. Shape only, no trust. */
export function parsePlanAnswer(payload: unknown): PlanAnswer {
  if (typeof payload !== 'object' || payload === null) {
    throw new TypeError('Plan answer is not an object')
  }
  const value = payload as Record<string, unknown>
  const bufferId = value['bufferId']
  const outcome = value['outcome']
  const text = value['text']
  if (typeof bufferId !== 'string' || bufferId.length === 0 || bufferId.length > 32) {
    throw new TypeError('Plan answer has no usable buffer id')
  }
  if (typeof outcome !== 'string' || !(PLAN_OUTCOMES as readonly string[]).includes(outcome)) {
    throw new TypeError('Plan answer has no usable outcome')
  }
  if (typeof text !== 'string' || text.length > MAX_PROMPT_LENGTH) {
    throw new TypeError('Plan answer has no usable text')
  }
  return { bufferId, outcome: outcome as PlanAnswer['outcome'], text }
}
