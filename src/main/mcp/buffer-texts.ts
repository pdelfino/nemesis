import type { BufferInfo } from '../../shared/buffers'
import type { SessionDiff } from '../../shared/diff'
import type { AgentEvent, AgentQuestion } from '../agent/events'
import type { PendingRequest } from '../agent/permission-bridge'
import type { BufferRegistry } from '../buffers'

/**
 * The text of every buffer kind the window shows, for `cockpit_read_buffer`
 * (#117, ADR 0008). The main process pushes each buffer's content to the
 * window once, when it is shown; this keeps the last push per buffer id, so
 * a read answers with what the window was given, and forgets a buffer when
 * it is killed. A permission request is rendered from the bridge's pending
 * list the way the request section draws it, since its buffer has no push
 * of its own.
 *
 * The prompt and the transcript are not here: the server reads the draft
 * and the session folder's `session.org` for those.
 */

/** Anything that pushes a buffer's content when it shows it. */
export interface ShownSource<T extends { readonly bufferId: string }> {
  onShown(listener: (content: T) => void): () => void
}

/** The permission bridge as this file reads it. */
export interface RequestSource {
  readonly pending: readonly PendingRequest[]
  on(listener: (event: AgentEvent) => void): () => void
}

export class BufferTexts {
  private readonly texts = new Map<string, string>()
  /** The SDK's sentence for a request, by request id, off its `permission-request` event. */
  private readonly titles = new Map<string, string | null>()
  private requests: RequestSource | null = null

  constructor(buffers: BufferRegistry) {
    buffers.subscribe((list) => {
      for (const id of [...this.texts.keys()]) {
        if (!list.buffers.some((buffer) => buffer.id === id)) this.texts.delete(id)
      }
    })
  }

  /** Keeps what `source` pushes, as `render` turns it into text. */
  follow<T extends { readonly bufferId: string }>(
    source: ShownSource<T>,
    render: (content: T) => string,
  ): void {
    source.onShown((content) => this.texts.set(content.bufferId, render(content)))
  }

  /** Reads the requests the permission buffers show from the bridge. */
  followRequests(requests: RequestSource): void {
    this.requests = requests
    requests.on((event) => {
      if (event.type === 'permission-request') this.titles.set(event.requestId, event.title ?? null)
      else if (event.type === 'permission-answered') this.titles.delete(event.requestId)
    })
  }

  /** The text of `buffer`, or undefined when nothing was shown in it. */
  text(buffer: BufferInfo): string | undefined {
    if (buffer.kind === 'permission') {
      const request = this.requests?.pending.find((entry) => entry.bufferId === buffer.id)
      return request === undefined ? undefined : requestText(request, this.titles.get(request.id))
    }
    return this.texts.get(buffer.id)
  }
}

/** A diff as text: the path, then the old lines with `-` and the new with `+`. */
export function diffText(diff: SessionDiff): string {
  const side = (mark: string, text: string): string[] =>
    text.length === 0
      ? []
      : text
          .replace(/\n$/, '')
          .split('\n')
          .map((line) => `${mark}${line}`)
  return [
    `${diff.tool} ${diff.filePath}`,
    ...side('-', diff.oldText),
    ...side('+', diff.newText),
  ].join('\n')
}

/** What the request section shows: the question asked now and its options, or the tool and its keys. */
export function requestText(request: PendingRequest, title: string | null | undefined): string {
  const question: AgentQuestion | undefined = request.questions?.[request.answers.length]
  if (question === undefined) {
    return [
      title ?? `${request.toolName} wants to run`,
      `y allow once, n deny, a allow ${request.toolName} for this session`,
    ].join('\n')
  }
  return [
    question.question,
    ...question.options.map((option, index) =>
      option.description.length === 0
        ? `${index + 1}. ${option.label}`
        : `${index + 1}. ${option.label}: ${option.description}`,
    ),
  ].join('\n')
}
