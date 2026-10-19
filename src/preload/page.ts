import { ipcRenderer } from 'electron'
import {
  decodeHintLabels,
  MAX_HINTS,
  MAX_NODE_TEXT,
  MAX_PAGE_EXTENT,
  MAX_PAGE_REQUEST_ID,
  MAX_PAGE_TITLE,
  MAX_PAGE_URL,
  MAX_SNAPSHOT_DEPTH,
  MAX_SNAPSHOT_NODES,
  PAGE_DOOR_REPLY_CHANNEL,
  PAGE_DOOR_REQUEST_CHANNEL,
  SEMANTIC_ROLES,
  SEMANTIC_STATES,
  parsePageRequestArgs,
  type DrawnLabel,
  type HintNode,
  type HintsAnswer,
  type HintsShowAnswer,
  type PageAnswers,
  type PageRequestName,
  type ReaderAnswer,
  type SemanticRole,
  type SemanticState,
  type SnapshotAnswer,
  type SnapshotNode,
} from '../shared/page-door'
import { extractReader, type ReaderNode } from '../shared/reader'

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

/** A rectangle as `getBoundingClientRect` reports it. */
interface PageRect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/** The parts of an element the semantic walk reads; form fields carry the optional ones. */
interface PageElement {
  readonly tagName: string
  readonly children: ArrayLike<PageElement>
  readonly textContent: string | null
  readonly innerText?: string
  readonly isContentEditable?: boolean
  readonly type?: string
  readonly value?: unknown
  readonly checked?: unknown
  readonly disabled?: unknown
  readonly required?: unknown
  readonly readOnly?: unknown
  readonly labels?: ArrayLike<PageElement> | null
  readonly selectedOptions?: ArrayLike<PageElement>
  getAttribute(name: string): string | null
  hasAttribute(name: string): boolean
  readonly href?: unknown
  getBoundingClientRect(): PageRect
  checkVisibility?(): boolean
}

/** The parts of a node of the hint overlay this world writes; only the overlay's own nodes. */
interface OverlayNode {
  textContent: string | null
  className: string
  readonly style: { setProperty(name: string, value: string): void }
  append(...nodes: OverlayNode[]): void
  getBoundingClientRect(): PageRect
}

/** The overlay's shadow root, closed, so the page's world gets no handle on it. */
interface OverlayRoot {
  adoptedStyleSheets: unknown[]
  replaceChildren(...nodes: OverlayNode[]): void
}

/** The one node the overlay puts in the page's DOM: the shadow host it owns (#123). */
interface OverlayHost {
  popover: string | null
  readonly isConnected: boolean
  readonly attributes: ArrayLike<{ readonly name: string }>
  attachShadow(init: { readonly mode: 'closed' }): OverlayRoot
  showPopover?(): void
  matches(selector: string): boolean
  remove(): void
  removeAttribute(name: string): void
  addEventListener(type: string, listener: () => void): void
}

interface Observer {
  observe(target: unknown, options: Readonly<Record<string, boolean>>): void
  disconnect(): void
}

/** The parts of the page's document this world reads, typed here because the preload has no DOM library. */
interface PageWorld {
  readonly document: {
    readonly title: string
    readonly body: PageElement | null
    readonly documentElement: { append(node: OverlayHost): void } | null
    getElementById(id: string): PageElement | null
    createElement(tag: string): unknown
  }
  readonly location: { readonly href: string }
  readonly scrollX: number
  readonly scrollY: number
  readonly innerWidth: number
  readonly innerHeight: number
  readonly MutationObserver: new (callback: () => void) => Observer
  readonly CSSStyleSheet: new () => { replaceSync(text: string): void }
}

const world = globalThis as unknown as PageWorld

// The semantic view (#122). Roles and names are computed here from the DOM
// and ARIA, the reduced tree ADR 0009 option A allows. Each element gets a
// number the first time a snapshot meets it, kept in this world for as long
// as the document lives, so a later snapshot of the same document names it
// the same; a navigation brings a new document and a new preload run, and
// main retires every ref of the old one. The walk reads; it writes nothing
// to the page.

/** The preload's number for each element it has met, for this document. */
const elementIds = new WeakMap<PageElement, number>()
let lastElementId = 0

function elementId(element: PageElement): number {
  let id = elementIds.get(element)
  if (id === undefined) {
    lastElementId += 1
    id = lastElementId
    elementIds.set(element, id)
  }
  return id
}

const ROLES: ReadonlySet<string> = new Set(SEMANTIC_ROLES)

/** Where a header or footer is not the page's banner or contentinfo. */
const SECTIONING = new Set(['ARTICLE', 'ASIDE', 'MAIN', 'NAV', 'SECTION'])

/** Roles whose name is their own text when nothing labels them. */
const NAMED_BY_TEXT: ReadonlySet<SemanticRole> = new Set([
  'heading',
  'link',
  'button',
  'tab',
  'menuitem',
  'checkbox',
  'radio',
  'switch',
])

/** Roles whose value the snapshot carries. */
const VALUED: ReadonlySet<SemanticRole> = new Set([
  'textbox',
  'searchbox',
  'combobox',
  'slider',
  'spinbutton',
])

/** One line, bounded: what every string of a snapshot is cut to. */
function line(text: string | null | undefined): string {
  return (text ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_NODE_TEXT)
}

function textOf(element: PageElement): string {
  return line(typeof element.innerText === 'string' ? element.innerText : element.textContent)
}

function inputRole(type: string): SemanticRole | null {
  switch (type) {
    case 'hidden':
      return null
    case 'button':
    case 'submit':
    case 'reset':
    case 'image':
      return 'button'
    case 'checkbox':
      return 'checkbox'
    case 'radio':
      return 'radio'
    case 'range':
      return 'slider'
    case 'number':
      return 'spinbutton'
    case 'search':
      return 'searchbox'
    default:
      return 'textbox'
  }
}

function roleOf(element: PageElement, sectioned: boolean): SemanticRole | null {
  const explicit = (element.getAttribute('role') ?? '').trim().split(/\s+/)[0] ?? ''
  if (ROLES.has(explicit)) return explicit as SemanticRole
  if (explicit === 'presentation' || explicit === 'none') return null
  switch (element.tagName) {
    case 'A':
    case 'AREA':
      return element.hasAttribute('href') ? 'link' : null
    case 'BUTTON':
    case 'SUMMARY':
      return 'button'
    case 'INPUT':
      return inputRole((element.type ?? '').toLowerCase())
    case 'TEXTAREA':
      return 'textbox'
    case 'SELECT':
      return 'combobox'
    case 'H1':
    case 'H2':
    case 'H3':
    case 'H4':
    case 'H5':
    case 'H6':
      return 'heading'
    case 'NAV':
      return 'navigation'
    case 'MAIN':
      return 'main'
    case 'ASIDE':
      return 'complementary'
    case 'FORM':
      return 'form'
    case 'SEARCH':
      return 'search'
    case 'DIALOG':
      return 'dialog'
    case 'HEADER':
      return sectioned ? null : 'banner'
    case 'FOOTER':
      return sectioned ? null : 'contentinfo'
    case 'SECTION':
      return line(element.getAttribute('aria-label')).length > 0 ||
        element.hasAttribute('aria-labelledby')
        ? 'region'
        : null
    case 'IMG':
      return line(element.getAttribute('alt')).length > 0 ? 'img' : null
    default:
      return element.isContentEditable === true ? 'textbox' : null
  }
}

function nameOf(element: PageElement, role: SemanticRole): string {
  const labelledBy = (element.getAttribute('aria-labelledby') ?? '').trim()
  if (labelledBy.length > 0) {
    const parts: string[] = []
    for (const id of labelledBy.split(/\s+/)) {
      const label = world.document.getElementById(id)
      if (label !== null) parts.push(textOf(label))
    }
    const joined = line(parts.join(' '))
    if (joined.length > 0) return joined
  }
  const aria = line(element.getAttribute('aria-label'))
  if (aria.length > 0) return aria
  const labels = element.labels
  if (labels !== undefined && labels !== null && labels.length > 0) {
    const parts: string[] = []
    for (let index = 0; index < labels.length; index += 1) {
      const label = labels[index]
      if (label !== undefined) parts.push(textOf(label))
    }
    const joined = line(parts.join(' '))
    if (joined.length > 0) return joined
  }
  if (element.tagName === 'INPUT' && role === 'button') {
    const value = typeof element.value === 'string' ? line(element.value) : ''
    if (value.length > 0) return value
  }
  if (element.tagName === 'IMG') return line(element.getAttribute('alt'))
  if (NAMED_BY_TEXT.has(role)) {
    const text = textOf(element)
    if (text.length > 0) return text
  }
  return line(element.getAttribute('placeholder')) || line(element.getAttribute('title'))
}

/** Whether the field holds a secret, whose value never leaves this world (#94's mask). */
function isSecret(element: PageElement): boolean {
  if (element.tagName === 'INPUT' && (element.type ?? '').toLowerCase() === 'password') return true
  const autocomplete = (element.getAttribute('autocomplete') ?? '').toLowerCase()
  return /\b(?:current-password|new-password|one-time-code|cc-number|cc-csc)\b/.test(autocomplete)
}

function valueOf(element: PageElement, role: SemanticRole): string {
  if (!VALUED.has(role) || isSecret(element)) return ''
  if (element.tagName === 'SELECT') {
    const chosen = element.selectedOptions?.[0]
    return chosen === undefined ? '' : textOf(chosen)
  }
  return typeof element.value === 'string' ? line(element.value) : ''
}

function stateOf(element: PageElement, role: SemanticRole): number {
  const aria = (name: string): string | null => element.getAttribute(`aria-${name}`)
  const on: Record<SemanticState, boolean> = {
    checked: element.checked === true || aria('checked') === 'true',
    disabled: element.disabled === true || aria('disabled') === 'true',
    expanded: aria('expanded') === 'true',
    collapsed: aria('expanded') === 'false',
    required: element.required === true || aria('required') === 'true',
    readonly: element.readOnly === true || aria('readonly') === 'true',
    selected: aria('selected') === 'true',
    pressed: aria('pressed') === 'true',
    masked: VALUED.has(role) && isSecret(element),
  }
  let bits = 0
  SEMANTIC_STATES.forEach((state, index) => {
    if (on[state]) bits |= 1 << index
  })
  return bits
}

/** A coordinate of the page, whole and inside the schema's bounds. */
function coordinate(value: number, min: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(MAX_PAGE_EXTENT, Math.max(min, Math.round(value)))
}

function nodeOf(element: PageElement, role: SemanticRole, depth: number): SnapshotNode {
  const rect = element.getBoundingClientRect()
  const level = role === 'heading' ? headingLevel(element) : 0
  return {
    id: elementId(element),
    depth,
    role,
    name: nameOf(element, role),
    value: valueOf(element, role),
    state: stateOf(element, role),
    level,
    x: coordinate(rect.x + world.scrollX, -MAX_PAGE_EXTENT),
    y: coordinate(rect.y + world.scrollY, -MAX_PAGE_EXTENT),
    width: coordinate(rect.width, 0),
    height: coordinate(rect.height, 0),
  }
}

function headingLevel(element: PageElement): number {
  const tag = /^H([1-6])$/.exec(element.tagName)
  if (tag?.[1] !== undefined) return Number(tag[1])
  const aria = Number(element.getAttribute('aria-level'))
  return Number.isInteger(aria) && aria >= 1 && aria <= 6 ? aria : 2
}

/** Whether a subtree is out of the page as a reader sees it. */
function isHidden(element: PageElement): boolean {
  if (element.getAttribute('aria-hidden') === 'true') return true
  return typeof element.checkVisibility === 'function' && !element.checkVisibility()
}

/** The page's semantic nodes, in document order, at most MAX_SNAPSHOT_NODES. */
function snapshot(): SnapshotAnswer {
  const nodes: SnapshotNode[] = []
  const body = world.document.body
  if (body === null) return { nodes }
  // An explicit stack, so a deep page cannot run the walk out of stack.
  const stack: { element: PageElement; depth: number; sectioned: boolean }[] = [
    { element: body, depth: 0, sectioned: false },
  ]
  while (stack.length > 0 && nodes.length < MAX_SNAPSHOT_NODES) {
    const top = stack.pop()
    if (top === undefined) break
    const { element, depth, sectioned } = top
    if (isHidden(element)) continue
    const role = element === body ? null : roleOf(element, sectioned)
    if (role !== null) nodes.push(nodeOf(element, role, depth))
    const below = role === null ? depth : Math.min(depth + 1, MAX_SNAPSHOT_DEPTH)
    const inside = sectioned || SECTIONING.has(element.tagName)
    const children = element.children
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = children[index]
      if (child !== undefined) stack.push({ element: child, depth: below, sectioned: inside })
    }
  }
  return { nodes }
}

// Hint mode (#123). `hints` reads the interactive elements in the viewport,
// numbered as the snapshot numbers them, so main makes the same refs of both.
// `hints-show` draws the labels main chose over them: the one place the door
// writes to the page, and only a shadow host it owns. The host's shadow root
// is closed and was made in this world, so the page's scripts get no handle
// on the labels; its style is a constructed sheet, which the page's CSP does
// not govern, and it sits in the top layer. While labels are up, a page that
// removes the host, styles it or closes its popover finds it put back, a
// bounded number of times. What a typed label does is decided in main, from
// main's own table: a label the page draws itself means nothing.

/** The roles a hint can land on: what can be followed, pressed or typed in. */
const HINTABLE: ReadonlySet<SemanticRole> = new Set([
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
])

/** The elements the last `hints` read found, by number, for `hints-show` to draw over. */
let hintTargets = new Map<number, PageElement>()

/** A link's absolute URL, or empty: no href, or one past the door's bound. */
function hrefOf(element: PageElement, role: SemanticRole): string {
  if (role !== 'link' || typeof element.href !== 'string') return ''
  return element.href.length <= MAX_PAGE_URL ? element.href : ''
}

/** The interactive elements in the viewport, in document order, at most MAX_HINTS. */
function hints(): HintsAnswer {
  const nodes: HintNode[] = []
  const targets = new Map<number, PageElement>()
  hintTargets = targets
  const body = world.document.body
  if (body === null) return { nodes }
  const width = world.innerWidth
  const height = world.innerHeight
  const stack: { element: PageElement; sectioned: boolean }[] = [
    { element: body, sectioned: false },
  ]
  while (stack.length > 0 && nodes.length < MAX_HINTS) {
    const top = stack.pop()
    if (top === undefined) break
    const { element, sectioned } = top
    if (isHidden(element)) continue
    const role = element === body ? null : roleOf(element, sectioned)
    if (role !== null && HINTABLE.has(role)) {
      const rect = element.getBoundingClientRect()
      const inView =
        rect.width > 0 &&
        rect.height > 0 &&
        rect.x < width &&
        rect.y < height &&
        rect.x + rect.width > 0 &&
        rect.y + rect.height > 0
      if (inView) {
        const id = elementId(element)
        targets.set(id, element)
        nodes.push({
          id,
          href: hrefOf(element, role),
          x: coordinate(rect.x, -MAX_PAGE_EXTENT),
          y: coordinate(rect.y, -MAX_PAGE_EXTENT),
          width: coordinate(rect.width, 0),
          height: coordinate(rect.height, 0),
        })
      }
    }
    const inside = sectioned || SECTIONING.has(element.tagName)
    const children = element.children
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = children[index]
      if (child !== undefined) stack.push({ element: child, sectioned: inside })
    }
  }
  return { nodes }
}

/** The overlay's sheet. `:host` rules marked important outrank the page's, inline style included. */
const OVERLAY_STYLE = `
:host {
  all: initial !important;
  display: block !important;
  position: fixed !important;
  inset: 0 !important;
  width: auto !important;
  height: auto !important;
  margin: 0 !important;
  padding: 0 !important;
  border: 0 !important;
  background: transparent !important;
  overflow: visible !important;
  visibility: visible !important;
  opacity: 1 !important;
  z-index: 2147483647 !important;
  pointer-events: none !important;
}
.label {
  position: absolute;
  pointer-events: auto;
  box-sizing: border-box;
  padding: 1px 4px;
  border: 1px solid #5c4a00;
  border-radius: 3px;
  background: #ffd84a;
  color: #000;
  font: bold 12px/1.2 ui-monospace, Menlo, monospace;
  white-space: nowrap;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.4);
}
`

/** How many times one draw puts the overlay back after the page took it down. */
const MAX_RESTORES = 50

interface Overlay {
  readonly host: OverlayHost
  readonly root: OverlayRoot
  readonly observer: Observer
  restores: number
}

let overlay: Overlay | null = null

/** In the top layer, over anything the page stacks, where the browser has popovers. */
function raise(host: OverlayHost): void {
  if (host.popover !== 'manual') host.popover = 'manual'
  if (typeof host.showPopover === 'function' && !host.matches(':popover-open')) host.showPopover()
}

/** Puts the overlay back as it was drawn: in the document, unstyled by the page, on top. */
function restore(): void {
  const current = overlay
  if (current === null || current.restores >= MAX_RESTORES) return
  const { host } = current
  let changed = false
  if (!host.isConnected) {
    world.document.documentElement?.append(host)
    changed = true
  }
  for (const { name } of Array.from(host.attributes)) {
    if (name === 'popover') continue
    host.removeAttribute(name)
    changed = true
  }
  if (!host.matches(':popover-open')) changed = true
  raise(host)
  if (changed) current.restores += 1
}

function openOverlay(): Overlay {
  const host = world.document.createElement('div') as OverlayHost
  const root = host.attachShadow({ mode: 'closed' })
  const sheet = new world.CSSStyleSheet()
  sheet.replaceSync(OVERLAY_STYLE)
  root.adoptedStyleSheets = [sheet]
  const observer = new world.MutationObserver(restore)
  const opened: Overlay = { host, root, observer, restores: 0 }
  overlay = opened
  world.document.documentElement?.append(host)
  raise(host)
  observer.observe(world.document, { childList: true, subtree: true })
  observer.observe(host, { attributes: true })
  host.addEventListener('toggle', restore)
  return opened
}

function closeOverlay(): void {
  const current = overlay
  overlay = null
  if (current === null) return
  current.observer.disconnect()
  current.host.remove()
}

/** Draws the labels main chose, replacing any drawn before; none clears the overlay. */
function hintsShow(args: readonly number[]): HintsShowAnswer {
  const labels = decodeHintLabels(args)
  if (labels.length === 0) {
    closeOverlay()
    hintTargets = new Map()
    return { labels: [] }
  }
  const current = overlay ?? openOverlay()
  current.restores = 0
  const drawn: { readonly id: number; readonly node: OverlayNode }[] = []
  for (const { id, label } of labels) {
    const element = hintTargets.get(id)
    if (element === undefined) continue
    const rect = element.getBoundingClientRect()
    const node = world.document.createElement('span') as OverlayNode
    node.className = 'label'
    node.textContent = label
    node.style.setProperty('left', `${Math.max(0, Math.round(rect.x))}px`)
    node.style.setProperty('top', `${Math.max(0, Math.round(rect.y))}px`)
    drawn.push({ id, node })
  }
  current.root.replaceChildren(...drawn.map((one) => one.node))
  const answer: DrawnLabel[] = drawn.map(({ id, node }) => {
    const rect = node.getBoundingClientRect()
    return {
      id,
      x: coordinate(rect.x, -MAX_PAGE_EXTENT),
      y: coordinate(rect.y, -MAX_PAGE_EXTENT),
      width: coordinate(rect.width, 0),
      height: coordinate(rect.height, 0),
    }
  })
  return { labels: answer }
}

// Reader mode (#128): the page's main text as plain blocks, extracted by
// src/shared/reader.ts over the live DOM. It reads; it writes nothing to the
// page, and what crosses is text, never the page's HTML.

function reader(): ReaderAnswer {
  return extractReader(
    world.document.title,
    world.document.body as unknown as ReaderNode | null,
    (element) => isHidden(element as unknown as PageElement),
  )
}

/** One handler per request name, fixed at build time; a consumer adds its own (#122, #123, #128, #94). */
const HANDLERS: {
  readonly [N in PageRequestName]: (args: readonly number[]) => PageAnswers[N]
} = Object.freeze({
  ping: () => ({
    url: world.location.href.slice(0, MAX_PAGE_URL),
    title: world.document.title.replace(/\s+/g, ' ').trim().slice(0, MAX_PAGE_TITLE),
  }),
  snapshot,
  hints,
  'hints-show': hintsShow,
  reader,
})

ipcRenderer.on(PAGE_DOOR_REQUEST_CHANNEL, (_event, request: unknown) => {
  if (typeof request !== 'object' || request === null) return
  const { id, name, args } = request as {
    readonly id?: unknown
    readonly name?: unknown
    readonly args?: unknown
  }
  if (typeof id !== 'string' || id.length === 0 || id.length > MAX_PAGE_REQUEST_ID) return
  if (typeof name !== 'string' || !Object.hasOwn(HANDLERS, name)) return
  let data: PageAnswers[PageRequestName]
  try {
    data = HANDLERS[name as PageRequestName](parsePageRequestArgs(args))
  } catch {
    // No answer is an answer: main settles the request as an error on its timeout.
    return
  }
  ipcRenderer.send(PAGE_DOOR_REPLY_CHANNEL, { id, name, data })
})
