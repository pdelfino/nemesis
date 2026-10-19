import { app, ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron'
import type { InvokeAnswer, InvokeChannel, InvokePayload } from '../shared/ipc'
import { INTERNAL_ORIGIN } from './security/internal-scheme'
import { warnLimited } from './security/warn-limited'

/**
 * The one door from a page into privileged code (#53, SECURITY.org T1).
 *
 * Every invoke channel is registered through `handle()`, which checks the
 * sender before anything else and validates the payload before the handler
 * sees it. A call that fails either check is dropped: it is logged by channel
 * name and sender origin, never by payload, and the caller gets a rejection
 * with no data in it.
 */

/**
 * Where internal pages are served from: the privileged nemesis://app origin
 * (#50). Nothing on file:// is internal any more, the cockpit included.
 */
export const INTERNAL_ORIGINS: readonly string[] = Object.freeze([INTERNAL_ORIGIN])

/** A payload parser: shape only, no trust. Throws on anything but the shape. */
export type Parser<T> = (payload: unknown) => T

/** For a channel the renderer invokes with no argument. */
export function parseNothing(payload: unknown): undefined {
  if (payload !== undefined) throw new TypeError('This channel takes no payload')
  return undefined
}

/**
 * Whether a top frame at this URL is an internal page. The Vite dev server
 * counts only in a development run, when electron-vite set
 * ELECTRON_RENDERER_URL; a packaged app ignores the variable.
 */
export function isInternalPage(url: string, devServerUrl?: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (devServerUrl !== undefined && devServerUrl.length > 0 && url.startsWith(devServerUrl)) {
    return true
  }
  return INTERNAL_ORIGINS.includes(originOf(parsed))
}

/**
 * Scheme and host, port included. Spelled out instead of `URL.origin`, which
 * is the string "null" for file: and for any custom scheme such as nemesis:.
 */
function originOf(parsed: URL): string {
  return `${parsed.protocol}//${parsed.host}`
}

/** The frame fields the sender check reads; WebFrameMain satisfies it. */
export interface SenderFrame {
  readonly url: string
  readonly parent: SenderFrame | null
}

/**
 * The URL of the sender when it is a live top frame, else null. A subframe
 * is never an internal page, whatever it is served from, and a frame that
 * was disposed between the send and the handler throws on every read.
 */
export function topFrameUrl(frame: SenderFrame | null | undefined): string | null {
  if (frame === null || frame === undefined) return null
  try {
    return frame.parent === null ? frame.url : null
  } catch {
    return null
  }
}

/** The origin of a sender, for the log: scheme and host, never path or query. */
export function describeOrigin(url: string | null): string {
  if (url === null) return 'no top frame'
  try {
    return originOf(new URL(url))
  } catch {
    return 'an unparseable URL'
  }
}

function devServerUrl(): string | undefined {
  const url = process.env['ELECTRON_RENDERER_URL']
  return !app.isPackaged && url !== undefined && url.length > 0 ? url : undefined
}

/**
 * The listener `handle()` registers, on its own so the unit tests can run it
 * with a fake event. The order is the control: sender first, then shape,
 * then the handler.
 */
export function guard<C extends InvokeChannel>(
  channel: C,
  parse: Parser<InvokePayload<C>>,
  run: (payload: InvokePayload<C>) => InvokeAnswer<C> | Promise<InvokeAnswer<C>>,
  devServer: string | undefined = devServerUrl(),
): (event: Pick<IpcMainInvokeEvent, 'senderFrame'>, payload: unknown) => Promise<InvokeAnswer<C>> {
  return async (event, payload) => {
    const sender = topFrameUrl(event.senderFrame)
    if (sender === null || !isInternalPage(sender, devServer)) {
      warnLimited(`ipc ${channel}`, `ipc: dropped ${channel} from ${describeOrigin(sender)}`)
      throw new Error(`Rejected ${channel}: the sender is not an internal page`)
    }
    let parsed: InvokePayload<C>
    try {
      parsed = parse(payload)
    } catch (error) {
      warnLimited(
        `ipc ${channel}`,
        `ipc: dropped ${channel} from ${describeOrigin(sender)}: payload rejected`,
      )
      throw error
    }
    return run(parsed)
  }
}

/** Registers a privileged handler behind the sender check and the parser. */
export function handle<C extends InvokeChannel>(
  channel: C,
  parse: Parser<InvokePayload<C>>,
  run: (payload: InvokePayload<C>) => InvokeAnswer<C> | Promise<InvokeAnswer<C>>,
): void {
  ipcMain.handle(channel, guard(channel, parse, run))
}

/** The handler of each window for a channel, keyed by the id of its WebContents (#70). */
const perWindow = new Map<string, Map<number, (payload: never) => unknown>>()

/**
 * Registers a handler for one window (#70). The channel itself is registered
 * once, through the same sender check and parser as `handle()`; the call then
 * goes to the handler of the window that sent it, found by `event.sender`,
 * and a window with none is refused. The handler goes when its window does.
 */
export function handleIn<C extends InvokeChannel>(
  owner: WebContents,
  channel: C,
  parse: Parser<InvokePayload<C>>,
  run: (payload: InvokePayload<C>) => InvokeAnswer<C> | Promise<InvokeAnswer<C>>,
): void {
  let owners = perWindow.get(channel)
  if (owners === undefined) {
    const table = new Map<number, (payload: never) => unknown>()
    perWindow.set(channel, table)
    ipcMain.handle(channel, (event, payload) =>
      guard(channel, parse, (parsed) => {
        const handler = table.get(event.sender.id) as
          ((payload: InvokePayload<C>) => InvokeAnswer<C> | Promise<InvokeAnswer<C>>) | undefined
        if (handler === undefined) {
          throw new Error(`Rejected ${channel}: the sender has no cockpit`)
        }
        return handler(parsed)
      })(event, payload),
    )
    owners = table
  }
  const id = owner.id
  const table = owners
  table.set(id, run as (payload: never) => unknown)
  owner.once('destroyed', () => table.delete(id))
}
