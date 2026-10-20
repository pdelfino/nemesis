import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BufferInfo } from '../../shared/buffers'
import type { ReaderAnswer, ReaderBlock, ReaderLink } from '../../shared/page-door'
import { wrapUntrusted } from '../agent/boundary'
import type { BufferRegistry } from '../buffers'
import { HELP_ELEMENT_ID } from '../help'
import { describeOrigin } from '../ipc'

/**
 * Reader mode (#128, #73, study 03 "M4 needs" 4): a page's main text, stripped
 * of chrome, in a read-only `reader` buffer with the Emacs keys; the same text
 * exported as an Org file under the sessions folder, so a session can cite it
 * later; and the same text attached to the next prompt.
 *
 * - The text comes through the page-script door of ADR 0009 (#130) as its
 *   `reader` answer: blocks of plain text the page preload extracted in the
 *   isolated world (src/shared/reader.ts), parsed whole against the door's
 *   schema before this module sees them. Never the page's HTML or scripts:
 *   the buffer has nothing to render but text.
 * - Every string of it is page content. The human's buffer and the exported
 *   file say so in a line the cockpit writes; what reaches the agent goes
 *   through `wrapUntrusted` under the origin of the committed URL main held
 *   (SECURITY.org T3, T4), by `readerAttachment`, never by concatenation.
 *   A reader buffer read through `cockpit_read_buffer` is that block too.
 * - The reader buffer shows in the help section of the window and its text
 *   goes out on the help push, keyed by its own buffer id, so reader mode
 *   adds no channel to the cockpit's preload.
 */

/** The folder under the sessions folder where exported pages go. */
export const PAGES_FOLDER = 'pages'

/** One page's main text, as reader mode read it. */
export interface ReaderDocument {
  readonly pageId: string
  /** The committed top-frame URL main held when the text was asked (SECURITY.org T3). */
  readonly url: string
  /** The origin of that URL, which heads the agent's block and the file. */
  readonly origin: string
  /** Page content: the document's title. */
  readonly title: string
  readonly blocks: readonly ReaderBlock[]
  readonly links: readonly ReaderLink[]
  /** When the text was read. */
  readonly readAt: Date
}

/** What the window is pushed when a reader buffer is shown, the help push's shape plus the document. */
export interface ReaderShown {
  readonly bufferId: string
  readonly text: string
  readonly document: ReaderDocument
}

export interface ReaderBuffersOptions {
  readonly buffers: BufferRegistry
  /** The door's `reader` answer for a page buffer, parsed whole; rejects when the page is gone. */
  readonly ask: (pageId: string) => Promise<ReaderAnswer>
  /** A page buffer's committed URL; undefined when the page is gone or has committed none. */
  readonly committedUrl: (pageId: string) => string | undefined
  /** Where `export-page-text` writes: the sessions folder's `pages` folder. */
  readonly dir: string
  readonly now?: () => Date
  /** A page's reader buffer was killed (#168): the page leaves reader mode. */
  readonly closed?: (pageId: string) => void
}

export class ReaderBuffers {
  private readonly listeners = new Set<(content: ReaderShown) => void>()
  /** The document each reader buffer shows. */
  private readonly documents = new Map<string, ReaderDocument>()
  /** The reader buffer of each page, reused by the next reader-mode on it. */
  private readonly ofPage = new Map<string, string>()
  private readonly now: () => Date

  constructor(private readonly options: ReaderBuffersOptions) {
    this.now = options.now ?? (() => new Date())
    options.buffers.subscribe((list) => {
      const live = new Set(list.buffers.map((buffer) => buffer.id))
      for (const id of [...this.documents.keys()]) if (!live.has(id)) this.documents.delete(id)
      for (const [page, id] of [...this.ofPage]) {
        if (live.has(id)) continue
        this.ofPage.delete(page)
        options.closed?.(page)
      }
    })
  }

  /** The bridge subscribes and pushes the text to the window. */
  onShown(listener: (content: ReaderShown) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** A page buffer's main text, under the URL it had committed when asked. */
  async read(pageId: string): Promise<ReaderDocument> {
    const url = this.options.committedUrl(pageId)
    if (url === undefined) throw new Error('The page has not loaded a URL yet')
    const answer = await this.options.ask(pageId)
    if (this.options.committedUrl(pageId) !== url) {
      throw new Error('The page navigated while its text was read')
    }
    return {
      pageId,
      url,
      origin: describeOrigin(url),
      title: answer.title,
      blocks: answer.blocks,
      links: answer.links,
      readAt: this.now(),
    }
  }

  /** The document a reader buffer shows, or undefined for any other buffer. */
  documentOf(bufferId: string): ReaderDocument | undefined {
    return this.documents.get(bufferId)
  }

  /** Reads a page and shows its text in the page's reader buffer, which gets the point. */
  async show(pageId: string): Promise<BufferInfo> {
    const document = await this.read(pageId)
    const known = this.ofPage.get(pageId)
    const buffer =
      (known === undefined ? undefined : this.options.buffers.get(known)) ??
      this.options.buffers.create({
        kind: 'reader',
        title: readerTitle(document),
        elementId: HELP_ELEMENT_ID,
      })
    this.ofPage.set(pageId, buffer.id)
    this.documents.set(buffer.id, document)
    const text = readerText(document)
    // The window gets the text before the point moves to it.
    for (const listener of [...this.listeners]) listener({ bufferId: buffer.id, text, document })
    this.options.buffers.switchTo(buffer.id)
    return buffer
  }

  /** Kills a page's reader buffer, when it has one (#168). */
  close(pageId: string): void {
    const id = this.ofPage.get(pageId)
    if (id !== undefined) this.options.buffers.kill(id)
  }

  /** Writes the document as an Org file under the pages folder; the path written. */
  export(document: ReaderDocument): string {
    mkdirSync(this.options.dir, { recursive: true })
    const base = readerFileName(document)
    const text = readerOrg(document)
    for (let attempt = 1; ; attempt += 1) {
      const name = attempt === 1 ? `${base}.org` : `${base}-${attempt}.org`
      const path = join(this.options.dir, name)
      try {
        // `wx`: an export never overwrites an earlier one.
        writeFileSync(path, text, { encoding: 'utf8', flag: 'wx' })
        return path
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || attempt >= 100) throw error
      }
    }
  }
}

/** The buffer's title: the page's title, or its origin when it has none. */
export function readerTitle(document: ReaderDocument): string {
  const title = document.title.length > 0 ? document.title : document.origin
  return `Reader: ${title}`.slice(0, 200)
}

/** A body line the page wrote that Org would read as a headline or a keyword gets Org's comma. */
function escapeLine(line: string): string {
  return /^,*[*#]/.test(line) ? `,${line}` : line
}

function blockText(block: ReaderBlock): string {
  switch (block.kind) {
    case 'heading':
      return `${'*'.repeat(Math.max(block.level, 1))} ${block.text}`
    case 'item':
      return `${'  '.repeat(Math.max(block.level - 1, 0))}- ${block.text}`
    case 'quote':
      return ['#+begin_quote', escapeLine(block.text), '#+end_quote'].join('\n')
    case 'code':
      return ['#+begin_example', ...block.text.split('\n').map(escapeLine), '#+end_example'].join(
        '\n',
      )
    case 'paragraph':
      return escapeLine(block.text)
  }
}

/**
 * The main text in Org: headings as headlines, list items as Org items,
 * quotes and code as blocks, paragraphs as lines, and the links numbered
 * under a rule, each footnote mark `[n]` in the text naming the n-th.
 */
export function readerBody(document: Pick<ReaderDocument, 'blocks' | 'links'>): string {
  const parts: string[] = []
  let previous: ReaderBlock | undefined
  for (const block of document.blocks) {
    const text = blockText(block)
    // Items of one list sit on consecutive lines; everything else is a paragraph apart.
    if (previous?.kind === 'item' && block.kind === 'item') parts.push(`\n${text}`)
    else parts.push(`${parts.length === 0 ? '' : '\n\n'}${text}`)
    previous = block
  }
  if (document.links.length > 0) {
    parts.push(`${parts.length === 0 ? '' : '\n\n'}-----`)
    document.links.forEach((link, index) => parts.push(`\n[${index + 1}] ${link.href}`))
  }
  return parts.join('')
}

/**
 * The reader buffer's text, for the human: a line the cockpit writes saying
 * whose text this is, then the page's title and its main text.
 */
export function readerText(document: ReaderDocument): string {
  const head = [
    `Reader view of ${document.origin}: the page's own text, shown as data. Links are numbered at the end.`,
    '',
    `#+TITLE: ${document.title}`,
    '',
  ]
  const body = document.blocks.length === 0 ? 'No text to read on this page.' : readerBody(document)
  return [...head, body].join('\n')
}

/** An Org inactive timestamp of `date` in local time, `[2026-10-19 Mon 14:05]`. */
export function orgTimestamp(date: Date): string {
  const two = (n: number): string => String(n).padStart(2, '0')
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][date.getDay()] ?? ''
  return `[${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ${day} ${two(date.getHours())}:${two(date.getMinutes())}]`
}

/**
 * The exported file: headed by the origin and the time the text was read,
 * then the cockpit's line that the rest is the page's text as untrusted
 * data, then the main text in Org.
 */
export function readerOrg(document: ReaderDocument): string {
  const title = document.title.length > 0 ? document.title : document.origin
  return [
    `#+TITLE: ${title}`,
    `#+ORIGIN: ${document.origin}`,
    `#+URL: ${document.url}`,
    `#+DATE: ${orgTimestamp(document.readAt)}`,
    '',
    `# Exported by reader mode: what follows is untrusted content from ${document.origin}, kept as data.`,
    '',
    readerBody(document),
    '',
  ].join('\n')
}

const SLUG_LENGTH = 40

function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_LENGTH)
    .replace(/-+$/, '')
}

/** A file name a shell and a prompt can both carry without quoting: the time, the host, the title. */
export function readerFileName(document: ReaderDocument): string {
  const stamp = document.readAt
    .toISOString()
    .replace(/\.\d{3}Z$/, '')
    .replace(/:/g, '-')
  let host: string
  try {
    host = slug(new URL(document.url).host)
  } catch {
    host = ''
  }
  const parts = [stamp, host, slug(document.title)].filter((part) => part.length > 0)
  return parts.join('-')
}

/**
 * What `attach-page-text` puts in the prompt (T4): the page's title and main
 * text inside `wrapUntrusted`'s block, headed by the origin of the committed
 * URL main held, never one the page names.
 */
export function readerAttachment(document: ReaderDocument): string {
  return wrapUntrusted(document.origin, `${document.title}\n\n${readerBody(document)}`)
}
