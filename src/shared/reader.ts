import {
  MAX_PAGE_TITLE,
  MAX_PAGE_URL,
  MAX_READER_BLOCKS,
  MAX_READER_DEPTH,
  MAX_READER_LINKS,
  MAX_READER_TEXT,
  type ReaderAnswer,
  type ReaderBlock,
  type ReaderKind,
  type ReaderLink,
} from './page-door'

/**
 * Reader mode's extraction (#128, study 03 "M4 needs" 4): a page's main text
 * as plain blocks, its title, headings, paragraphs, list items, quotes and
 * code, with each link's text followed by a footnote mark and the link's URL
 * in the answer's list. Text only: nothing of the page's HTML, styles or
 * scripts survives, so the reader buffer has nothing to render but text.
 *
 * The page preload (src/preload/page.ts) runs this over the live DOM in the
 * isolated world and answers `reader` through the door of ADR 0009; the unit
 * tests run it over fixture HTML. It reads the nodes it is given and writes
 * nothing. The chrome of a page (navigation, asides, forms, footers, the
 * banner outside the article) is left out, and so is anything `hidden` says
 * a reader does not see.
 */

/** The parts of a DOM node the walk reads: an element (1) or a text node (3). */
export interface ReaderNode {
  readonly nodeType: number
  /** An element's tag name, upper case in an HTML document; `#text` on a text node. */
  readonly nodeName: string
  /** A text node's text; null on an element. */
  readonly nodeValue: string | null
  readonly childNodes: ArrayLike<ReaderNode>
  /** A link's absolute URL, as the DOM resolves it. */
  readonly href?: unknown
  getAttribute?(name: string): string | null
}

const ELEMENT_NODE = 1
const TEXT_NODE = 3

/** How deep the walk goes before it stops reading a subtree. */
const MAX_WALK_DEPTH = 256

/** Never text a reader reads: code, media, controls and the page's chrome. */
const SKIPPED: ReadonlySet<string> = new Set([
  'HEAD',
  'SCRIPT',
  'STYLE',
  'NOSCRIPT',
  'TEMPLATE',
  'IFRAME',
  'OBJECT',
  'EMBED',
  'SVG',
  'MATH',
  'CANVAS',
  'VIDEO',
  'AUDIO',
  'IMG',
  'NAV',
  'ASIDE',
  'FOOTER',
  'FORM',
  'BUTTON',
  'INPUT',
  'SELECT',
  'TEXTAREA',
  'DIALOG',
  'MENU',
])

/** Elements that end the text before them and start a block of their own. */
const BLOCKS: ReadonlySet<string> = new Set([
  'ADDRESS',
  'ARTICLE',
  'BODY',
  'CENTER',
  'DD',
  'DETAILS',
  'DIV',
  'DL',
  'DT',
  'FIGCAPTION',
  'FIGURE',
  'HEADER',
  'HGROUP',
  'HR',
  'MAIN',
  'P',
  'SECTION',
  'SUMMARY',
  'TABLE',
  'TBODY',
  'TD',
  'TFOOT',
  'TH',
  'THEAD',
  'TR',
])

/** The link schemes a footnote may name; any other link is its text only. */
const LINK = /^(?:https?:|mailto:)/i

interface Context {
  /** Inside a blockquote. */
  readonly quote: boolean
  /** How many lists the walk is inside. */
  readonly lists: number
  /** The depth of the list item the text belongs to; 0 outside one. */
  readonly item: number
  /** Inside a pre: whitespace kept, no marks. */
  readonly raw: boolean
}

const TOP: Context = { quote: false, lists: 0, item: 0, raw: false }

function tagOf(node: ReaderNode): string {
  return node.nodeName.toUpperCase()
}

function roleOf(node: ReaderNode): string | null {
  return typeof node.getAttribute === 'function' ? node.getAttribute('role') : null
}

class Extraction {
  readonly blocks: ReaderBlock[] = []
  readonly links: ReaderLink[] = []
  private readonly numbers = new Map<string, number>()
  private text: string[] = []

  constructor(
    private readonly hidden: (element: ReaderNode) => boolean,
    /** Whether the root is the whole body, where a banner is chrome. */
    private readonly whole: boolean,
  ) {}

  get full(): boolean {
    return this.blocks.length >= MAX_READER_BLOCKS
  }

  walk(node: ReaderNode, context: Context, depth: number): void {
    if (this.full || depth > MAX_WALK_DEPTH) return
    if (node.nodeType === TEXT_NODE) {
      this.text.push(node.nodeValue ?? '')
      return
    }
    if (node.nodeType !== ELEMENT_NODE) return
    const tag = tagOf(node)
    if (SKIPPED.has(tag) || this.hidden(node)) return
    if (this.whole && tag === 'HEADER') return
    const role = roleOf(node)
    if (role === 'navigation' || role === 'complementary' || role === 'contentinfo') return
    if (role === 'banner' && this.whole) return
    if (context.raw) {
      this.children(node, context, depth)
      return
    }
    const heading = /^H([1-6])$/.exec(tag)
    if (heading?.[1] !== undefined) {
      this.flush(context)
      this.children(node, context, depth)
      this.emit('heading', Number(heading[1]))
      return
    }
    switch (tag) {
      case 'BR':
        this.text.push(' ')
        return
      case 'PRE': {
        this.flush(context)
        this.children(node, { ...context, raw: true }, depth)
        const code = this.text.join('').replace(/\r\n?/g, '\n').replace(/\s+$/, '')
        this.text = []
        this.push('code', 0, code.replace(/^\n+/, ''))
        return
      }
      case 'UL':
      case 'OL': {
        this.flush(context)
        this.children(node, { ...context, lists: context.lists + 1, item: 0 }, depth)
        this.flush(context)
        return
      }
      case 'LI': {
        this.flush(context)
        const item = { ...context, item: Math.min(Math.max(context.lists, 1), MAX_READER_DEPTH) }
        this.children(node, item, depth)
        this.flush(item)
        return
      }
      case 'BLOCKQUOTE': {
        this.flush(context)
        const quote = { ...context, quote: true }
        this.children(node, quote, depth)
        this.flush(quote)
        return
      }
      case 'A': {
        this.children(node, context, depth)
        this.mark(node)
        return
      }
    }
    if (BLOCKS.has(tag)) {
      this.flush(context)
      this.children(node, context, depth)
      this.flush(context)
      return
    }
    this.children(node, context, depth)
  }

  /** The text so far as the block the context makes of it. */
  flush(context: Context): void {
    if (context.item > 0) this.emit('item', context.item)
    else this.emit(context.quote ? 'quote' : 'paragraph', 0)
  }

  private children(node: ReaderNode, context: Context, depth: number): void {
    const children = node.childNodes
    for (let index = 0; index < children.length && !this.full; index += 1) {
      const child = children[index]
      if (child !== undefined) this.walk(child, context, depth + 1)
    }
  }

  /** A link's footnote mark after its text: the same number for the same URL. */
  private mark(node: ReaderNode): void {
    const href = node.href
    if (typeof href !== 'string' || href.length > MAX_PAGE_URL || !LINK.test(href)) return
    let number = this.numbers.get(href)
    if (number === undefined) {
      if (this.links.length >= MAX_READER_LINKS) return
      this.links.push({ href })
      number = this.links.length
      this.numbers.set(href, number)
    }
    this.text.push(`[${number}]`)
  }

  private emit(kind: ReaderKind, level: number): void {
    const text = this.text.join('').replace(/\s+/g, ' ').trim()
    this.text = []
    this.push(kind, level, text)
  }

  private push(kind: ReaderKind, level: number, text: string): void {
    if (text.length === 0 || this.full) return
    this.blocks.push({ kind, level, text: text.slice(0, MAX_READER_TEXT) })
  }
}

/** Every element under `root` with this tag or role, not looking inside a hidden one. */
function find(
  root: ReaderNode,
  matches: (node: ReaderNode) => boolean,
  hidden: (element: ReaderNode) => boolean,
): ReaderNode[] {
  const found: ReaderNode[] = []
  const stack: { node: ReaderNode; depth: number }[] = [{ node: root, depth: 0 }]
  while (stack.length > 0) {
    const top = stack.pop()
    if (top === undefined) break
    const { node, depth } = top
    if (node.nodeType !== ELEMENT_NODE || depth > MAX_WALK_DEPTH) continue
    if (node !== root && (SKIPPED.has(tagOf(node)) || hidden(node))) continue
    if (node !== root && matches(node)) {
      found.push(node)
      continue
    }
    for (let index = node.childNodes.length - 1; index >= 0; index -= 1) {
      const child = node.childNodes[index]
      if (child !== undefined) stack.push({ node: child, depth: depth + 1 })
    }
  }
  return found
}

/**
 * Where the main text is: the page's one article, inside its main landmark
 * when it has one; else the main landmark; else the whole body.
 */
export function readerRoot(
  body: ReaderNode,
  hidden: (element: ReaderNode) => boolean = () => false,
): ReaderNode {
  const main =
    find(body, (node) => tagOf(node) === 'MAIN' || roleOf(node) === 'main', hidden)[0] ?? body
  const articles = find(main, (node) => tagOf(node) === 'ARTICLE', hidden)
  return articles.length === 1 && articles[0] !== undefined ? articles[0] : main
}

/**
 * The `reader` answer for a document: its title, one line and bounded, and
 * the main text under `body` as blocks, at most MAX_READER_BLOCKS, with the
 * links their marks name.
 */
export function extractReader(
  title: string,
  body: ReaderNode | null,
  hidden: (element: ReaderNode) => boolean = () => false,
): ReaderAnswer {
  const heading = title.replace(/\s+/g, ' ').trim().slice(0, MAX_PAGE_TITLE)
  if (body === null) return { title: heading, blocks: [], links: [] }
  const root = readerRoot(body, hidden)
  const extraction = new Extraction(hidden, root === body)
  extraction.walk(root, TOP, 0)
  extraction.flush(TOP)
  return { title: heading, blocks: extraction.blocks, links: extraction.links }
}
