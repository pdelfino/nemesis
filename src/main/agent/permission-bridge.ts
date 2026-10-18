import type { BufferRegistry } from '../buffers'
import { CommandError } from '../commands/registry'
import type {
  AgentEvent,
  AgentEventListener,
  AgentQuestion,
  PermissionDecision,
  PermissionHandler,
  PermissionRequest,
} from './events'

/**
 * The permission bridge (#63): the handler the session asks before a tool
 * runs, answered from the keyboard. A request becomes a `permission` buffer
 * in the registry, so the mode line lists it until it is answered, the
 * `y`/`n`/`a` keymap of #59 applies while it is current, and `C-x b` walks
 * away from it and back like from any other buffer. The decision is held
 * here as an unresolved promise; a command resolves it.
 *
 * The policy of which tools ask is not here: in M1 it is the CLI's own
 * settings, read by the SDK, and #55 layers the page-buffer policy on this
 * same seam. This file only asks the user what the policy asked, and keeps
 * the one thing the user can decide for the rest of the session: `a` puts a
 * tool on an in-memory allow list that answers for it from then on.
 *
 * AskUserQuestion is a tool call like any other to the SDK, so it arrives
 * here too. Its questions are numbered; a digit picks an option and free text
 * from the prompt buffer answers in the user's own words. The answers go back
 * as `updatedInput.answers`, keyed by question text, the way the CLI reads
 * them. A multi-select question takes one option this way, or a reply naming
 * several.
 *
 * Plain data, no Electron types, like the buffer registry: the unit tests
 * drive it with a bare registry and the session bridge wires its events to
 * the window.
 */

export const ASK_USER_QUESTION = 'AskUserQuestion'

/** The renderer element the request buffers show in (src/renderer/index.html). */
export const REQUEST_ELEMENT_ID = 'request'

/** What the agent is told when the user says no without a word. */
export const DENIED_BY_USER = 'The user denied this tool in the cockpit.'
const DECLINED_QUESTION = 'The user declined to answer.'
const REQUEST_KILLED = 'The user killed the request buffer.'
const REQUEST_ABORTED = 'The request was withdrawn before the user answered.'

/** A request shown to the user and not yet answered. */
export interface PendingRequest {
  readonly id: string
  readonly toolName: string
  readonly bufferId: string
  readonly questions: readonly AgentQuestion[] | null
  /** Answers given so far, one per question, in order. */
  readonly answers: readonly string[]
}

interface Entry {
  readonly id: string
  readonly request: PermissionRequest
  readonly bufferId: string
  readonly questions: readonly AgentQuestion[] | null
  readonly answers: string[]
  readonly resolve: (decision: PermissionDecision) => void
}

export class PermissionBridge implements PermissionHandler {
  private readonly buffers: BufferRegistry
  private readonly listeners = new Set<AgentEventListener>()
  private readonly entries: Entry[] = []
  private readonly allowed = new Set<string>()
  private counter = 0
  /** The buffer that was current before the first pending request took the point. */
  private returnTo: string | null = null

  constructor(buffers: BufferRegistry) {
    this.buffers = buffers
    // A killed request buffer is an answer: the agent must not wait on a
    // request the user can no longer see.
    buffers.subscribe((list) => {
      for (const entry of [...this.entries]) {
        if (!list.buffers.some((buffer) => buffer.id === entry.bufferId)) {
          this.settle(entry, { behavior: 'deny', message: REQUEST_KILLED }, 'deny')
        }
      }
    })
  }

  /** The session bridge subscribes and pushes these to the window with the agent events. */
  on(listener: AgentEventListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** Unanswered requests, oldest first. The keys answer the first one. */
  get pending(): readonly PendingRequest[] {
    return this.entries.map((entry) => ({
      id: entry.id,
      toolName: entry.request.toolName,
      bufferId: entry.bufferId,
      questions: entry.questions,
      answers: [...entry.answers],
    }))
  }

  /** Tools `a` allowed for the rest of the session. In memory only. */
  get allowedTools(): ReadonlySet<string> {
    return this.allowed
  }

  requestPermission(request: PermissionRequest): Promise<PermissionDecision> {
    if (this.allowed.has(request.toolName)) return Promise.resolve({ behavior: 'allow' })
    if (request.signal.aborted) {
      return Promise.resolve({ behavior: 'deny', message: REQUEST_ABORTED })
    }
    return new Promise((resolve) => {
      this.counter += 1
      const id = `r${this.counter}`
      const questions =
        request.toolName === ASK_USER_QUESTION ? parseQuestions(request.input) : null
      // The transcript gets the block before the mode line gets the buffer,
      // so a reader sees what is asked before the point moves to it.
      this.emit({
        type: 'permission-request',
        requestId: id,
        toolUseId: request.toolUseId,
        toolName: request.toolName,
        input: request.input,
        ...(request.title === undefined ? {} : { title: request.title }),
        ...(questions === null ? {} : { questions }),
      })
      if (this.entries.length === 0) this.returnTo = this.buffers.current?.id ?? null
      const buffer = this.buffers.create({
        kind: 'permission',
        title: titleOf(request.toolName, questions),
        elementId: REQUEST_ELEMENT_ID,
      })
      const entry: Entry = {
        id,
        request,
        bufferId: buffer.id,
        questions,
        answers: [],
        resolve,
      }
      this.entries.push(entry)
      // The first pending request holds the point; a later one waits its turn.
      if (this.entries[0] === entry) this.buffers.switchTo(buffer.id)
      request.signal.addEventListener(
        'abort',
        () => this.settle(entry, { behavior: 'deny', message: REQUEST_ABORTED }, 'aborted'),
        { once: true },
      )
    })
  }

  /** `y`: the tool runs this once. */
  allowOnce(): void {
    const entry = this.head()
    if (entry.questions !== null) {
      throw new CommandError('The pending request is a question: choose with a digit or reply')
    }
    this.settle(entry, { behavior: 'allow' }, 'allow')
  }

  /** `n`: the tool does not run, and the agent is told why. */
  deny(message?: string): void {
    const entry = this.head()
    const text = message ?? (entry.questions === null ? DENIED_BY_USER : DECLINED_QUESTION)
    this.settle(entry, { behavior: 'deny', message: text }, 'deny')
  }

  /** `a`: the tool runs now and without asking for the rest of the session. */
  allowForSession(): void {
    const entry = this.head()
    if (entry.questions !== null) {
      throw new CommandError('The pending request is a question: choose with a digit or reply')
    }
    this.allowed.add(entry.request.toolName)
    this.settle(entry, { behavior: 'allow' }, 'allow-session')
  }

  /** A digit: option `number`, counted from 1, answers the current question. */
  choose(number: number): void {
    const entry = this.head()
    const question = currentQuestion(entry)
    const option = question.options[number - 1]
    if (option === undefined) {
      throw new CommandError(`The question has no option ${number}`)
    }
    this.answer(entry, option.label)
  }

  /**
   * Free text from the prompt buffer answers the current question in the
   * user's own words. False when nothing pending is a question, so the text
   * is a prompt and goes to the queue instead.
   */
  reply(text: string): boolean {
    const entry = this.entries[0]
    if (entry === undefined || entry.questions === null) return false
    this.answer(entry, text)
    return true
  }

  private head(): Entry {
    const entry = this.entries[0]
    if (entry === undefined) throw new CommandError('No request is pending')
    return entry
  }

  private answer(entry: Entry, text: string): void {
    const questions = entry.questions ?? []
    const index = entry.answers.length
    const question = questions[index]
    if (question === undefined) return
    entry.answers.push(text)
    this.emit({
      type: 'question-answered',
      requestId: entry.id,
      index,
      header: question.header,
      answer: text,
    })
    if (entry.answers.length < questions.length) return
    const answers: Record<string, string> = {}
    for (const [position, item] of questions.entries()) {
      answers[item.question] = entry.answers[position] ?? ''
    }
    this.settle(
      entry,
      { behavior: 'allow', updatedInput: { ...entry.request.input, answers } },
      'answered',
    )
  }

  private settle(
    entry: Entry,
    decision: PermissionDecision,
    outcome: 'allow' | 'allow-session' | 'deny' | 'answered' | 'aborted',
  ): void {
    const index = this.entries.indexOf(entry)
    if (index === -1) return
    this.entries.splice(index, 1)
    entry.resolve(decision)
    this.emit({
      type: 'permission-answered',
      requestId: entry.id,
      toolName: entry.request.toolName,
      outcome,
      ...(decision.behavior === 'deny' ? { message: decision.message } : {}),
    })
    if (this.buffers.get(entry.bufferId) !== undefined) this.buffers.kill(entry.bufferId)
    // The point goes to the next request, or back to where it was before the
    // first one: the prompt buffer, for a reason on a deny (#63).
    const next = this.entries[0]
    const target = next?.bufferId ?? this.returnTo
    if (target !== null && target !== undefined && this.buffers.get(target) !== undefined) {
      this.buffers.switchTo(target)
    }
    if (next === undefined) this.returnTo = null
  }

  private emit(event: AgentEvent): void {
    for (const listener of [...this.listeners]) listener(event)
  }
}

function currentQuestion(entry: Entry): AgentQuestion {
  if (entry.questions === null) throw new CommandError('The pending request is not a question')
  const question = entry.questions[entry.answers.length]
  if (question === undefined) throw new CommandError('Every question is already answered')
  return question
}

/** The one line the mode line shows for a request. */
function titleOf(toolName: string, questions: readonly AgentQuestion[] | null): string {
  if (questions === null) return `Permission: ${toolName}`
  const headers = questions.map((question) => question.header).join(', ')
  return `Question: ${headers}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * The questions of an AskUserQuestion input, or null when the input does not
 * carry any in the shape the tool documents: then the call is answered like
 * any other tool, with `y` or `n`, rather than guessed at.
 */
export function parseQuestions(input: Record<string, unknown>): readonly AgentQuestion[] | null {
  const raw = input['questions']
  if (!Array.isArray(raw) || raw.length === 0) return null
  const questions: AgentQuestion[] = []
  for (const item of raw) {
    if (!isRecord(item) || typeof item['question'] !== 'string') return null
    if (!Array.isArray(item['options']) || item['options'].length === 0) return null
    const options = []
    for (const option of item['options']) {
      if (!isRecord(option) || typeof option['label'] !== 'string') return null
      options.push({
        label: option['label'],
        description: typeof option['description'] === 'string' ? option['description'] : '',
      })
    }
    questions.push({
      question: item['question'],
      header: typeof item['header'] === 'string' ? item['header'] : 'Question',
      options,
      multiSelect: item['multiSelect'] === true,
    })
  }
  return questions
}
