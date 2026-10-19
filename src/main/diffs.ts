import { realpathSync, statSync } from 'node:fs'
import { basename, isAbsolute, relative, sep } from 'node:path'
import type { BufferInfo } from '../shared/buffers'
import type { DiffContent, SessionDiff } from '../shared/diff'
import type { AgentEvent, AgentNoticeEvent, AgentToolUseEvent } from './agent/events'
import type { BufferRegistry } from './buffers'
import { CommandError } from './commands/registry'

/**
 * The diffs of the session (#68). Every Edit and Write tool call the agent
 * makes is kept here as old and new text read off the call's arguments, in
 * order, for the `diffs` palette source to list and `list-diffs` to open in
 * a `diff` buffer. One buffer per opened diff, killed like any other; a diff
 * already open is switched to, not opened twice. The list starts over when
 * a session with another id starts, so a resumed session lists the edits
 * its recorded history replays and a fresh one lists nothing.
 *
 * `C-c C-o` in a diff buffer hands the file to the system's default
 * application, which is the one door out of here: the path must be absolute,
 * a regular file on disk and inside the session's working folder, and the
 * user must say yes in the prompt buffer first, as for a download or an
 * external link (SECURITY.org, promise 2). The path is the agent's choice,
 * read off its tool call, which is why the folder check (#97): a session
 * cannot be talked into opening something elsewhere on disk, and the yes
 * keeps its meaning, which file of this project. The folder is the one the
 * session's `started` event names, so a resumed session is held to the
 * folder it was recorded in. Every outcome is a notice in the stream, so
 * the transcript says what was opened and the session folder keeps it.
 *
 * Plain data and Node built-ins, no Electron types, like the help buffers:
 * the unit tests drive it with a bare registry and fakes for the question
 * and the opener, and src/main/index.ts hands in the prompt buffer and
 * `shell.openPath`.
 */

/** The renderer element the diff buffers show in (src/renderer/index.html). */
export const DIFF_ELEMENT_ID = 'diff'

export interface DiffBuffersOptions {
  /** Asks the user; true is a yes. */
  readonly confirm: (question: string) => Promise<boolean>
  /** Hands a path to the system. Resolves with an empty string, or the system's error, as `shell.openPath` does. */
  readonly open: (path: string) => Promise<string>
}

export type DiffShownListener = (content: DiffContent) => void
export type DiffNoticeListener = (event: AgentNoticeEvent) => void

/** Longer paths are cut in the prompt and the notices: the user reads where the file is, not a payload. */
const MAX_SHOWN_PATH = 120

// eslint-disable-next-line no-control-regex
const UNPRINTABLE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g

/** The path as the prompt shows it: printable, and no longer than a line. */
export function displayPath(path: string): string {
  const clean = path.replace(UNPRINTABLE, '')
  return clean.length > MAX_SHOWN_PATH ? `${clean.slice(0, MAX_SHOWN_PATH)}...` : clean
}

/**
 * The diff an Edit or a Write tool call stands for, or null for any other
 * call or one whose arguments are not in the shape the tools document.
 * Shape only, no trust: the texts are shown, never run.
 */
export function parseDiff(event: AgentToolUseEvent, index: number): SessionDiff | null {
  const filePath = event.input['file_path']
  if (typeof filePath !== 'string' || filePath.length === 0) return null
  if (event.name === 'Edit') {
    const oldText = event.input['old_string']
    const newText = event.input['new_string']
    if (typeof oldText !== 'string' || typeof newText !== 'string') return null
    return { id: event.toolUseId, index, tool: 'Edit', filePath, oldText, newText }
  }
  if (event.name === 'Write') {
    const newText = event.input['content']
    if (typeof newText !== 'string') return null
    return { id: event.toolUseId, index, tool: 'Write', filePath, oldText: '', newText }
  }
  return null
}

/** The one line the mode line shows for a diff buffer. */
export function diffTitle(diff: SessionDiff): string {
  return `Diff ${diff.index}: ${basename(diff.filePath)}`
}

/** The palette's doc line for a diff: how big the two sides are. */
export function describeDiff(diff: SessionDiff): string {
  const after = countLines(diff.newText)
  if (diff.tool === 'Write') return `Write: the whole file, ${plural(after, 'line')}`
  return `Edit: ${plural(countLines(diff.oldText), 'line')} replaced by ${after}`
}

function countLines(text: string): number {
  if (text.length === 0) return 0
  const lines = text.split('\n')
  return text.endsWith('\n') ? lines.length - 1 : lines.length
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

function isRegularFile(path: string): boolean {
  try {
    return statSync(path, { throwIfNoEntry: false })?.isFile() === true
  } catch {
    return false
  }
}

/**
 * Whether `path` is a file strictly inside the folder `cwd` (#97). Both are
 * resolved on disk first, so a symlink under the folder that points out of
 * it is outside, and a path to the folder itself, a relative path, or one
 * that cannot be resolved is never inside.
 */
export function insideSessionFolder(cwd: string, path: string): boolean {
  if (!isAbsolute(cwd) || !isAbsolute(path)) return false
  let realCwd: string
  let realPath: string
  try {
    realCwd = realpathSync.native(cwd)
    realPath = realpathSync.native(path)
  } catch {
    return false
  }
  const rel = relative(realCwd, realPath)
  return rel.length > 0 && !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`)
}

export class DiffBuffers {
  private readonly buffers: BufferRegistry
  private readonly options: DiffBuffersOptions
  private readonly shownListeners = new Set<DiffShownListener>()
  private readonly noticeListeners = new Set<DiffNoticeListener>()
  private readonly diffs: SessionDiff[] = []
  /** Buffer id by diff id, for the diffs open in a buffer. */
  private readonly openBuffers = new Map<string, string>()
  private sessionId: string | null = null
  /** The working folder of the session, off its `started` event; the one folder a file may be opened from. */
  private cwd: string | null = null

  constructor(buffers: BufferRegistry, options: DiffBuffersOptions) {
    this.buffers = buffers
    this.options = options
    buffers.subscribe((list) => {
      for (const [diffId, bufferId] of [...this.openBuffers]) {
        if (!list.buffers.some((buffer) => buffer.id === bufferId)) this.openBuffers.delete(diffId)
      }
    })
  }

  /** The bridge subscribes and pushes the content of an opened diff to the window. */
  onShown(listener: DiffShownListener): () => void {
    this.shownListeners.add(listener)
    return () => {
      this.shownListeners.delete(listener)
    }
  }

  /** The session bridge subscribes: a notice is shown and recorded like any event. */
  on(listener: DiffNoticeListener): () => void {
    this.noticeListeners.add(listener)
    return () => {
      this.noticeListeners.delete(listener)
    }
  }

  /**
   * Reads the session's events as they go by, the live ones and a resumed
   * session's recorded history alike: an Edit or a Write becomes a diff, a
   * session under a new id starts the list over.
   */
  observe(event: AgentEvent): void {
    if (event.type === 'started') {
      this.cwd = event.cwd
      if (this.sessionId !== event.sessionId) {
        this.sessionId = event.sessionId
        this.diffs.length = 0
      }
      return
    }
    if (event.type !== 'tool-use') return
    const diff = parseDiff(event, this.diffs.length + 1)
    if (diff !== null) this.diffs.push(diff)
  }

  /** Every diff of the session, oldest first. */
  list(): readonly SessionDiff[] {
    return [...this.diffs]
  }

  /** The diff the current buffer shows, or null when the current buffer is not a diff. */
  get current(): SessionDiff | null {
    const current = this.buffers.current
    if (current === null || current.kind !== 'diff') return null
    for (const [diffId, bufferId] of this.openBuffers) {
      if (bufferId === current.id) return this.diffs.find((diff) => diff.id === diffId) ?? null
    }
    return null
  }

  /** Opens the diff in a buffer, or switches to the buffer it is already in, and gives it the point. */
  show(diffId: string): BufferInfo {
    const diff = this.diffs.find((candidate) => candidate.id === diffId)
    if (diff === undefined) throw new CommandError(`No diff with id "${diffId}" in this session`)
    const openId = this.openBuffers.get(diff.id)
    const buffer =
      (openId === undefined ? undefined : this.buffers.get(openId)) ??
      this.buffers.create({ kind: 'diff', title: diffTitle(diff), elementId: DIFF_ELEMENT_ID })
    this.openBuffers.set(diff.id, buffer.id)
    // The window gets the content before the point moves to it.
    for (const listener of [...this.shownListeners]) listener({ bufferId: buffer.id, diff })
    this.buffers.switchTo(buffer.id)
    return buffer
  }

  /**
   * `C-c C-o`: hands the current diff's file to the system, after a yes.
   * Resolves true only when the system was given the path. A path that is
   * not a file inside the session folder is refused with a notice, and no
   * question is asked.
   */
  async openCurrent(): Promise<boolean> {
    const diff = this.current
    if (diff === null) throw new CommandError('The current buffer is not a diff')
    const path = diff.filePath
    const shown = displayPath(path)
    if (!isAbsolute(path) || !isRegularFile(path)) {
      this.notify(`Not opened: ${shown} is not a file on disk`)
      return false
    }
    if (this.cwd === null || !insideSessionFolder(this.cwd, path)) {
      this.notify(`Not opened: ${shown} is not inside the session folder`)
      return false
    }
    let yes = false
    try {
      yes = await this.options.confirm(`Open ${shown} with the default application?`)
    } catch (error) {
      console.error('diff: the confirmation failed:', error)
    }
    if (!yes) {
      this.notify(`Not opened: ${shown}; nothing was launched (SECURITY.org, promise 2)`)
      return false
    }
    let failure: string
    try {
      failure = await this.options.open(path)
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error)
    }
    if (failure.length > 0) {
      this.notify(`The system could not open ${shown}: ${displayPath(failure)}`)
      return false
    }
    this.notify(`Opened ${shown} with the default application`)
    return true
  }

  private notify(text: string): void {
    const event: AgentNoticeEvent = { type: 'notice', text }
    for (const listener of [...this.noticeListeners]) listener(event)
  }
}
