import { randomUUID } from 'node:crypto'
import {
  isPageRequestName,
  PAGE_DOOR_REPLY_CHANNEL,
  PAGE_DOOR_REQUEST_CHANNEL,
  parsePageAnswer,
  parsePageReplyEnvelope,
  parsePageRequestArgs,
  type PageAnswers,
  type PageRequest,
  type PageRequestName,
  type PingAnswer,
} from '../shared/page-door'
import { pagePrompt } from './agent/boundary'
import { describeOrigin, topFrameUrl, type SenderFrame } from './ipc'
import { warnLimited } from './security/warn-limited'

/**
 * The main side of the page-script door (ADR 0009, #130, SECURITY.org T1 and
 * T4): main asks a page buffer by name, and the page preload's answer is
 * kept only when every check holds, in this order:
 *
 * - the sender WebContents is a page buffer main created and still holds,
 * - the sender frame is that buffer's top frame (#53's rule, subframes refused),
 * - the reply is exactly `{ id, name, data }`, `id` names a request main sent
 *   to that same buffer and has not yet settled, and `name` is that request's,
 * - `data` parses whole against the schema for `name` in src/shared/page-door.ts.
 *
 * A reply that fails is dropped with a rate-limited line naming the channel
 * and the origin, nothing else. When it named an open request, that request
 * settles as an error, so the consumer never sees part of an answer; a
 * request nobody answers in time settles as an error too, and a late reply
 * finds no open id. The cockpit's `guard()` path in ipc.ts is untouched:
 * page buffers stay refused on every invoke channel, and this is a separate,
 * narrower handler. Nothing here evaluates text in a page.
 */

/** How long a request waits for its answer before it settles as an error. */
export const PAGE_DOOR_TIMEOUT_MS = 5000

/** The parts of a page's WebContents the door uses; a fake satisfies it in the unit tests. */
export interface DoorContents {
  readonly id: number
  send(channel: string, request: PageRequest): void
  isDestroyed(): boolean
}

/** The parts of an IPC event the reply check reads; IpcMainEvent satisfies it. */
export interface DoorEvent {
  readonly sender: { readonly id: number }
  readonly senderFrame: SenderFrame | null | undefined
}

export interface PageScriptDoorOptions {
  /** Whether a WebContents id is a page buffer main created and still holds. */
  readonly isPage: (contentsId: number) => boolean
  readonly timeoutMs?: number
  /** `warnLimited` unless a test says otherwise. */
  readonly warn?: (key: string, line: string) => void
}

interface Pending {
  readonly contentsId: number
  readonly name: PageRequestName
  readonly settle: (outcome: { readonly data: unknown } | { readonly error: Error }) => void
}

/** A request main opened: its id, and the answer the consumer awaits. */
export interface OpenRequest<N extends PageRequestName> {
  readonly id: string
  readonly answer: Promise<PageAnswers[N]>
}

export class PageScriptDoor {
  private readonly open = new Map<string, Pending>()

  constructor(private readonly options: PageScriptDoorOptions) {}

  /**
   * Asks a page buffer's preload for `name`; the answer, parsed whole, or an
   * error. `args` are numbers only (hint mode's labels, #123), sent when given.
   */
  request<N extends PageRequestName>(
    contents: DoorContents,
    name: N,
    args?: readonly number[],
    timeoutMs?: number,
  ): Promise<PageAnswers[N]> {
    if (contents.isDestroyed()) return Promise.reject(new Error('The page is gone'))
    let checked: readonly number[]
    try {
      checked = parsePageRequestArgs(args)
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)))
    }
    const opened = this.expect(contents, name, timeoutMs)
    contents.send(
      PAGE_DOOR_REQUEST_CHANNEL,
      args === undefined ? { id: opened.id, name } : { id: opened.id, name, args: [...checked] },
    )
    return opened.answer
  }

  /**
   * Opens a request without sending it: `request` sends right after, and the
   * test hook feeds a forged reply instead, through `receive` as IPC would.
   */
  expect<N extends PageRequestName>(
    contents: DoorContents,
    name: N,
    timeoutMs: number = this.options.timeoutMs ?? PAGE_DOOR_TIMEOUT_MS,
  ): OpenRequest<N> {
    const id = randomUUID()
    const answer = new Promise<PageAnswers[N]>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.open.delete(id)) reject(new Error(`The page did not answer ${name} in time`))
      }, timeoutMs)
      this.open.set(id, {
        contentsId: contents.id,
        name,
        settle: (outcome) => {
          clearTimeout(timer)
          this.open.delete(id)
          if ('error' in outcome) reject(outcome.error)
          else resolve(outcome.data as PageAnswers[N])
        },
      })
    })
    return { id, answer }
  }

  /** The reply listener, registered on PAGE_DOOR_REPLY_CHANNEL by `installPageDoor`. */
  receive(event: DoorEvent, payload: unknown): void {
    const sender = topFrameUrl(event.senderFrame)
    const drop = (): void => {
      const warn = this.options.warn ?? warnLimited
      warn(
        `ipc ${PAGE_DOOR_REPLY_CHANNEL}`,
        `ipc: dropped ${PAGE_DOOR_REPLY_CHANNEL} from ${describeOrigin(sender)}`,
      )
    }
    if (!this.options.isPage(event.sender.id) || sender === null) {
      drop()
      return
    }
    let envelope
    try {
      envelope = parsePageReplyEnvelope(payload)
    } catch {
      drop()
      return
    }
    const pending = this.open.get(envelope.id)
    if (pending === undefined || pending.contentsId !== event.sender.id) {
      drop()
      return
    }
    // From here the reply names an open request of this page: a failure
    // settles it as an error, never as part of an answer.
    if (!isPageRequestName(envelope.name) || envelope.name !== pending.name) {
      drop()
      pending.settle({ error: new Error(`The page's answer to ${pending.name} was dropped`) })
      return
    }
    let data
    try {
      data = parsePageAnswer(pending.name, envelope.data)
    } catch {
      drop()
      pending.settle({ error: new Error(`The page's answer to ${pending.name} was dropped`) })
      return
    }
    pending.settle({ data })
  }
}

/**
 * A prompt about a page from `ping` (T4): the cockpit's instruction, then the
 * page's title and URL inside `wrapUntrusted`'s block, headed by the origin
 * of the committed top-frame URL main holds, never one the answer names.
 */
export function pingPrompt(instruction: string, committedUrl: string, answer: PingAnswer): string {
  return pagePrompt(instruction, describeOrigin(committedUrl), `${answer.title}\n${answer.url}`)
}

/** The one listener the door needs, on the IPC of the main process. */
export interface ReplyListener {
  on(channel: string, listener: (event: DoorEvent, payload: unknown) => void): unknown
}

/** Registers the door's reply path; called once, in main, before any page buffer opens. */
export function installPageDoor(ipc: ReplyListener, door: PageScriptDoor): void {
  ipc.on(PAGE_DOOR_REPLY_CHANNEL, (event, payload) => door.receive(event, payload))
}
