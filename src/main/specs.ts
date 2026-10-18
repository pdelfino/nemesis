import { basename } from 'node:path'
import type { BufferInfo } from '../shared/buffers'
import type { SpecContent } from '../shared/spec'
import type { AgentEvent, AgentEventListener, AgentToolUseEvent } from './agent/events'
import type { BufferRegistry } from './buffers'
import { CommandError } from './commands/registry'

/**
 * The spec buffers (#85): the guide's "let Claude interview you, write a
 * spec, start fresh" as buffers. The `interview` command sends the guide's
 * prompt, the AskUserQuestion rounds come through the permission bridge
 * (#63) like any question, and the prompt ends with the agent writing the
 * spec to SPEC.md. That Write is a tool call like any other: it asks through
 * the permission path, untouched, and when its result comes back without an
 * error the spec it carried opens here as a `spec` buffer, read-only, with
 * the point, and a notice says what the one key in it does.
 *
 * `start-fresh-session-from-spec` takes the spec of the current buffer,
 * kills the buffer and hands the text to the command, which drops the
 * session and sends the spec as the first message of the next one, so the
 * implementation starts with clean context, as the guide says. Several spec
 * buffers may be open; each holds its own text.
 *
 * Plain data, no Electron types, like the plan buffers: the unit tests drive
 * it with a bare registry and events, and the palette bridge pushes the
 * content to the window.
 */

/** The renderer element the spec buffers show in (src/renderer/index.html). */
export const SPEC_ELEMENT_ID = 'spec'

/** The file the guide's prompt names. The agent may put it in any folder. */
export const SPEC_FILE = 'SPEC.md'

export type SpecShownListener = (content: SpecContent) => void

/** A spec written by the agent and open in a buffer. */
export interface ShownSpec {
  readonly bufferId: string
  readonly filePath: string
  readonly text: string
}

/** A Write of a spec file the agent asked for and that has not answered yet. */
interface PendingWrite {
  readonly filePath: string
  readonly text: string
}

/**
 * The spec a Write tool call carries, or null for any other call or one
 * whose arguments are not in the shape the tool documents. Shape only, no
 * trust: the text is shown, never run.
 */
export function parseSpecWrite(event: AgentToolUseEvent): PendingWrite | null {
  if (event.name !== 'Write') return null
  const filePath = event.input['file_path']
  const text = event.input['content']
  if (typeof filePath !== 'string' || basename(filePath) !== SPEC_FILE) return null
  if (typeof text !== 'string') return null
  return { filePath, text }
}

export class SpecBuffers {
  private readonly buffers: BufferRegistry
  private readonly shownListeners = new Set<SpecShownListener>()
  private readonly listeners = new Set<AgentEventListener>()
  private readonly pending = new Map<string, PendingWrite>()
  private readonly shownSpecs = new Map<string, ShownSpec>()
  /** The last spec opened, for the command when the point is elsewhere. */
  private lastShown: string | null = null

  constructor(buffers: BufferRegistry) {
    this.buffers = buffers
    buffers.subscribe((list) => {
      for (const id of [...this.shownSpecs.keys()]) {
        if (!list.buffers.some((buffer) => buffer.id === id)) this.shownSpecs.delete(id)
      }
      if (this.lastShown !== null && !this.shownSpecs.has(this.lastShown)) this.lastShown = null
    })
  }

  /** The bridge subscribes and pushes the content of a spec buffer to the window. */
  onShown(listener: SpecShownListener): () => void {
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

  /** The specs open in a buffer, oldest first. */
  list(): readonly ShownSpec[] {
    return [...this.shownSpecs.values()]
  }

  /** The spec of the current buffer, else the last one opened, else null. */
  get current(): ShownSpec | null {
    const current = this.buffers.current
    if (current !== null) {
      const own = this.shownSpecs.get(current.id)
      if (own !== undefined) return own
    }
    return this.lastShown === null ? null : (this.shownSpecs.get(this.lastShown) ?? null)
  }

  /** The spec of `buffer`, for a test or a mode line. */
  shown(buffer: BufferInfo): ShownSpec | null {
    return this.shownSpecs.get(buffer.id) ?? null
  }

  /**
   * Reads the session's live events: a Write of the spec file is remembered
   * when asked for and opened when its result says it went through, so a
   * denied Write opens nothing. A session that stops forgets what it asked.
   */
  observe(event: AgentEvent): void {
    if (event.type === 'tool-use') {
      const write = parseSpecWrite(event)
      if (write !== null) this.pending.set(event.toolUseId, write)
    } else if (event.type === 'tool-result') {
      const write = this.pending.get(event.toolUseId)
      if (write === undefined) return
      this.pending.delete(event.toolUseId)
      if (!event.isError) this.show(write)
    } else if (event.type === 'stopped') {
      this.pending.clear()
    }
  }

  /**
   * The command takes the spec: the buffer closes, the point goes back to
   * the buffer that was current before it, and the stream says a fresh
   * session is starting with the spec. Unknown buffer: no spec is open there.
   */
  take(bufferId: string): ShownSpec {
    const spec = this.shownSpecs.get(bufferId)
    if (spec === undefined) throw new CommandError('No spec is open in that buffer')
    this.shownSpecs.delete(bufferId)
    if (this.buffers.get(bufferId) !== undefined) this.buffers.kill(bufferId)
    const prompt = this.buffers.list().find((buffer) => buffer.kind === 'prompt')
    if (prompt !== undefined) this.buffers.switchTo(prompt.id)
    this.notify(
      `Fresh session from the spec in ${spec.filePath}: the context is cleared and the spec is the first message.`,
    )
    return spec
  }

  private show(write: PendingWrite): void {
    const buffer = this.buffers.create({
      kind: 'spec',
      title: `Spec: ${basename(write.filePath)}`,
      elementId: SPEC_ELEMENT_ID,
    })
    const spec: ShownSpec = { bufferId: buffer.id, filePath: write.filePath, text: write.text }
    this.shownSpecs.set(buffer.id, spec)
    this.lastShown = buffer.id
    this.notify(
      `Spec written to ${write.filePath}: C-c C-c in the spec buffer starts a fresh session with it as the first message.`,
    )
    // The window gets the text before the point moves to it.
    for (const listener of [...this.shownListeners]) {
      listener({ bufferId: buffer.id, filePath: write.filePath, text: write.text })
    }
    this.buffers.switchTo(buffer.id)
  }

  private notify(text: string): void {
    const event: AgentEvent = { type: 'notice', text }
    for (const listener of [...this.listeners]) listener(event)
  }
}
