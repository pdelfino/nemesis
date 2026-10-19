/**
 * The request table of the page-script door (ADR 0009, #130, SECURITY.org T1
 * and T4): the two channels, the closed set of request names, and for each
 * name the schema its answer must parse against in main.
 *
 * Main sends `{ id, name }` to a page buffer's top frame on the request
 * channel; the page preload (src/preload/page.ts) answers `{ id, name, data }`
 * on the reply channel, and main keeps the answer only when it parses here
 * whole. A consumer adds a name and its schema to `PAGE_ANSWERS`, never a
 * channel. Version 1 ships one name, `ping`, so the door is testable before
 * a consumer exists.
 */

/** Main to the page preload: `{ id, name }`, no code and no free text. */
export const PAGE_DOOR_REQUEST_CHANNEL = 'nemesis:page-door-request'

/** The page preload to main: `{ id, name, data }`. */
export const PAGE_DOOR_REPLY_CHANNEL = 'nemesis:page-door-reply'

/** The longest request id either side accepts; main's are far shorter. */
export const MAX_PAGE_REQUEST_ID = 64

/** The longest URL an answer may carry, the bound page-buffer.ts holds a URL to. */
export const MAX_PAGE_URL = 8192

/** The longest title an answer may carry, the bound page-buffer.ts holds a title to. */
export const MAX_PAGE_TITLE = 200

/** One field of an answer: a bounded string or a finite number in a range. */
export type PageField =
  | { readonly kind: 'string'; readonly max: number }
  | { readonly kind: 'number'; readonly min: number; readonly max: number }

/** `ping`: the document's URL and title, as the page's isolated world reads them. */
export interface PingAnswer {
  readonly url: string
  readonly title: string
}

/** What each request name answers. */
export interface PageAnswers {
  readonly ping: PingAnswer
}

export type PageRequestName = keyof PageAnswers

/** The schema of each name's answer: every field, and no field beyond these. */
export const PAGE_ANSWERS: {
  readonly [N in PageRequestName]: { readonly [K in keyof PageAnswers[N]]: PageField }
} = Object.freeze({
  ping: Object.freeze({
    url: { kind: 'string', max: MAX_PAGE_URL } as const,
    title: { kind: 'string', max: MAX_PAGE_TITLE } as const,
  }),
})

/** What main sends. */
export interface PageRequest {
  readonly id: string
  readonly name: PageRequestName
}

/** A reply's envelope, its `data` not yet parsed. */
export interface PageReplyEnvelope {
  readonly id: string
  readonly name: string
  readonly data: unknown
}

export function isPageRequestName(name: unknown): name is PageRequestName {
  return typeof name === 'string' && Object.hasOwn(PAGE_ANSWERS, name)
}

/** A plain object with exactly these keys, or a throw. */
function exactly(value: unknown, keys: readonly string[], what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${what} is not an object`)
  }
  const proto = Object.getPrototypeOf(value) as unknown
  if (proto !== Object.prototype && proto !== null) throw new TypeError(`${what} is not plain`)
  const own = Reflect.ownKeys(value)
  if (own.length !== keys.length || !keys.every((key) => own.includes(key))) {
    throw new TypeError(`${what} has fields beyond its schema`)
  }
  return value as Record<string, unknown>
}

/** A reply's envelope: `id`, `name` and `data`, nothing else. Throws on anything but that. */
export function parsePageReplyEnvelope(payload: unknown): PageReplyEnvelope {
  const value = exactly(payload, ['id', 'name', 'data'], 'The reply')
  const { id, name, data } = value
  if (typeof id !== 'string' || id.length === 0 || id.length > MAX_PAGE_REQUEST_ID) {
    throw new TypeError('The reply has no usable id')
  }
  if (typeof name !== 'string' || name.length > MAX_PAGE_REQUEST_ID) {
    throw new TypeError('The reply has no usable name')
  }
  return { id, name, data }
}

function parseField(value: unknown, field: PageField, key: string): string | number {
  if (field.kind === 'string') {
    if (typeof value !== 'string') throw new TypeError(`${key} is not a string`)
    if (value.length > field.max) throw new TypeError(`${key} is longer than ${field.max}`)
    return value
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`${key} is not a finite number`)
  }
  if (value < field.min || value > field.max) throw new TypeError(`${key} is out of range`)
  return value
}

/**
 * The answer to `name`, parsed whole against its schema: every field
 * present, none beyond, each in bounds. Throws on any violation; a caller
 * never sees part of an answer.
 */
export function parsePageAnswer<N extends PageRequestName>(name: N, data: unknown): PageAnswers[N] {
  const schema = PAGE_ANSWERS[name] as Readonly<Record<string, PageField>>
  const keys = Object.keys(schema)
  const value = exactly(data, keys, `The answer to ${name}`)
  const parsed: Record<string, string | number> = {}
  for (const key of keys) {
    const field = schema[key]
    if (field === undefined) throw new TypeError(`${key} has no schema`)
    parsed[key] = parseField(value[key], field, key)
  }
  return parsed as unknown as PageAnswers[N]
}
