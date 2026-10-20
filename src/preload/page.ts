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
  MAX_FORM_ALERTS,
  MAX_FORM_FIELDS,
  MAX_TEXT_CHARS,
  MAX_MUTATION_SUMMARY,
  MUTATION_RING,
  decodeQuery,
  MAX_QUERY_HTML,
  MAX_SELECT_OPTIONS,
  type DrawnLabel,
  type FormAlert,
  type FormAnswer,
  type FormField,
  type HintNode,
  type HintsAnswer,
  type HintsShowAnswer,
  type MutationKind,
  type MutationRecordAnswer,
  type MutationsAnswer,
  type OptionsAnswer,
  type PageAnswers,
  type QueryAnswer,
  type QueryMatch,
  type ScrollToAnswer,
  type SelectAnswer,
  type SelectOption,
  type PageRequestName,
  type ReaderAnswer,
  type SemanticRole,
  type SemanticState,
  type SnapshotAnswer,
  type SnapshotNode,
  type TextAnswer,
} from '../shared/page-door'
import { formField, isSecretField, type FormControl } from '../shared/form-snapshot'
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
// request carries no code, and nothing here evaluates text. `query`'s
// selector, the one string a request carries (#141), goes to
// `querySelectorAll` and nowhere else.

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
  querySelectorAll?(selector: string): ArrayLike<PageElement>
  /** An open shadow root; null on an element with none, or with a closed one (#143). */
  readonly shadowRoot?: { readonly children: ArrayLike<PageElement> } | null
  /** On a `<slot>`: what the page assigned to it, text nodes included, and the elements of that. */
  assignedNodes?(): ArrayLike<unknown>
  assignedElements?(): ArrayLike<PageElement>
  getRootNode?(): { getElementById?(id: string): PageElement | null }
  readonly href?: unknown
  getBoundingClientRect(): PageRect
  checkVisibility?(): boolean
  scrollIntoView?(options: { readonly block: 'start' }): void
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

/** A node a mutation record names: an element, or a text node under one. */
interface ChangedNode {
  readonly nodeType: number
  readonly tagName?: string
  readonly textContent: string | null
  readonly parentElement: PageElement | null
}

/** The parts of a MutationRecord the mutation feed reads (#29). */
interface ChangeRecord {
  readonly type: string
  readonly target: ChangedNode
  readonly addedNodes: ArrayLike<ChangedNode>
  readonly removedNodes: ArrayLike<ChangedNode>
  readonly attributeName: string | null
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
    readonly documentElement: (PageElement & { append(node: OverlayHost): void }) | null
    getElementById(id: string): PageElement | null
    createElement(tag: string): unknown
    querySelectorAll(selector: string): ArrayLike<PageElement>
    readonly activeElement: PageElement | null
    addEventListener(type: string, listener: () => void, capture: boolean): void
  }
  readonly location: { readonly href: string }
  readonly scrollX: number
  readonly scrollY: number
  readonly innerWidth: number
  readonly innerHeight: number
  readonly MutationObserver: new (callback: (records: readonly ChangeRecord[]) => void) => Observer
  readonly CSSStyleSheet: new () => { replaceSync(text: string): void }
}

const world = globalThis as unknown as PageWorld

/** The parts of an `<option>` the choice reads and sets (#141). */
interface PageOption {
  readonly value: string
  readonly label: string
  selected: boolean
  matches(selector: string): boolean
}

/** The parts of a `<select>` the choice reads and sets, and of any element `query` reads (#141). */
interface ChoosingElement extends PageElement {
  readonly outerHTML: string
  readonly multiple?: boolean
  readonly options?: ArrayLike<PageOption>
  selectedIndex?: number
  matches(selector: string): boolean
  dispatchEvent(event: unknown): boolean
}

/** The isolated world's own Event, so the page's replacement of it is never what dispatches. */
const IsolatedEvent = (
  globalThis as unknown as {
    readonly Event: new (type: string, init: { bubbles: boolean; composed?: boolean }) => unknown
  }
).Event

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

// The flat tree (#143). Every walk of the page follows the tree as it
// renders: a host with an open shadow root is walked through its root, and a
// `<slot>` the page assigned nodes to through those nodes, so a slotted
// element is met once, where it renders; a slot with nothing assigned shows
// its own children. A closed shadow root, the hint overlay's own included,
// reads as null in this world and stays closed: its host's light children
// are walked instead.

/** What an element renders as its children, in the flat tree. */
function flatChildren(element: PageElement): ArrayLike<PageElement> {
  const root = element.shadowRoot
  if (root !== undefined && root !== null) return root.children
  if (
    element.tagName === 'SLOT' &&
    typeof element.assignedNodes === 'function' &&
    typeof element.assignedElements === 'function' &&
    element.assignedNodes().length > 0
  ) {
    return element.assignedElements()
  }
  return element.children
}

/** Every element under `root`, the root first, in flat-tree order. */
function flatElements(root: PageElement): PageElement[] {
  const found: PageElement[] = []
  const stack: PageElement[] = [root]
  while (stack.length > 0) {
    const element = stack.pop()
    if (element === undefined) break
    found.push(element)
    const children = flatChildren(element)
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = children[index]
      if (child !== undefined) stack.push(child)
    }
  }
  return found
}

/**
 * Every element under `root`, the root first: its light children and those
 * of every open shadow root both, rendered or not, so an element a selector
 * matched outside the flat tree is found as surely as one a walk met.
 */
function reachableElements(root: PageElement): PageElement[] {
  const found: PageElement[] = []
  const stack: PageElement[] = [root]
  while (stack.length > 0) {
    const element = stack.pop()
    if (element === undefined) break
    found.push(element)
    const shadow = element.shadowRoot
    for (const children of [shadow?.children ?? [], element.children]) {
      for (let index = children.length - 1; index >= 0; index -= 1) {
        const child = children[index]
        if (child !== undefined) stack.push(child)
      }
    }
  }
  return found
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

/** The form fields, by tag. */
const FIELD_TAGS: ReadonlySet<string> = new Set(['INPUT', 'SELECT', 'TEXTAREA'])

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
    // An id names an element of the element's own tree: the document, or its shadow root.
    const scope = element.getRootNode?.()
    for (const id of labelledBy.split(/\s+/)) {
      const label =
        typeof scope?.getElementById === 'function'
          ? scope.getElementById(id)
          : world.document.getElementById(id)
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

/**
 * Whether the field holds a secret, whose value never leaves this world: the
 * form guide's masking list (#94), src/shared/form-snapshot.ts, the one place.
 */
function isSecret(element: PageElement, role: SemanticRole): boolean {
  return isSecretField(element as unknown as FormControl, nameOf(element, role))
}

function valueOf(element: PageElement, role: SemanticRole): string {
  if (!VALUED.has(role) || isSecret(element, role)) return ''
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
    masked: VALUED.has(role) && isSecret(element, role),
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
  // A slot is `display: contents`, which `checkVisibility` calls hidden; what
  // it renders answers for itself, and is hidden when the slot is (#143).
  if (element.tagName === 'SLOT') return false
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
    const children = flatChildren(element)
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
    const children = flatChildren(element)
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

/** What a node renders as its child nodes, text included, in the flat tree. */
function flatChildNodes(node: ReaderNode): ArrayLike<ReaderNode> {
  const element = node as unknown as {
    readonly shadowRoot?: { readonly childNodes: ArrayLike<ReaderNode> } | null
    assignedNodes?(): ArrayLike<ReaderNode>
  }
  const root = element.shadowRoot
  if (root !== undefined && root !== null) return root.childNodes
  if (node.nodeName === 'SLOT' && typeof element.assignedNodes === 'function') {
    const assigned = element.assignedNodes()
    if (assigned.length > 0) return assigned
  }
  return node.childNodes
}

function reader(): ReaderAnswer {
  return extractReader(
    world.document.title,
    world.document.body as unknown as ReaderNode | null,
    (element) => isHidden(element as unknown as PageElement),
    flatChildNodes,
  )
}

// The form guide (#94). A read-only observer counts every change to the
// document, the focus and the typing included, once a watch first asks;
// `form` reads the fields only when the count moved since main's last read,
// or when the last full read is older than FORM_REREAD_MS, so a page that
// swallows the events in its own capture handlers delays the guide, never
// blinds it. The listeners and the observer live in this world: the page's
// scripts cannot see or remove them. They count; they write nothing to the
// page. A secret's value is dropped by `formField` before the answer is built.

/** How old a full read may be before an unchanged count is read again anyway. */
const FORM_REREAD_MS = 3000

/** The events that move the count, caught on the way down to the field. */
const FORM_EVENTS = ['focusin', 'focusout', 'input', 'change', 'invalid', 'reset'] as const

let formVersion = 1
let formWatched = false
let formReadAt = 0

function watchForm(): void {
  if (formWatched) return
  formWatched = true
  const bump = (): void => {
    formVersion += 1
  }
  new world.MutationObserver((records) => {
    bump()
    if (mutationsWatched) recordMutations(records)
  }).observe(world.document, {
    childList: true,
    subtree: true,
    attributes: true,
    characterData: true,
  })
  for (const type of FORM_EVENTS) world.document.addEventListener(type, bump, true)
}

/** The visible alerts of the page: error banners and assertive live regions. */
function formAlerts(): FormAlert[] {
  const alerts: FormAlert[] = []
  const body = world.document.body
  const found = body === null ? [] : flatElements(body)
  for (let index = 0; index < found.length && alerts.length < MAX_FORM_ALERTS; index += 1) {
    const element = found[index]
    if (element === undefined) continue
    if (
      element.getAttribute('role') !== 'alert' &&
      element.getAttribute('aria-live') !== 'assertive'
    )
      continue
    if (isHidden(element)) continue
    const text = textOf(element)
    if (text.length > 0) alerts.push({ text })
  }
  return alerts
}

/** The page's form fields, in document order, at most MAX_FORM_FIELDS, and the focused one. */
function form(args: readonly number[]): FormAnswer {
  watchForm()
  const now = Date.now()
  if (args[0] === formVersion && now - formReadAt < FORM_REREAD_MS) {
    return { version: formVersion, same: 1, focused: 0, fields: [], alerts: [] }
  }
  formReadAt = now
  const version = formVersion
  const fields: FormField[] = []
  const active = world.document.activeElement
  let focused = 0
  const body = world.document.body
  const controls = (body === null ? [] : flatElements(body)).filter((element) =>
    FIELD_TAGS.has(element.tagName),
  )
  for (let index = 0; index < controls.length && fields.length < MAX_FORM_FIELDS; index += 1) {
    const element = controls[index]
    if (element === undefined || isHidden(element)) continue
    const role = roleOf(element, false) ?? 'textbox'
    const field = formField(
      element as unknown as FormControl,
      elementId(element),
      nameOf(element, role),
    )
    if (field === null) continue
    fields.push(field)
    if (element === active) focused = field.id
  }
  return { version, same: 0, focused, fields, alerts: formAlerts() }
}

// One element's text for the MCP page tier (#138): `browser_read_text` by
// ref. The element is one a snapshot numbered; the mask is decided before
// any value is read, by the masking list of #94, on the element and on every
// field inside it, so a secret's value never leaves this world. It reads; it
// writes nothing to the page.

/** The element this document numbered `id`, or null: never numbered, or gone from the document. */
function elementById(id: number): PageElement | null {
  const top = world.document.documentElement
  const all = top === null ? [] : reachableElements(top)
  for (let index = 0; index < all.length; index += 1) {
    const element = all[index]
    if (element !== undefined && elementIds.get(element) === id) return element
  }
  return null
}

/**
 * Whether the element is a secret field, or holds one: the snapshot's own
 * mask (a valued role the masking list matches), on the element and on every
 * field and editable inside it, read by attributes and labels, never by value.
 */
function holdsSecret(element: PageElement): boolean {
  return reachableElements(element).some((field) => {
    if (
      field !== element &&
      !FIELD_TAGS.has(field.tagName) &&
      !field.hasAttribute('contenteditable')
    )
      return false
    return isOwnSecret(field)
  })
}

/** Whether the element itself is a secret field: the snapshot's own mask on that one element. */
function isOwnSecret(element: PageElement): boolean {
  const role = roleOf(element, false)
  return role !== null && VALUED.has(role) && isSecret(element, role)
}

/** A field's value, or any other element's rendered text. */
function wholeText(element: PageElement): string {
  if (element.tagName === 'SELECT') {
    const chosen = element.selectedOptions?.[0]
    return chosen === undefined ? '' : textOf(chosen)
  }
  if (FIELD_TAGS.has(element.tagName)) return typeof element.value === 'string' ? element.value : ''
  const raw = typeof element.innerText === 'string' ? element.innerText : element.textContent
  return (raw ?? '').replace(/\r\n?/g, '\n').trim()
}

/** `text`: args are the element's number, the first character, and how many. */
function text(args: readonly number[]): TextAnswer {
  const [id, from, chars] = args
  if (args.length !== 3 || id === undefined || from === undefined || chars === undefined) {
    throw new TypeError('text takes an element, a start and a length')
  }
  if (id < 1 || from < 0 || chars < 1) throw new TypeError('text has an arg out of range')
  const element = elementById(id)
  if (element === null) return { status: 'gone', total: 0, text: '' }
  if (holdsSecret(element)) return { status: 'masked', total: 0, text: '' }
  const whole = wholeText(element)
  return {
    status: 'ok',
    total: whole.length,
    text: whole.slice(from, from + Math.min(chars, MAX_TEXT_CHARS)),
  }
}

// The mutation feed of the MCP page tier (#29). #94's observer, once the
// first `mutations` request asks, also keeps the last MUTATION_RING changes
// it sees, each a kind, the element's number and a one-line summary: a tag,
// an attribute's name, a cut of the text. An attribute's value is left out
// on a secret field and for `value`, by the masking list of #94 on the
// element itself (a child's value is never in its ancestor's attribute, so
// its descendants are not scanned on every change, #150), and a
// field's typed value is never in the document's mutations at all. The
// hint overlay's own host is not a change of the page. It records; it writes
// nothing to the page.

let mutationsWatched = false
let mutationSeq = 0
const mutationRing: MutationRecordAnswer[] = []

/** One line, cut to the summary's bound. */
function summaryLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, MAX_MUTATION_SUMMARY)
}

/** `<tag> "text"` for an element, `text "..."` for a text node. */
function nodeSummary(node: ChangedNode): string {
  const text = line(node.textContent).slice(0, 80)
  const what = node.nodeType === 1 ? `<${(node.tagName ?? '').toLowerCase()}>` : 'text'
  return text.length === 0 ? what : `${what} "${text}"`
}

/** The element a change happened on: the node itself, or a text node's parent. */
function elementOf(node: ChangedNode): PageElement | null {
  return node.nodeType === 1 ? (node as unknown as PageElement) : node.parentElement
}

function pushMutation(kind: MutationKind, element: PageElement | null, summary: string): void {
  mutationSeq += 1
  mutationRing.push({
    seq: mutationSeq,
    at: Date.now(),
    kind,
    element: element === null ? 0 : elementId(element),
    summary: summaryLine(summary),
  })
  if (mutationRing.length > MUTATION_RING)
    mutationRing.splice(0, mutationRing.length - MUTATION_RING)
}

function isOverlay(node: ChangedNode): boolean {
  return overlay !== null && (node as unknown) === overlay.host
}

function recordMutations(records: readonly ChangeRecord[]): void {
  for (const record of records) {
    if (isOverlay(record.target)) continue
    const parent = elementOf(record.target)
    if (record.type === 'childList') {
      for (const node of Array.from(record.addedNodes)) {
        if (isOverlay(node)) continue
        const element = node.nodeType === 1 ? elementOf(node) : parent
        pushMutation('added', element, nodeSummary(node))
      }
      for (const node of Array.from(record.removedNodes)) {
        if (isOverlay(node)) continue
        pushMutation('removed', parent, nodeSummary(node))
      }
    } else if (record.type === 'attributes' && parent !== null) {
      const name = record.attributeName ?? ''
      const tag = `<${parent.tagName.toLowerCase()}>`
      const value = name === 'value' || isOwnSecret(parent) ? null : parent.getAttribute(name)
      pushMutation(
        'attribute',
        parent,
        value === null ? `${name} on ${tag}` : `${name} on ${tag}: "${line(value).slice(0, 80)}"`,
      )
    } else if (record.type === 'characterData') {
      pushMutation('text', parent, nodeSummary(record.target))
    }
  }
}

/** `mutations`: the one arg is the last record main holds; past the newest, the whole ring. */
function mutations(args: readonly number[]): MutationsAnswer {
  const [since] = args
  if (args.length !== 1 || since === undefined || since < 0) {
    throw new TypeError('mutations takes the last record main holds')
  }
  watchForm()
  mutationsWatched = true
  const from = since > mutationSeq ? 0 : since
  return { last: mutationSeq, records: mutationRing.filter((record) => record.seq > from) }
}

// `browser_query` and `browser_select_option` (#141), ADR 0009's two
// exceptions. `query` runs the agent's CSS selector with `querySelectorAll`
// in this world: a selector selects, it cannot call code. A matched element
// that is, or holds, a secret field gives its number and no HTML; and since
// an attribute selector can test a `value` attribute a character at a time,
// a document where a secret field carries one answers no selector at all.
// `select` is the door's one write: it sets a `<select>`'s chosen options by
// index, as main matched the agent's values against `options`, and
// dispatches `input` and `change` as a user's choice would. A secret field
// is refused before its options are read.

/** The `value` attribute of a secret field anywhere in the document, the one a selector could test. */
function secretAttributeSet(): boolean {
  const fields = world.document.querySelectorAll('input[value], textarea[value]')
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index]
    if (field === undefined || (field.getAttribute('value') ?? '').length === 0) continue
    if (holdsSecret(field)) return true
  }
  return false
}

/** `query`: args are the limit, then the selector as code units. */
function query(args: readonly number[]): QueryAnswer {
  const { selector, limit } = decodeQuery(args)
  let found: ArrayLike<PageElement>
  try {
    found = world.document.querySelectorAll(selector)
  } catch {
    return { status: 'invalid', matched: 0, matches: [] }
  }
  if (secretAttributeSet()) return { status: 'masked', matched: 0, matches: [] }
  const matches: QueryMatch[] = []
  for (let index = 0; index < found.length && matches.length < limit; index += 1) {
    const element = found[index] as ChoosingElement | undefined
    if (element === undefined) continue
    const masked = holdsSecret(element)
    matches.push({
      id: elementId(element),
      masked: masked ? 1 : 0,
      html: masked ? '' : element.outerHTML.slice(0, MAX_QUERY_HTML),
    })
  }
  return { status: 'ok', matched: found.length, matches }
}

/** The `<select>` numbered `id`, or why it cannot be chosen in; decided before any option is read. */
function chosenSelect(id: number): ChoosingElement | Exclude<SelectAnswer['status'], 'ok'> {
  const element = elementById(id) as ChoosingElement | null
  if (element === null) return 'gone'
  if (element.tagName !== 'SELECT' || element.options === undefined) return 'not-select'
  if (holdsSecret(element)) return 'masked'
  if (element.matches(':disabled')) return 'disabled'
  return element
}

/** `options`: the one arg is the element's number. */
function options(args: readonly number[]): OptionsAnswer {
  const [id] = args
  if (args.length !== 1 || id === undefined || id < 1) {
    throw new TypeError('options takes an element')
  }
  const element = chosenSelect(id)
  if (typeof element === 'string') return { status: element, multiple: 0, options: [] }
  const all = element.options ?? []
  if (all.length > MAX_SELECT_OPTIONS) return { status: 'invalid', multiple: 0, options: [] }
  const read: SelectOption[] = []
  for (let index = 0; index < all.length; index += 1) {
    const option = all[index]
    if (option === undefined) continue
    read.push({
      value: option.value.slice(0, MAX_NODE_TEXT),
      label: line(option.label),
      disabled: option.matches(':disabled') ? 1 : 0,
    })
  }
  return { status: 'ok', multiple: element.multiple === true ? 1 : 0, options: read }
}

/** `select`: args are the element's number, the option count main read, then the chosen indexes. */
function select(args: readonly number[]): SelectAnswer {
  const [id, count, ...chosen] = args
  if (id === undefined || id < 1 || count === undefined || chosen.length === 0) {
    throw new TypeError('select takes an element, a count and the chosen options')
  }
  const element = chosenSelect(id)
  if (typeof element === 'string') return { status: element, selected: 0 }
  const all = element.options ?? []
  if (all.length !== count) return { status: 'changed', selected: 0 }
  const picked = new Set(chosen)
  if (picked.size !== chosen.length || (element.multiple !== true && picked.size !== 1)) {
    return { status: 'invalid', selected: 0 }
  }
  for (const index of picked) {
    const option = all[index]
    if (option === undefined || option.matches(':disabled'))
      return { status: 'invalid', selected: 0 }
  }
  if (element.multiple === true) {
    for (let index = 0; index < all.length; index += 1) {
      const option = all[index]
      if (option !== undefined) option.selected = picked.has(index)
    }
  } else {
    element.selectedIndex = chosen[0] ?? -1
  }
  element.dispatchEvent(new IsolatedEvent('input', { bubbles: true, composed: true }))
  element.dispatchEvent(new IsolatedEvent('change', { bubbles: true }))
  let selected = 0
  for (let index = 0; index < all.length; index += 1)
    if (all[index]?.selected === true) selected += 1
  return { status: 'ok', selected }
}

/**
 * `scroll-to` (#176): the element's number in, the element at the top of the
 * viewport. It moves the scroll position as a user's own scroll would and
 * changes nothing in the document; no value is read.
 */
function scrollTo(args: readonly number[]): ScrollToAnswer {
  const [id] = args
  if (args.length !== 1 || id === undefined || id < 1) {
    throw new TypeError('scroll-to takes one element')
  }
  const element = elementById(id)
  if (element === null || element.scrollIntoView === undefined) return { status: 'gone' }
  element.scrollIntoView({ block: 'start' })
  return { status: 'ok' }
}

/** One handler per request name, fixed at build time; a consumer adds its own (#122, #123, #128, #94, #138, #29, #141). */
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
  form,
  text,
  mutations,
  query,
  options,
  select,
  'scroll-to': scrollTo,
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
