/**
 * The pages a config defines (#181): their URL shape and the one message a
 * button on one sends. Shared by main, which serves the pages and runs the
 * command, and the page preload, which turns a click into the message.
 *
 * A user page lives at `nemesis://app/user/<name>?<params>`. Its name is
 * kebab-case, the shape of a command name, so `page-<name>` is a command
 * name too. A button is `<button data-command="<command>">`; the message
 * carries that one name and nothing else of the page.
 */

/**
 * The internal scheme and host, spelled here because shared code imports no
 * main code; tests/unit/internal-scheme.test.ts holds them to
 * INTERNAL_SCHEME and INTERNAL_HOST.
 */
export const USER_PAGE_SCHEME = 'nemesis:'
export const USER_PAGE_HOST = 'app'

/** The longest user page URL; a longer one names no page. */
export const MAX_USER_PAGE_URL = 8192

/** The path every user page is under, on the internal origin. */
export const USER_PAGE_PATH = '/user/'

/** The channel a click on a user page's button is sent on, page preload to main. */
export const USER_PAGE_COMMAND_CHANNEL = 'nemesis:user-page-command'

/** The longest page name, and the longest command name a button may carry. */
export const MAX_USER_PAGE_NAME = 64

/** A page title longer than this is refused; a title is one line. */
export const MAX_USER_PAGE_TITLE = 200

/** Kebab-case, as a command name is (registry.ts). */
export const USER_PAGE_NAME = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/

/** Whether `name` is a page name, or a command name a button may carry. */
export function isUserPageName(name: unknown): name is string {
  return typeof name === 'string' && name.length <= MAX_USER_PAGE_NAME && USER_PAGE_NAME.test(name)
}

/**
 * A button's message as main reads it: exactly `{ command }`, the command a
 * kebab-case name. Throws on anything else; the caller drops the message.
 */
export function parseUserPageCommand(payload: unknown): string {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new TypeError('A button sends { command }')
  }
  const keys = Object.keys(payload)
  if (keys.length !== 1 || keys[0] !== 'command') throw new TypeError('A button sends { command }')
  const command = (payload as { command?: unknown }).command
  if (!isUserPageName(command)) throw new TypeError('A button names a command in kebab-case')
  return command
}

/** A user page URL read: the page's name and its query, one value per key. */
export interface UserPageRequest {
  readonly name: string
  readonly params: Readonly<Record<string, string>>
}

/**
 * The user page a URL names, or null when it names none. The path is read
 * as sent, not decoded: a name is kebab-case, so a percent sign, a dot or a
 * second slash after `/user/` is no page, and no traversal can be spelled.
 */
export function parseUserPageUrl(url: string): UserPageRequest | null {
  if (url.length > MAX_USER_PAGE_URL) return null
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== USER_PAGE_SCHEME || parsed.host !== USER_PAGE_HOST) return null
  if (!parsed.pathname.startsWith(USER_PAGE_PATH)) return null
  const name = parsed.pathname.slice(USER_PAGE_PATH.length)
  if (!isUserPageName(name)) return null
  const params: Record<string, string> = {}
  for (const [key, value] of parsed.searchParams) if (!(key in params)) params[key] = value
  return Object.freeze({ name, params: Object.freeze(params) })
}
