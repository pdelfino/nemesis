import type { Command, CommandContext } from '../commands/registry'
import { describeOrigin, topFrameUrl, type SenderFrame } from '../ipc'
import { resolveUserPage, type UserPageRequest } from '../security/internal-scheme'
import { warnLimited } from '../security/warn-limited'
import { parseUserPageCommand, USER_PAGE_COMMAND_CHANNEL } from '../../shared/user-pages'

/**
 * The pages a config defines (#181, row 21 of #163), Nyxt's
 * `define-internal-page-command`: `nemesis.definePage(name, { title, render })`
 * serves `render(params)` at `nemesis://app/user/<name>?<params>` in a page
 * buffer, and `page-<name>` opens it.
 *
 * Two halves live here, neither holding an Electron value:
 *
 * - `renderUserPage` turns a request into the HTML the scheme handler of
 *   internal-scheme.ts answers under USER_PAGE_CSP, so nothing the page
 *   holds runs: the config's render is trusted code, its params are not.
 * - `pressButton` is the main side of the button route. The page preload
 *   sends `{ command }` when the user clicks a `<button data-command>` on a
 *   user page; the message is kept only when the sender is a page buffer
 *   main holds, from its top frame, on a user page URL that is also the
 *   buffer's committed one, and the payload is exactly one kebab-case name.
 *   Anything else is dropped with a rate-limited line naming the channel and
 *   the origin. A name that is no registered command is refused with a
 *   notice. A registered one keeps its own class (ADR 0007): `never` is
 *   refused, `yes` asks in the prompt buffer on every click, `free` runs. It
 *   runs through the registry with the source `user-page`, so the command
 *   hooks fire as for a key.
 */

/** A page of the config, as the loader commits it. */
export interface UserPage {
  readonly name: string
  readonly title: string
  /** The config's render: the params in, the page's HTML out. */
  render(params: Readonly<Record<string, string>>): string
}

/** A render longer than this answers a short page that says so. */
export const MAX_USER_PAGE_HTML = 2_000_000

/** Text as HTML text: the page's title and a failed render's message. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * The HTML of a user page, its title first, or null when the config defines
 * no page of that name. A render that throws or returns no string answers a
 * page that says so, escaped.
 */
export function renderUserPage(
  pages: readonly UserPage[],
  request: UserPageRequest,
): string | null {
  const page = pages.find((one) => one.name === request.name)
  if (page === undefined) return null
  let body: string
  try {
    const html: unknown = page.render({ ...request.params })
    if (typeof html !== 'string') throw new TypeError('render returns an HTML string')
    body =
      html.length <= MAX_USER_PAGE_HTML
        ? html
        : `<p>The page is longer than ${MAX_USER_PAGE_HTML} characters.</p>`
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    body = `<p>The page ${escapeHtml(page.name)} failed: ${escapeHtml(message)}</p>`
  }
  return `<!doctype html>\n<meta charset="utf-8">\n<title>${escapeHtml(page.title)}</title>\n${body}`
}

/** The parts of an IPC event the button route reads; IpcMainEvent satisfies it. */
export interface ButtonEvent {
  readonly sender: { readonly id: number }
  readonly senderFrame: SenderFrame | null | undefined
}

/** The window a page buffer belongs to, as the button route needs it. */
export interface ButtonOwner {
  readonly registry: {
    get(name: string): Command | undefined
    run(name: string, context: CommandContext): Promise<void>
  }
  /** A yes or no in the window's prompt buffer. */
  confirm(question: string): Promise<boolean>
  notice(text: string): void
  /** The page buffer's committed URL (T3), not one the page reports. */
  readonly committedUrl: string | null
}

/** What became of one press, for the tests. */
export type ButtonOutcome = 'dropped' | 'refused' | 'declined' | 'ran' | 'failed'

/**
 * One press of a user page's button. `ownerOf` names the window of a page
 * buffer main holds by its WebContents id, or null for any other sender.
 */
export async function pressButton(
  event: ButtonEvent,
  payload: unknown,
  ownerOf: (contentsId: number) => ButtonOwner | null,
  warn: (key: string, line: string) => void = warnLimited,
): Promise<ButtonOutcome> {
  const sender = topFrameUrl(event.senderFrame)
  const drop = (): ButtonOutcome => {
    warn(
      `ipc ${USER_PAGE_COMMAND_CHANNEL}`,
      `ipc: dropped ${USER_PAGE_COMMAND_CHANNEL} from ${describeOrigin(sender)}`,
    )
    return 'dropped'
  }
  const owner = ownerOf(event.sender.id)
  if (owner === null || sender === null) return drop()
  const page = resolveUserPage(sender)
  const committed = owner.committedUrl === null ? null : resolveUserPage(owner.committedUrl)
  if (page === null || committed === null || committed.name !== page.name) return drop()
  let name: string
  try {
    name = parseUserPageCommand(payload)
  } catch {
    return drop()
  }
  const command = owner.registry.get(name)
  if (command === undefined) {
    owner.notice(`Not run: the page ${page.name} names no command "${name}"`)
    return 'refused'
  }
  const cost = command.mcp ?? 'yes'
  if (cost === 'never') {
    owner.notice(
      `Not run: ${name} answers a question only you can answer; it runs from a key or the palette, never from a page button`,
    )
    return 'refused'
  }
  if (cost === 'yes' && !(await owner.confirm(`Run ${name}, from the page ${page.name}?`))) {
    return 'declined'
  }
  try {
    await owner.registry.run(name, { source: 'user-page', bufferType: 'page' })
    return 'ran'
  } catch (error) {
    owner.notice(`${name}: ${error instanceof Error ? error.message : String(error)}`)
    return 'failed'
  }
}
