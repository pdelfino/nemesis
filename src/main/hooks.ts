import { AsyncLocalStorage } from 'node:async_hooks'
import type { BufferInfo } from '../shared/buffers'
import type { AgentPermissionMode } from './agent/events'
import type { PaletteSource, Prompter } from './commands/prompter'
import type { Command, CommandContext } from './commands/registry'
import { CommandError, defineCommand } from './commands/registry'
import type { HelpBuffers } from './help'

/**
 * Cockpit hooks (#165, ADR 0005): a closed list of declared points, each with
 * a typed payload, and named handlers registered at them. There is no advice:
 * nothing here wraps a command's `run` or any other function, a handler only
 * runs where a point is fired.
 *
 * Handlers of a point run oldest first, each awaited with the point's
 * timeout and given an AbortSignal that aborts at it. A handler that throws
 * is reported as a notice and skipped, and stays registered. An observer's
 * return value is ignored; the one interceptor, `before-command`, stops the
 * command on the first veto, and a timeout there is a veto. A point fired
 * from inside one of its own handlers runs nothing and leaves a notice.
 *
 * `before-load` (#179, the ADR 0005 amendment) is the page point: an
 * interceptor answered synchronously through `dispatch`, since a page's own
 * `will-navigate` must be answered before the event returns. Its handlers may
 * block a load or rewrite its URL; the page buffer then puts the answer
 * through the same navigation policy as any URL, so a handler never widens it.
 *
 * This module takes types alone from src/main/agent/ and nothing from
 * src/main/security/ or src/preload/, and no IPC channel carries a hook, so
 * no handler reaches the permission path (tests/unit/hooks.test.ts pins it).
 */

/**
 * The payload of each point. Names, ids, counts and frozen records only:
 * never prompt text, assistant text, tool input or page content, since a
 * payload may be printed when a handler fails.
 */
export interface HookEvents {
  readonly 'after-init': {
    readonly commands: readonly string[]
    readonly buffers: readonly BufferInfo[]
  }
  readonly 'buffer-created': { readonly buffer: BufferInfo }
  readonly 'buffer-switched': { readonly from: BufferInfo | null; readonly to: BufferInfo }
  readonly 'buffer-killed': { readonly buffer: BufferInfo }
  readonly 'before-command': { readonly command: string; readonly context: CommandContext }
  readonly 'after-command': {
    readonly command: string
    readonly context: CommandContext
    readonly ok: boolean
    readonly durationMs: number
  }
  readonly 'session-started': {
    readonly sessionId: string
    readonly model: string
    readonly permissionMode: AgentPermissionMode
  }
  readonly 'turn-ended': {
    readonly sessionId: string | null
    readonly isError: boolean
    readonly durationMs: number
    readonly numTurns: number
  }
  readonly 'before-quit': Record<string, never>
  /**
   * A top-frame load of a page buffer, only of a URL the page policy takes
   * (http: and https:). `from` is `cockpit` for a load the cockpit starts
   * (open-url, a bookmark, a restored page) and `page` for a link or a script
   * of the page; `bufferId` is null when the buffer is not made yet.
   */
  readonly 'before-load': {
    readonly url: string
    readonly bufferId: string | null
    readonly from: 'cockpit' | 'page'
  }
}

export type HookPoint = keyof HookEvents

/** The points `fire` runs; `before-load` is `dispatch`'s alone. */
export type AsyncHookPoint = Exclude<HookPoint, 'before-load'>

/** An interceptor's answer. An observer's return value is ignored. */
export interface Veto {
  readonly veto: true
  readonly reason: string
}

/** A `before-load` answer: load this URL instead, under the same policy. */
export interface Rewrite {
  readonly rewrite: string
}

export type HookResult = Veto | Rewrite | void | undefined

export interface HookHandler<P extends HookPoint> {
  /** Kebab-case, the same rule as a command name; the key for off and list-hooks. */
  readonly name: string
  /** One line, shown by list-hooks and in the failure notice. */
  readonly doc: string
  run(event: HookEvents[P], signal: AbortSignal): HookResult | Promise<HookResult>
}

/** Who registered a handler. Fixed by the API object, never by the handler. */
export type HookSource = 'cockpit' | `mode:${string}` | 'config' | 'repl'

export interface HookPointSpec {
  readonly kind: 'observer' | 'interceptor'
  /** Per handler. Past it, an observer is abandoned and an interceptor vetoes. */
  readonly timeoutMs: number
  /** Answered before the fire site returns, so no timeout applies (`before-load`). */
  readonly synchronous?: true
}

const OBSERVER: HookPointSpec = { kind: 'observer', timeoutMs: 2000 }

export const HOOK_POINTS: Readonly<Record<HookPoint, HookPointSpec>> = {
  'after-init': OBSERVER,
  'buffer-created': OBSERVER,
  'buffer-switched': OBSERVER,
  'buffer-killed': OBSERVER,
  'before-command': { kind: 'interceptor', timeoutMs: 30_000 },
  'after-command': OBSERVER,
  'session-started': OBSERVER,
  'turn-ended': OBSERVER,
  'before-quit': OBSERVER,
  'before-load': { kind: 'interceptor', timeoutMs: 0, synchronous: true },
}

/** One line per point, for describe-hook (#171). */
export const HOOK_POINT_DOCS: Readonly<Record<HookPoint, string>> = {
  'after-init': 'Fired once a window is up, with its commands and buffers.',
  'buffer-created': 'Fired when a buffer is created.',
  'buffer-switched': 'Fired when the point moves to another buffer.',
  'buffer-killed': 'Fired when a buffer is killed.',
  'before-command': 'Fired before a command runs; a handler may veto it with a reason.',
  'after-command': 'Fired after a command ran, with whether it succeeded and how long it took.',
  'session-started': 'Fired when an agent session starts, with its id, model and permission mode.',
  'turn-ended': 'Fired when an agent turn ends, with its outcome, duration and turn count.',
  'before-quit': 'Fired before the app quits.',
  'before-load':
    'Asked before a page buffer loads a URL; a handler may block it or answer another URL, which the page policy checks again.',
}

export interface HookListing {
  readonly point: HookPoint
  readonly name: string
  readonly doc: string
  readonly source: HookSource
}

export class HookError extends Error {
  override readonly name = 'HookError'
}

const HANDLER_NAME = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/

export function isHookPoint(value: unknown): value is HookPoint {
  return typeof value === 'string' && Object.hasOwn(HOOK_POINTS, value)
}

/** A known point and a kebab-case name, as `on` and `off` both take. */
export function checkPointAndName(point: unknown, name: unknown): void {
  if (!isHookPoint(point)) throw new HookError(`No hook point named "${String(point)}"`)
  if (typeof name !== 'string' || !HANDLER_NAME.test(name)) {
    throw new HookError(`Hook handler name "${String(name)}" is not kebab-case`)
  }
}

/** The checks `on` makes, for the config to make them on the file's own line. */
export function checkHandler(point: unknown, name: unknown, doc: unknown, run: unknown): void {
  checkPointAndName(point, name)
  if (typeof doc !== 'string' || doc.trim().length === 0) {
    throw new HookError(`Hook handler "${String(name)}" needs a doc line`)
  }
  if (typeof run !== 'function') throw new HookError(`Hook handler "${String(name)}" needs a run()`)
}

interface Registered {
  readonly source: HookSource
  readonly handler: HookHandler<HookPoint>
}

type Outcome =
  | { readonly kind: 'done'; readonly result: HookResult }
  | { readonly kind: 'failed'; readonly message: string }
  | { readonly kind: 'timed-out' }

export class HookRegistry {
  private readonly handlers = new Map<HookPoint, Registered[]>()
  /**
   * The points whose handlers the current async context is inside. A fire
   * from a handler (or anything it awaits) sees its own point here; a fire
   * from unrelated work, a second window creating a buffer, does not.
   */
  private readonly running = new AsyncLocalStorage<ReadonlySet<HookPoint>>()
  private readonly notify: (text: string) => void

  /**
   * `notify` is the notice sink: the app's notices, which the focused
   * window's transcript shows and its recorder keeps in the session folder.
   */
  constructor(notify: (text: string) => void) {
    this.notify = notify
  }

  on<P extends HookPoint>(point: P, handler: HookHandler<P>, source: HookSource): void {
    checkHandler(point, handler.name, handler.doc, handler.run)
    const list = this.handlers.get(point) ?? []
    if (list.some((entry) => entry.handler.name === handler.name)) {
      throw new HookError(`Hook "${point}" already has a handler named "${handler.name}"`)
    }
    // Oldest first: the order is the order of on().
    list.push({ source, handler: handler as unknown as HookHandler<HookPoint> })
    this.handlers.set(point, list)
  }

  off(point: HookPoint, name: string): boolean {
    const list = this.handlers.get(point) ?? []
    const index = list.findIndex((entry) => entry.handler.name === name)
    if (index === -1) return false
    list.splice(index, 1)
    return true
  }

  /** reload-config drops 'config'; a mode's disable drops 'mode:<name>'. */
  dropSource(source: HookSource): number {
    let dropped = 0
    for (const list of this.handlers.values()) {
      for (let i = list.length - 1; i >= 0; i -= 1) {
        if (list[i]?.source === source) {
          list.splice(i, 1)
          dropped += 1
        }
      }
    }
    return dropped
  }

  /** Whether a point has a handler: a fire site with none skips the await. */
  has(point: HookPoint): boolean {
    return (this.handlers.get(point)?.length ?? 0) > 0
  }

  /** Every handler with its point, in the order of HOOK_POINTS, then registration order. */
  list(): readonly HookListing[] {
    const out: HookListing[] = []
    for (const point of Object.keys(HOOK_POINTS) as HookPoint[]) {
      for (const { source, handler } of this.handlers.get(point) ?? []) {
        out.push({ point, name: handler.name, doc: handler.doc, source })
      }
    }
    return out
  }

  /**
   * The one fire point. Observers: every handler, in order, each awaited
   * with the point's timeout; the return is null. Interceptor: the first
   * veto ends the chain and is returned. A throw is a notice and no change;
   * a timeout is a notice, and for the interceptor a veto. The first
   * handler is called before fire returns, so a synchronous handler of a
   * synchronous fire site has run when the site goes on.
   */
  async fire<P extends AsyncHookPoint>(point: P, event: HookEvents[P]): Promise<Veto | null> {
    const inside = this.running.getStore() ?? new Set<HookPoint>()
    if (inside.has(point)) {
      this.notify(`Hook ${point}: fired while its handlers were running; skipped.`)
      return null
    }
    const spec = HOOK_POINTS[point]
    const context: ReadonlySet<HookPoint> = new Set([...inside, point])
    for (const { source, handler } of [...(this.handlers.get(point) ?? [])]) {
      const outcome = await this.runOne(spec, handler, event, context)
      const label = `Hook ${point}: handler ${handler.name} (${source})`
      if (outcome.kind === 'failed') {
        this.notify(`${label} failed: ${outcome.message}`)
        continue
      }
      if (outcome.kind === 'timed-out') {
        this.notify(`${label} did not answer in ${spec.timeoutMs} ms.`)
        if (spec.kind === 'interceptor') {
          return { veto: true, reason: `${handler.name} did not answer in time` }
        }
        continue
      }
      const result = outcome.result
      if (spec.kind === 'interceptor' && isVeto(result)) {
        this.notify(`${label} refused it: ${result.reason}`)
        return result
      }
    }
    return null
  }

  /**
   * The `before-load` fire point, synchronous: handlers oldest first, and the
   * first veto (a block) or rewrite ends the chain and is returned; null is
   * no change. A throw, a rewrite that is not a string, or an answer that is
   * a promise is a notice and no change. A rewrite is not run through the
   * handlers again, so two rules cannot send a load back and forth.
   */
  dispatch(event: HookEvents['before-load']): Veto | Rewrite | null {
    const point = 'before-load'
    const inside = this.running.getStore() ?? new Set<HookPoint>()
    if (inside.has(point)) {
      this.notify(`Hook ${point}: fired while its handlers were running; skipped.`)
      return null
    }
    const context: ReadonlySet<HookPoint> = new Set([...inside, point])
    for (const { source, handler } of [...(this.handlers.get(point) ?? [])]) {
      const label = `Hook ${point}: handler ${handler.name} (${source})`
      let result: HookResult | Promise<HookResult>
      try {
        result = this.running.run(context, () => handler.run(event, new AbortController().signal))
      } catch (error) {
        this.notify(`${label} failed: ${messageOf(error)}`)
        continue
      }
      if (isThenable(result)) {
        // Settled and dropped: a load cannot wait, and a late rejection is not unhandled.
        Promise.resolve(result).catch(() => undefined)
        this.notify(`${label} answered with a promise; a before-load handler answers at once.`)
        continue
      }
      if (isVeto(result)) {
        this.notify(`${label} blocked a load: ${result.reason}`)
        return result
      }
      if (isRewrite(result)) {
        if (typeof result.rewrite !== 'string') {
          this.notify(`${label} failed: a rewrite is a URL string`)
          continue
        }
        return { rewrite: result.rewrite }
      }
    }
    return null
  }

  private async runOne(
    spec: HookPointSpec,
    handler: HookHandler<HookPoint>,
    event: HookEvents[HookPoint],
    context: ReadonlySet<HookPoint>,
  ): Promise<Outcome> {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | null = null
    const timeout = new Promise<Outcome>((resolve) => {
      timer = setTimeout(() => {
        controller.abort()
        resolve({ kind: 'timed-out' })
      }, spec.timeoutMs)
    })
    try {
      // Called now, inside the point's context, so a fire from the handler is seen as re-entry.
      const returned = this.running.run(context, () => handler.run(event, controller.signal))
      const run = Promise.resolve(returned).then(
        (result): Outcome => ({ kind: 'done', result }),
        (error: unknown): Outcome => ({ kind: 'failed', message: messageOf(error) }),
      )
      return await Promise.race([run, timeout])
    } catch (error) {
      return { kind: 'failed', message: messageOf(error) }
    } finally {
      if (timer !== null) clearTimeout(timer)
    }
  }
}

function isVeto(result: HookResult): result is Veto {
  return typeof result === 'object' && result !== null && 'veto' in result && result.veto === true
}

function isRewrite(result: HookResult): result is Rewrite {
  return typeof result === 'object' && result !== null && 'rewrite' in result
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  )
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** The help buffer's text for list-hooks. */
export function renderHooks(listing: readonly HookListing[]): string {
  if (listing.length === 0) {
    return ['Hooks', '', 'No handler is registered.'].join('\n')
  }
  const lines = ['Hooks', '']
  let point: HookPoint | null = null
  for (const entry of listing) {
    if (entry.point !== point) {
      if (point !== null) lines.push('')
      point = entry.point
      lines.push(`${entry.point} (${HOOK_POINTS[entry.point].kind})`)
    }
    lines.push(`  ${entry.name} (${entry.source}): ${entry.doc}`)
  }
  return lines.join('\n')
}

/** The palette source remove-hook reads from: one candidate per handler, `point name`. */
export const HOOKS_SOURCE = 'hooks'

export function hooksSource(hooks: HookRegistry): PaletteSource {
  return {
    name: HOOKS_SOURCE,
    candidates: () =>
      hooks.list().map((entry) => ({
        id: `${entry.point} ${entry.name}`,
        label: entry.name,
        doc: entry.doc,
        detail: `${entry.point}, ${entry.source}`,
      })),
  }
}

/** What list-hooks and remove-hook say they do, in every window and in the config registry. */
export const HOOK_COMMAND_DOCS = {
  'list-hooks': 'Show every hook handler, by point, with its source and doc line.',
  'remove-hook': 'Remove a hook handler chosen by name.',
} as const

/** list-hooks and remove-hook: what is registered, and taking one handler out by name. */
export function hookCommands(
  hooks: HookRegistry,
  deps: { readonly help: HelpBuffers; readonly prompter: Prompter },
): readonly Command[] {
  return [
    defineCommand({
      name: 'list-hooks',
      mcp: 'free',
      doc: HOOK_COMMAND_DOCS['list-hooks'],
      run: () => {
        deps.help.show(renderHooks(hooks.list()))
      },
    }),
    defineCommand({
      name: 'remove-hook',
      doc: HOOK_COMMAND_DOCS['remove-hook'],
      run: () => {
        deps.prompter.read({ source: HOOKS_SOURCE, prompt: 'Remove hook:' }, (id) => {
          const [point, name] = id.split(' ')
          if (!isHookPoint(point) || name === undefined || !hooks.off(point, name)) {
            throw new CommandError(`No hook handler "${id}"`)
          }
        })
      },
    }),
  ]
}
