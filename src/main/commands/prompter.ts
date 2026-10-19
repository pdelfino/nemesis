import type {
  PaletteAnswer,
  PaletteCandidate,
  PaletteOutcome,
  PaletteRequest,
} from '../../shared/palette'
import { MAX_QUERY_LENGTH } from '../../shared/palette'
import { CommandError } from './registry'

/**
 * The prompter (#65): how a command in the main process asks the user to pick
 * one thing from many. It is the seed of the Nyxt prompt buffer, where every
 * command that needs an argument reads it from the same fuzzy prompt.
 *
 * Sources are pluggable: `commands` and `buffers` in M1, sessions, URLs and
 * history later (M2, M4). A source lists candidates when a read starts; the
 * renderer ranks them as the query grows and answers with one id or null.
 * The consumer given to `read` is what happens with the answer, and what it
 * returns goes back to the window, so a command the palette ran is acted on
 * there like a command a key ran.
 *
 * Plain data, no Electron types, like the buffer registry: the unit tests
 * drive it directly and src/main/commands/palette-bridge.ts wires it to the
 * window. One read at a time: a new read cancels the one before it.
 */

export interface PaletteSource {
  readonly name: string
  candidates(): readonly PaletteCandidate[]
}

export interface ReadSpec {
  readonly source: string
  /** The words before the query: `M-x`, `Describe command:`. */
  readonly prompt: string
  /**
   * Called when the read ends without a choice: `C-g`, or a newer read
   * taking its place. A confirmation (#51) needs the no as much as the yes.
   */
  readonly onCancel?: (() => void) | undefined
  /**
   * The text typed is an answer too (#69): `RET` hands it to the consumer
   * when it matches no candidate. A search reads its query this way, over a
   * source that lists nothing.
   */
  readonly freeText?: true | undefined
  /**
   * A yes or no of confirm.ts: the user's to give, so it always goes to the
   * window, even inside a run whose reads are answered in advance (#28).
   */
  readonly confirm?: true | undefined
}

/** What to do with the choice. Not called on a cancel. */
export type PaletteConsumer = (
  choice: string,
) => Promise<PaletteOutcome | void> | PaletteOutcome | void

export type PaletteListener = (request: PaletteRequest) => void

/**
 * The answers an MCP client gave with `cockpit_run_command` (ADR 0008), taken
 * by the run's reads in order instead of the keyboard.
 */
interface Script {
  readonly answers: string[]
  readonly pending: Promise<void>[]
  failure: Error | null
}

interface PendingRead {
  readonly request: PaletteRequest
  readonly consume: PaletteConsumer
  readonly cancel: (() => void) | undefined
}

export class Prompter {
  private readonly sources = new Map<string, PaletteSource>()
  private readonly listeners = new Set<PaletteListener>()
  private current: PendingRead | null = null
  private counter = 0
  private script: Script | null = null

  addSource(source: PaletteSource): void {
    if (this.sources.has(source.name)) {
      throw new CommandError(`Palette source "${source.name}" is already registered`)
    }
    this.sources.set(source.name, source)
  }

  /** The bridge subscribes and pushes every read to the window. */
  on(listener: PaletteListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** The read in flight, or null. The renderer shows this one. */
  get pending(): PaletteRequest | null {
    return this.current?.request ?? null
  }

  /** Asks the window for a choice. The read before it, if any, is dropped. */
  read(spec: ReadSpec, consume: PaletteConsumer): PaletteRequest {
    const source = this.sources.get(spec.source)
    if (source === undefined) throw new CommandError(`No palette source named "${spec.source}"`)
    this.counter += 1
    const request: PaletteRequest = {
      id: `p${this.counter}`,
      source: source.name,
      prompt: spec.prompt,
      candidates: source.candidates(),
      ...(spec.freeText === true ? { freeText: true as const } : {}),
    }
    if (this.script !== null && spec.confirm !== true) {
      this.readScripted(this.script, request, spec, consume)
      return request
    }
    const dropped = this.current
    this.current = { request, consume, cancel: spec.onCancel }
    dropped?.cancel?.()
    for (const listener of [...this.listeners]) listener(request)
    return request
  }

  /**
   * Runs `run` with its reads answered from `answers`, in order, the way an
   * MCP client's `cockpit_run_command` supplies them (ADR 0008), and waits
   * for every read it started. A read with no answer left, or an answer that
   * is not among the candidates, fails the run with the prompt named, so the
   * client learns what to supply and the window never opens a question the
   * client did not know it was asking. A confirm read is never taken from
   * `answers`: it goes to the window as always.
   */
  async scripted(answers: readonly string[], run: () => void | Promise<void>): Promise<void> {
    if (this.script !== null) throw new CommandError('Another scripted run is in progress')
    const script: Script = { answers: [...answers], pending: [], failure: null }
    this.script = script
    try {
      await run()
      // A consumer may read again, so wait until nothing is left in flight.
      for (let next = script.pending.shift(); next !== undefined; next = script.pending.shift()) {
        await next
      }
    } finally {
      this.script = null
    }
    if (script.failure !== null) throw script.failure
  }

  private readScripted(
    script: Script,
    request: PaletteRequest,
    spec: ReadSpec,
    consume: PaletteConsumer,
  ): void {
    const answer = script.answers.shift()
    const choice = answer === undefined ? null : scriptedChoice(request, answer)
    if (choice === null) {
      script.failure ??= new CommandError(
        answer === undefined
          ? `The command reads "${spec.prompt}" and no answer is left for it`
          : `"${answer}" is not among the candidates of "${spec.prompt}"`,
      )
      spec.onCancel?.()
      return
    }
    script.pending.push(
      Promise.resolve()
        .then(() => consume(choice))
        .then(
          () => undefined,
          (error: unknown) => {
            script.failure ??= error instanceof Error ? error : new CommandError(String(error))
          },
        ),
    )
  }

  /**
   * The window answered. A null choice cancels; an answer to a read that is
   * no longer current is ignored, since the window may still answer a read
   * that a newer one replaced. A choice that is not a candidate is refused,
   * and so is text on a read that did not ask for it.
   */
  async answer(answer: PaletteAnswer): Promise<PaletteOutcome> {
    const read = this.current
    if (read === null || read.request.id !== answer.id) return {}
    this.current = null
    if (answer.text !== undefined) {
      if (read.request.freeText !== true) {
        throw new CommandError('This read takes a candidate, not text')
      }
      return (await read.consume(answer.text)) ?? {}
    }
    if (answer.choice === null) {
      read.cancel?.()
      return {}
    }
    if (!read.request.candidates.some((candidate) => candidate.id === answer.choice)) {
      throw new CommandError(`"${answer.choice}" is not among the candidates`)
    }
    return (await read.consume(answer.choice)) ?? {}
  }
}

/** A scripted answer names a candidate by id or by label; free text is taken as typed. */
function scriptedChoice(request: PaletteRequest, answer: string): string | null {
  const byId = request.candidates.find((candidate) => candidate.id === answer)
  if (byId !== undefined) return byId.id
  const byLabel = request.candidates.find((candidate) => candidate.label === answer)
  if (byLabel !== undefined) return byLabel.id
  return request.freeText === true && answer.length > 0 ? answer : null
}

/** Validates a palette answer that came over IPC. Shape only, no trust. */
export function parsePaletteAnswer(payload: unknown): PaletteAnswer {
  if (typeof payload !== 'object' || payload === null) {
    throw new TypeError('Palette answer is not an object')
  }
  const value = payload as Record<string, unknown>
  const id = value['id']
  const choice = value['choice'] ?? null
  if (typeof id !== 'string' || id.length === 0 || id.length > 32) {
    throw new TypeError('Palette answer has no usable id')
  }
  if (choice !== null && (typeof choice !== 'string' || choice.length > MAX_QUERY_LENGTH)) {
    throw new TypeError('Palette answer has no usable choice')
  }
  const text = value['text']
  if (text === undefined) return { id, choice: choice as string | null }
  if (typeof text !== 'string' || text.length === 0 || text.length > MAX_QUERY_LENGTH) {
    throw new TypeError('Palette answer has no usable text')
  }
  return { id, choice: choice as string | null, text }
}
