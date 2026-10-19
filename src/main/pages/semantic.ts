import type { PageEvent } from '../../shared/buffers'
import {
  SEMANTIC_STATES,
  type SemanticRole,
  type SemanticState,
  type SnapshotAnswer,
} from '../../shared/page-door'
import { pagePrompt } from '../agent/boundary'
import { describeOrigin } from '../ipc'

/**
 * The semantic view of a page buffer (#122, study 07 item 7): what can be read
 * and acted on in a page, as a tree of nodes with refs, the one snapshot hint
 * mode (#123), the agent and the MCP page tier's `browser_snapshot` (ADR 0008)
 * share.
 *
 * - The nodes come through the page-script door of ADR 0009 (#130) as its
 *   `snapshot` answer, parsed whole against the door's schema before this
 *   module sees them. Nothing here evaluates text in a page.
 * - A ref is `d<document>e<element>`: the element's number from the page
 *   preload, which keeps it for as long as the document lives, under the
 *   number main gives each document a page commits. So a ref is the same in
 *   every snapshot of one document, a scroll included, and dead once the
 *   page commits a navigation: the next document's refs carry a new number,
 *   and `resolve` refuses the old one. A snapshot that a navigation overtook
 *   is an error, never a tree of mixed documents.
 * - Every string of a node is page content. The cockpit reads it as data
 *   (the human's buffer, the hints); what reaches the agent goes through
 *   `wrapUntrusted` under the origin of the committed URL main holds, by
 *   `snapshotPrompt`, never by concatenation.
 */

/** A node's rectangle, in CSS pixels of the page, not of the viewport. */
export interface SemanticRect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export interface SemanticNode {
  readonly ref: string
  readonly role: SemanticRole
  /** Page content: the node's accessible name as the preload computed it. */
  readonly name: string
  /** Page content: a field's value; empty for a masked field and for every other role. */
  readonly value: string
  readonly state: readonly SemanticState[]
  /** A heading's level, 1 to 6; absent on every other role. */
  readonly level?: number
  readonly rect: SemanticRect
  readonly children: readonly SemanticNode[]
}

export interface SemanticSnapshot {
  readonly pageId: string
  /** The committed top-frame URL main held when the snapshot was asked (SECURITY.org T3). */
  readonly url: string
  /** The origin of that URL, which heads the agent's block. */
  readonly origin: string
  /** The roots, in document order. */
  readonly nodes: readonly SemanticNode[]
  /** How many nodes the tree holds, every depth counted. */
  readonly count: number
}

export interface SemanticViewOptions {
  /** The door's `snapshot` answer for a page buffer, parsed whole; rejects when the page is gone. */
  readonly ask: (pageId: string) => Promise<SnapshotAnswer>
  /** A page buffer's committed URL; undefined when the page is gone or has committed none. */
  readonly committedUrl: (pageId: string) => string | undefined
  /** Every page's event stream, as PageBuffers.onPageEvent gives it. */
  readonly events: (listener: (event: PageEvent) => void) => unknown
}

/** What a live ref names: the page buffer and the preload's number for the element. */
export interface ResolvedRef {
  readonly pageId: string
  readonly element: number
}

const REF = /^d([1-9][0-9]{0,15})e([1-9][0-9]{0,15})$/

export function formatRef(document: number, element: number): string {
  return `d${document}e${element}`
}

export function parseRef(ref: string): { document: number; element: number } | null {
  const match = REF.exec(ref)
  if (match?.[1] === undefined || match[2] === undefined) return null
  return { document: Number(match[1]), element: Number(match[2]) }
}

export class SemanticView {
  /** The document number of each page buffer's current document. */
  private readonly documents = new Map<string, number>()
  /** Which page each document number was given to. */
  private readonly owners = new Map<number, string>()
  private lastDocument = 0

  constructor(private readonly options: SemanticViewOptions) {
    // A committed top-frame navigation is a new document: every ref of the
    // old one dies here, before the next snapshot can be asked.
    options.events((event) => {
      if (event.type === 'committed') this.newDocument(event.pageId)
    })
  }

  /** The tree of a page buffer, its refs under the page's current document. */
  async snapshot(pageId: string): Promise<SemanticSnapshot> {
    const url = this.options.committedUrl(pageId)
    if (url === undefined) throw new Error('The page has not loaded a URL yet')
    const document = this.documentOf(pageId)
    const answer = await this.options.ask(pageId)
    if (this.documents.get(pageId) !== document) {
      throw new Error('The page navigated while its snapshot was read')
    }
    const { nodes, count } = buildTree(document, answer)
    return { pageId, url, origin: describeOrigin(url), nodes, count }
  }

  /** The page and element a ref names, or null once its document is gone. */
  resolve(ref: string): ResolvedRef | null {
    const parsed = parseRef(ref)
    if (parsed === null) return null
    const pageId = this.owners.get(parsed.document)
    if (pageId === undefined) return null
    if (this.documents.get(pageId) !== parsed.document) return null
    if (this.options.committedUrl(pageId) === undefined) return null
    return { pageId, element: parsed.element }
  }

  private documentOf(pageId: string): number {
    return this.documents.get(pageId) ?? this.newDocument(pageId)
  }

  private newDocument(pageId: string): number {
    const before = this.documents.get(pageId)
    if (before !== undefined) this.owners.delete(before)
    this.lastDocument += 1
    this.documents.set(pageId, this.lastDocument)
    this.owners.set(this.lastDocument, pageId)
    return this.lastDocument
  }
}

/** The bits of a node's state, as the names of SEMANTIC_STATES. */
export function statesOf(bits: number): readonly SemanticState[] {
  return SEMANTIC_STATES.filter((_state, index) => (bits & (1 << index)) !== 0)
}

interface Building {
  readonly node: Omit<SemanticNode, 'children'>
  readonly children: Building[]
}

/**
 * The flat answer as a tree: each node under the last shallower one. An
 * answer whose depths do not make a tree (a first node below the roots, a
 * jump of more than one level) or that names an element twice is refused
 * whole, like any answer that breaks the door's schema.
 */
export function buildTree(
  document: number,
  answer: SnapshotAnswer,
): { readonly nodes: readonly SemanticNode[]; readonly count: number } {
  const roots: Building[] = []
  const path: Building[] = []
  const seen = new Set<number>()
  for (const raw of answer.nodes) {
    if (raw.depth > path.length) throw new Error('The snapshot is not a tree')
    if (seen.has(raw.id)) throw new Error('The snapshot names an element twice')
    seen.add(raw.id)
    const building: Building = {
      node: {
        ref: formatRef(document, raw.id),
        role: raw.role,
        name: raw.name,
        value: raw.value,
        state: statesOf(raw.state),
        ...(raw.role === 'heading' && raw.level > 0 ? { level: raw.level } : {}),
        rect: { x: raw.x, y: raw.y, width: raw.width, height: raw.height },
      },
      children: [],
    }
    path.length = raw.depth
    const parent = path.at(-1)
    if (parent === undefined) roots.push(building)
    else parent.children.push(building)
    path.push(building)
  }
  const done = (building: Building): SemanticNode => ({
    ...building.node,
    children: building.children.map(done),
  })
  return { nodes: roots.map(done), count: seen.size }
}

/** One node as a line: the ref, the role, then the page's strings quoted as data. */
function nodeLine(node: SemanticNode): string {
  const parts = [`[${node.ref}]`, node.role]
  if (node.level !== undefined) parts.push(`level ${node.level}`)
  if (node.name.length > 0) parts.push(JSON.stringify(node.name))
  if (node.value.length > 0) parts.push(`value ${JSON.stringify(node.value)}`)
  if (node.state.length > 0) parts.push(`(${node.state.join(', ')})`)
  return parts.join(' ')
}

/** The tree, one node a line, indented by depth. */
export function semanticTree(nodes: readonly SemanticNode[]): string {
  const lines: string[] = []
  const walk = (list: readonly SemanticNode[], depth: number): void => {
    for (const node of list) {
      lines.push(`${'  '.repeat(depth)}${nodeLine(node)}`)
      walk(node.children, depth + 1)
    }
  }
  walk(nodes, 0)
  return lines.join('\n')
}

/**
 * The semantic buffer's text, for the human (`show-semantic-view`): a header
 * the cockpit writes, then the tree. The page's strings are quoted, and the
 * header says they are the page's.
 */
export function semanticText(snapshot: SemanticSnapshot): string {
  const head = [
    `Semantic view of ${snapshot.origin}: ${snapshot.count} ${snapshot.count === 1 ? 'node' : 'nodes'}.`,
    "Names and values in quotes are the page's own text, shown as data. Refs stay the same until the page navigates.",
    '',
  ]
  const tree =
    snapshot.count === 0 ? 'Nothing on this page to read or act on.' : semanticTree(snapshot.nodes)
  return [...head, tree].join('\n')
}

/**
 * A prompt about a page from its snapshot (T4): the cockpit's instruction,
 * then the tree inside `wrapUntrusted`'s block, headed by the origin of the
 * committed URL main held, never one the page names.
 */
export function snapshotPrompt(instruction: string, snapshot: SemanticSnapshot): string {
  return pagePrompt(instruction, snapshot.origin, semanticTree(snapshot.nodes))
}
