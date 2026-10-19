import { ipcRenderer } from 'electron'
import {
  MAX_PAGE_REQUEST_ID,
  MAX_PAGE_TITLE,
  MAX_PAGE_URL,
  PAGE_DOOR_REPLY_CHANNEL,
  PAGE_DOOR_REQUEST_CHANNEL,
  type PageAnswers,
  type PageRequestName,
} from '../shared/page-door'

// The page-script door (ADR 0009, #130, SECURITY.org T1 and T4): the preload
// of page buffers, and of nothing else. It runs sandboxed in Chromium's
// isolated world for the page's top frame, so it shares the DOM with the
// page and nothing more: the page's scripts cannot read these variables or
// replace the built-ins this world reads with.
//
// It gives the page nothing. No contextBridge, no write to window: a page
// looking for a bridge finds the same globals as a page with no preload.
// It answers main and only main, by name, from the fixed table below; a
// request carries no code, and nothing here evaluates text.

/** The parts of the page's document this world reads, typed here because the preload has no DOM library. */
interface PageWorld {
  readonly document: { readonly title: string }
  readonly location: { readonly href: string }
}

const world = globalThis as unknown as PageWorld

/** One handler per request name, fixed at build time; a consumer adds its own (#122, #123, #128, #94). */
const HANDLERS: { readonly [N in PageRequestName]: () => PageAnswers[N] } = Object.freeze({
  ping: () => ({
    url: world.location.href.slice(0, MAX_PAGE_URL),
    title: world.document.title.replace(/\s+/g, ' ').trim().slice(0, MAX_PAGE_TITLE),
  }),
})

ipcRenderer.on(PAGE_DOOR_REQUEST_CHANNEL, (_event, request: unknown) => {
  if (typeof request !== 'object' || request === null) return
  const { id, name } = request as { readonly id?: unknown; readonly name?: unknown }
  if (typeof id !== 'string' || id.length === 0 || id.length > MAX_PAGE_REQUEST_ID) return
  if (typeof name !== 'string' || !Object.hasOwn(HANDLERS, name)) return
  let data: PageAnswers[PageRequestName]
  try {
    data = HANDLERS[name as PageRequestName]()
  } catch {
    // No answer is an answer: main settles the request as an error on its timeout.
    return
  }
  ipcRenderer.send(PAGE_DOOR_REPLY_CHANNEL, { id, name, data })
})
