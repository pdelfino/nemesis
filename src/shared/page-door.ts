/**
 * The request table of the page-script door (ADR 0009, #130, SECURITY.org T1
 * and T4): the two channels, the closed set of request names, and for each
 * name the schema its answer must parse against in main.
 *
 * Main sends `{ id, name }` to a page buffer's top frame on the request
 * channel; the page preload (src/preload/page.ts) answers `{ id, name, data }`
 * on the reply channel, and main keeps the answer only when it parses here
 * whole. A consumer adds a name and its schema to `PAGE_ANSWERS`, never a
 * channel. Version 1 shipped one name, `ping`, so the door was testable
 * before a consumer existed; the semantic view (#122) adds `snapshot`.
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

/**
 * One field of an answer: a bounded string, a finite number in a range (a
 * whole one when `integer`), one string of a closed list, or a list of
 * records, each a fixed set of fields, capped in length.
 */
export type PageField =
  | { readonly kind: 'string'; readonly max: number }
  | { readonly kind: 'number'; readonly min: number; readonly max: number; readonly integer?: true }
  | { readonly kind: 'enum'; readonly values: readonly string[] }
  | {
      readonly kind: 'list'
      readonly max: number
      readonly item: { readonly [key: string]: PageField }
    }

/** `ping`: the document's URL and title, as the page's isolated world reads them. */
export interface PingAnswer {
  readonly url: string
  readonly title: string
}

/**
 * The roles the semantic view knows (#122, ADR 0009 option A): landmarks,
 * headings, links, buttons and fields, computed by the page preload from the
 * DOM and ARIA. A closed list, so a page cannot name a role of its own.
 */
export const SEMANTIC_ROLES = [
  'banner',
  'navigation',
  'main',
  'contentinfo',
  'complementary',
  'region',
  'form',
  'search',
  'dialog',
  'heading',
  'link',
  'button',
  'textbox',
  'searchbox',
  'checkbox',
  'radio',
  'switch',
  'combobox',
  'slider',
  'spinbutton',
  'tab',
  'menuitem',
  'img',
] as const

export type SemanticRole = (typeof SEMANTIC_ROLES)[number]

/** The states a node may be in, one bit each of a node's `state`, in this order. */
export const SEMANTIC_STATES = [
  'checked',
  'disabled',
  'expanded',
  'collapsed',
  'required',
  'readonly',
  'selected',
  'pressed',
  /** A secret field (a password): its value never crosses the door. */
  'masked',
] as const

export type SemanticState = (typeof SEMANTIC_STATES)[number]

/** The most nodes one snapshot carries; a page past it is cut, in document order. */
export const MAX_SNAPSHOT_NODES = 2000

/** The deepest a node sits under the roots. */
export const MAX_SNAPSHOT_DEPTH = 32

/** The longest name or value a node carries. */
export const MAX_NODE_TEXT = 200

/** How far a rectangle may reach, in CSS pixels of the page, either way. */
export const MAX_PAGE_EXTENT = 10_000_000

/**
 * One node of a snapshot, in document order. `id` is the preload's number
 * for the element, the same for as long as the document lives; main makes
 * the ref of it. `depth` places the node under the last shallower one. The
 * rectangle is in page coordinates, so a scroll does not move it.
 */
export interface SnapshotNode {
  readonly id: number
  readonly depth: number
  readonly role: SemanticRole
  readonly name: string
  readonly value: string
  /** One bit per entry of SEMANTIC_STATES. */
  readonly state: number
  /** A heading's level, 1 to 6; 0 on every other role. */
  readonly level: number
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/** `snapshot`: the page's semantic nodes (#122). */
export interface SnapshotAnswer {
  readonly nodes: readonly SnapshotNode[]
}

/** What each request name answers. */
export interface PageAnswers {
  readonly ping: PingAnswer
  readonly snapshot: SnapshotAnswer
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
  snapshot: Object.freeze({
    nodes: {
      kind: 'list',
      max: MAX_SNAPSHOT_NODES,
      item: Object.freeze({
        id: { kind: 'number', min: 1, max: Number.MAX_SAFE_INTEGER, integer: true } as const,
        depth: { kind: 'number', min: 0, max: MAX_SNAPSHOT_DEPTH, integer: true } as const,
        role: { kind: 'enum', values: SEMANTIC_ROLES } as const,
        name: { kind: 'string', max: MAX_NODE_TEXT } as const,
        value: { kind: 'string', max: MAX_NODE_TEXT } as const,
        state: {
          kind: 'number',
          min: 0,
          max: 2 ** SEMANTIC_STATES.length - 1,
          integer: true,
        } as const,
        level: { kind: 'number', min: 0, max: 6, integer: true } as const,
        x: { kind: 'number', min: -MAX_PAGE_EXTENT, max: MAX_PAGE_EXTENT } as const,
        y: { kind: 'number', min: -MAX_PAGE_EXTENT, max: MAX_PAGE_EXTENT } as const,
        width: { kind: 'number', min: 0, max: MAX_PAGE_EXTENT } as const,
        height: { kind: 'number', min: 0, max: MAX_PAGE_EXTENT } as const,
      }),
    } as const,
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

function parseField(value: unknown, field: PageField, key: string): unknown {
  switch (field.kind) {
    case 'string':
      if (typeof value !== 'string') throw new TypeError(`${key} is not a string`)
      if (value.length > field.max) throw new TypeError(`${key} is longer than ${field.max}`)
      return value
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new TypeError(`${key} is not a finite number`)
      }
      if (value < field.min || value > field.max) throw new TypeError(`${key} is out of range`)
      if (field.integer === true && !Number.isInteger(value)) {
        throw new TypeError(`${key} is not a whole number`)
      }
      return value
    case 'enum':
      if (typeof value !== 'string' || !field.values.includes(value)) {
        throw new TypeError(`${key} is not one of its values`)
      }
      return value
    case 'list': {
      if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
        throw new TypeError(`${key} is not a list`)
      }
      if (value.length > field.max) throw new TypeError(`${key} has more than ${field.max} items`)
      // Every own key an index or `length`: no hole and no field hung on the list.
      if (Reflect.ownKeys(value).length !== value.length + 1) {
        throw new TypeError(`${key} has fields beyond its items`)
      }
      const items: unknown[] = []
      for (let index = 0; index < value.length; index += 1) {
        items.push(parseRecord(field.item, value[index] as unknown, `${key}[${index}]`))
      }
      return items
    }
  }
}

/** A record with exactly the fields of `schema`, each parsed, or a throw. */
function parseRecord(
  schema: { readonly [key: string]: PageField },
  data: unknown,
  what: string,
): Record<string, unknown> {
  const keys = Object.keys(schema)
  const value = exactly(data, keys, what)
  const parsed: Record<string, unknown> = {}
  for (const key of keys) {
    const field = schema[key]
    if (field === undefined) throw new TypeError(`${key} has no schema`)
    parsed[key] = parseField(value[key], field, key)
  }
  return parsed
}

/**
 * The answer to `name`, parsed whole against its schema: every field
 * present, none beyond, each in bounds. Throws on any violation; a caller
 * never sees part of an answer.
 */
export function parsePageAnswer<N extends PageRequestName>(name: N, data: unknown): PageAnswers[N] {
  const schema = PAGE_ANSWERS[name] as { readonly [key: string]: PageField }
  return parseRecord(schema, data, `The answer to ${name}`) as unknown as PageAnswers[N]
}
