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
 * before a consumer existed; the semantic view (#122) adds `snapshot`, and
 * hint mode (#123) adds `hints` and `hints-show`, reader mode (#128)
 * adds `reader`, the form guide (#94) adds `form`, and the MCP page tier
 * (#138) adds `text`.
 *
 * A request may carry `args`, numbers only (ADR 0009: "arguments, where one
 * exists, are numbers or ref ids main itself issued"): never code, never
 * text a page wrote. `hints-show` takes labels as code points, `form`
 * takes one number, the change count main last saw, and `text` takes three:
 * the element's number, the first character and how many.
 */

/** Main to the page preload: `{ id, name }`, no code and no free text. */
export const PAGE_DOOR_REQUEST_CHANNEL = 'nemesis:page-door-request'

/** The page preload to main: `{ id, name, data }`. */
export const PAGE_DOOR_REPLY_CHANNEL = 'nemesis:page-door-reply'

/** The longest request id either side accepts; main's are far shorter. */
export const MAX_PAGE_REQUEST_ID = 64

/** The most numbers one request's `args` may hold. */
export const MAX_PAGE_REQUEST_ARGS = 4096

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

/**
 * The most elements one hint read carries, and so the most labels one draw
 * shows (#123). A page with more in its viewport is cut, in document order.
 */
export const MAX_HINTS = 500

/** The longest hint label, in characters. */
export const MAX_HINT_LABEL = 6

/**
 * The characters a hint label is made of: what the `hint` keymap layer binds
 * (#123), so the `hints.alphabet` setting is a choice among these.
 */
export const HINT_CHARACTERS = 'abcdefghijklmnopqrstuvwxyz0123456789'

/**
 * One element hint mode can label (#123): the preload's number for it, the
 * same number the snapshot gives it, so `formatRef` makes the same ref of
 * both; a link's absolute URL, empty on every other element; its rectangle
 * in the viewport, where the label goes.
 */
export interface HintNode {
  readonly id: number
  readonly href: string
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/** `hints`: the interactive elements in the viewport, in document order. */
export interface HintsAnswer {
  readonly nodes: readonly HintNode[]
}

/** One label as the overlay drew it, its rectangle in the viewport. */
export interface DrawnLabel {
  readonly id: number
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/** `hints-show`: the labels the overlay holds now; none once it is cleared. */
export interface HintsShowAnswer {
  readonly labels: readonly DrawnLabel[]
}

/** What a block of a reader view is (#128): a heading, a paragraph, a list item, a quote, a code block. */
export const READER_KINDS = ['heading', 'paragraph', 'item', 'quote', 'code'] as const

export type ReaderKind = (typeof READER_KINDS)[number]

/** The most blocks one reader answer carries; a page past it is cut, in document order. */
export const MAX_READER_BLOCKS = 2000

/** The longest text one block carries. */
export const MAX_READER_TEXT = 4000

/** The most links one reader answer numbers as footnotes. */
export const MAX_READER_LINKS = 500

/** The deepest a list item nests. */
export const MAX_READER_DEPTH = 8

/**
 * One block of a page's main text (#128): plain text, never HTML. A link in
 * the text is followed by its footnote mark, `[n]`, the n-th of the answer's
 * links. `level` is a heading's level, 1 to 6, or a list item's depth, 1 to
 * MAX_READER_DEPTH; 0 on every other kind.
 */
export interface ReaderBlock {
  readonly kind: ReaderKind
  readonly level: number
  readonly text: string
}

/** A link of the reader view, the target of a footnote mark: its absolute URL. */
export interface ReaderLink {
  readonly href: string
}

/** `reader`: the page's title and main text, stripped of chrome (#128). */
export interface ReaderAnswer {
  readonly title: string
  readonly blocks: readonly ReaderBlock[]
  readonly links: readonly ReaderLink[]
}

/**
 * What a field of a form is (#94): the input types the guide tells apart,
 * a select, a text area, and `other` for any type the list does not name.
 */
export const FORM_KINDS = [
  'text',
  'email',
  'tel',
  'url',
  'number',
  'date',
  'datetime',
  'month',
  'time',
  'password',
  'select',
  'textarea',
  'checkbox',
  'radio',
  'file',
  'other',
] as const

export type FormKind = (typeof FORM_KINDS)[number]

/** The flags of a form field, one bit each of its `flags`, in this order. */
export const FORM_FLAGS = [
  'required',
  /** Holds a value, a checked box or a chosen file; for a masked field, the only thing said of its value. */
  'filled',
  /** A secret (src/shared/form-snapshot.ts): its value never leaves the page's isolated world. */
  'masked',
  'disabled',
  'readonly',
  /** The browser or the page says the value is wrong, after the human touched it. */
  'invalid',
  'checked',
] as const

export type FormFlag = (typeof FORM_FLAGS)[number]

/** The most fields one form answer carries; a page past it is cut, in document order. */
export const MAX_FORM_FIELDS = 300

/** The most alerts (role=alert, aria-live=assertive) one form answer carries. */
export const MAX_FORM_ALERTS = 20

/**
 * One field of a form, as the page preload read it (#94). `id` is the
 * preload's number for the element, the one the semantic view's snapshot
 * gives it (#122), so main makes the same ref of both. Every string is
 * page content. `value` is empty on a masked field, a box, a radio and a
 * file: `flags` says whether those are filled or checked.
 */
export interface FormField {
  readonly id: number
  readonly kind: FormKind
  readonly label: string
  /** The `name` attribute, what the form submits the field under. */
  readonly name: string
  readonly placeholder: string
  /** A select's options, ` | ` between them; empty on every other kind. */
  readonly choices: string
  /** The validation message, when `invalid` is set. */
  readonly message: string
  readonly value: string
  /** One bit per entry of FORM_FLAGS. */
  readonly flags: number
}

/** An alert the page shows: an error banner or a live message. */
export interface FormAlert {
  readonly text: string
}

/**
 * `form` (#94): the page's form fields, the focused one, and the alerts. The
 * preload's observer counts every change to the document, focus and typing
 * included, in `version`; asked with the count main last saw and nothing
 * changed since, it answers `same` 1 with no fields, so a watch that polls
 * reads the DOM only when something moved.
 */
export interface FormAnswer {
  readonly version: number
  readonly same: number
  /** The focused field's element number, 0 when no field of the answer has the focus. */
  readonly focused: number
  readonly fields: readonly FormField[]
  readonly alerts: readonly FormAlert[]
}

/** The most characters one `text` answer carries; a longer text is read in pieces. */
export const MAX_TEXT_CHARS = 50_000

/**
 * What a `text` read found: the element's text, a secret it refused before
 * reading any value, or no element under that number in this document.
 */
export const TEXT_STATUSES = ['ok', 'masked', 'gone'] as const

export type TextStatus = (typeof TEXT_STATUSES)[number]

/**
 * `text` (#138): one element's text, as `browser_read_text` reads it by ref.
 * `total` is the whole text's length, so main knows whether more follows;
 * `text` is the slice asked for. Both are empty and 0 unless `status` is `ok`.
 */
export interface TextAnswer {
  readonly status: TextStatus
  readonly total: number
  readonly text: string
}

/** What each request name answers. */
export interface PageAnswers {
  readonly ping: PingAnswer
  readonly snapshot: SnapshotAnswer
  readonly hints: HintsAnswer
  readonly 'hints-show': HintsShowAnswer
  readonly reader: ReaderAnswer
  readonly form: FormAnswer
  readonly text: TextAnswer
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
  hints: Object.freeze({
    nodes: {
      kind: 'list',
      max: MAX_HINTS,
      item: Object.freeze({
        id: { kind: 'number', min: 1, max: Number.MAX_SAFE_INTEGER, integer: true } as const,
        href: { kind: 'string', max: MAX_PAGE_URL } as const,
        x: { kind: 'number', min: -MAX_PAGE_EXTENT, max: MAX_PAGE_EXTENT } as const,
        y: { kind: 'number', min: -MAX_PAGE_EXTENT, max: MAX_PAGE_EXTENT } as const,
        width: { kind: 'number', min: 0, max: MAX_PAGE_EXTENT } as const,
        height: { kind: 'number', min: 0, max: MAX_PAGE_EXTENT } as const,
      }),
    } as const,
  }),
  'hints-show': Object.freeze({
    labels: {
      kind: 'list',
      max: MAX_HINTS,
      item: Object.freeze({
        id: { kind: 'number', min: 1, max: Number.MAX_SAFE_INTEGER, integer: true } as const,
        x: { kind: 'number', min: -MAX_PAGE_EXTENT, max: MAX_PAGE_EXTENT } as const,
        y: { kind: 'number', min: -MAX_PAGE_EXTENT, max: MAX_PAGE_EXTENT } as const,
        width: { kind: 'number', min: 0, max: MAX_PAGE_EXTENT } as const,
        height: { kind: 'number', min: 0, max: MAX_PAGE_EXTENT } as const,
      }),
    } as const,
  }),
  reader: Object.freeze({
    title: { kind: 'string', max: MAX_PAGE_TITLE } as const,
    blocks: {
      kind: 'list',
      max: MAX_READER_BLOCKS,
      item: Object.freeze({
        kind: { kind: 'enum', values: READER_KINDS } as const,
        level: { kind: 'number', min: 0, max: MAX_READER_DEPTH, integer: true } as const,
        text: { kind: 'string', max: MAX_READER_TEXT } as const,
      }),
    } as const,
    links: {
      kind: 'list',
      max: MAX_READER_LINKS,
      item: Object.freeze({
        href: { kind: 'string', max: MAX_PAGE_URL } as const,
      }),
    } as const,
  }),
  form: Object.freeze({
    version: { kind: 'number', min: 0, max: Number.MAX_SAFE_INTEGER, integer: true } as const,
    same: { kind: 'number', min: 0, max: 1, integer: true } as const,
    focused: { kind: 'number', min: 0, max: Number.MAX_SAFE_INTEGER, integer: true } as const,
    fields: {
      kind: 'list',
      max: MAX_FORM_FIELDS,
      item: Object.freeze({
        id: { kind: 'number', min: 1, max: Number.MAX_SAFE_INTEGER, integer: true } as const,
        kind: { kind: 'enum', values: FORM_KINDS } as const,
        label: { kind: 'string', max: MAX_NODE_TEXT } as const,
        name: { kind: 'string', max: MAX_NODE_TEXT } as const,
        placeholder: { kind: 'string', max: MAX_NODE_TEXT } as const,
        choices: { kind: 'string', max: MAX_NODE_TEXT } as const,
        message: { kind: 'string', max: MAX_NODE_TEXT } as const,
        value: { kind: 'string', max: MAX_NODE_TEXT } as const,
        flags: {
          kind: 'number',
          min: 0,
          max: 2 ** FORM_FLAGS.length - 1,
          integer: true,
        } as const,
      }),
    } as const,
    alerts: {
      kind: 'list',
      max: MAX_FORM_ALERTS,
      item: Object.freeze({
        text: { kind: 'string', max: MAX_NODE_TEXT } as const,
      }),
    } as const,
  }),
  text: Object.freeze({
    status: { kind: 'enum', values: TEXT_STATUSES } as const,
    total: { kind: 'number', min: 0, max: Number.MAX_SAFE_INTEGER, integer: true } as const,
    text: { kind: 'string', max: MAX_TEXT_CHARS } as const,
  }),
})

/** What main sends. */
export interface PageRequest {
  readonly id: string
  readonly name: PageRequestName
  /** Numbers only, at most MAX_PAGE_REQUEST_ARGS; absent on a name that takes none. */
  readonly args?: readonly number[]
}

/** A request's `args`: absent, or a list of whole numbers in the safe range. Throws on anything else. */
export function parsePageRequestArgs(args: unknown): readonly number[] {
  if (args === undefined) return []
  if (!Array.isArray(args) || args.length > MAX_PAGE_REQUEST_ARGS) {
    throw new TypeError('The request has no usable args')
  }
  for (const one of args as unknown[]) {
    if (typeof one !== 'number' || !Number.isSafeInteger(one)) {
      throw new TypeError('The request has an arg that is not a whole number')
    }
  }
  return args as readonly number[]
}

/** A label to draw over the element the preload numbered `id`. */
export interface HintLabel {
  readonly id: number
  readonly label: string
}

/**
 * The labels as `hints-show`'s args: for each, the element's number, the
 * label's length, then its characters as code points, so the request
 * carries numbers and no text. Throws on a label outside HINT_CHARACTERS.
 */
export function encodeHintLabels(labels: readonly HintLabel[]): readonly number[] {
  if (labels.length > MAX_HINTS) throw new TypeError(`More than ${MAX_HINTS} labels`)
  const args: number[] = []
  for (const { id, label } of labels) {
    if (!Number.isSafeInteger(id) || id < 1) throw new TypeError('A label has no usable element')
    if (label.length === 0 || label.length > MAX_HINT_LABEL) {
      throw new TypeError('A label has no usable length')
    }
    args.push(id, label.length)
    for (const character of label) {
      if (!HINT_CHARACTERS.includes(character))
        throw new TypeError('A label is not hint characters')
      args.push(character.charCodeAt(0))
    }
  }
  return args
}

/** `hints-show`'s args read back, as the page preload reads them. Throws on anything malformed. */
export function decodeHintLabels(args: readonly number[]): readonly HintLabel[] {
  const labels: HintLabel[] = []
  let at = 0
  while (at < args.length) {
    const id = args[at]
    const length = args[at + 1]
    if (id === undefined || id < 1 || length === undefined) {
      throw new TypeError('The labels are cut short')
    }
    if (length < 1 || length > MAX_HINT_LABEL || at + 2 + length > args.length) {
      throw new TypeError('A label has no usable length')
    }
    let label = ''
    for (const code of args.slice(at + 2, at + 2 + length)) {
      const character = String.fromCharCode(code)
      if (!HINT_CHARACTERS.includes(character))
        throw new TypeError('A label is not hint characters')
      label += character
    }
    labels.push({ id, label })
    if (labels.length > MAX_HINTS) throw new TypeError(`More than ${MAX_HINTS} labels`)
    at += 2 + length
  }
  return labels
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
