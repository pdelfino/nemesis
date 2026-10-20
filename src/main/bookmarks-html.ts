/**
 * The Netscape bookmark file every browser exports (#175): `<DL>` lists of
 * `<DT><A HREF>` links, a folder being a `<DT><H3>` followed by its own
 * `<DL>`. The parser is a tolerant scan, not an HTML parser: it reads the
 * three tags it needs, ignores the rest and a file it does not understand
 * yields fewer entries, never an error. The text is the file's and
 * untrusted: URLs other than http: and https: are dropped, titles are
 * decoded as text only.
 */

export interface ImportedBookmark {
  readonly url: string
  readonly title: string
  /** The folders the link sits in, as tags (outermost first). */
  readonly tags: readonly string[]
}

const NAMED: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
}

function decode(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body: string) => {
    if (body.startsWith('#')) {
      const code =
        body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : Number(body.slice(1))
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : whole
    }
    return NAMED[body.toLowerCase()] ?? whole
  })
}

/** A folder's name as an Org tag: letters, digits and `_`, lowercased, at most 40; empty when nothing is left. */
export function folderTag(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40)
}

function attribute(attributes: string, name: string): string | undefined {
  const match = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(
    attributes,
  )
  const value = match?.[1] ?? match?.[2] ?? match?.[3]
  return value === undefined ? undefined : decode(value)
}

/** The links of a Netscape bookmark file, in file order, each with its folders as tags. */
export function parseBookmarksHtml(html: string): readonly ImportedBookmark[] {
  const found: ImportedBookmark[] = []
  // One entry per open <DL>: the tag of the folder that opened it, or '' for the root and unnamed lists.
  const folders: string[] = []
  let pending = ''
  const tokens = /<(\/?)(dl|h3|a)\b([^>]*)>/gi
  let token: RegExpExecArray | null
  while ((token = tokens.exec(html)) !== null) {
    const closing = token[1] === '/'
    const name = (token[2] ?? '').toLowerCase()
    if (name === 'dl') {
      if (closing) {
        folders.pop()
      } else {
        folders.push(pending)
        pending = ''
      }
      continue
    }
    if (closing) continue
    const rest = html.slice(tokens.lastIndex)
    const close = new RegExp(`</${name}\\s*>`, 'i').exec(rest)
    const text = decode(
      (close === null ? rest.slice(0, 200) : rest.slice(0, close.index)).replace(/<[^>]*>/g, ''),
    )
    if (name === 'h3') {
      pending = folderTag(text)
      continue
    }
    const href = attribute(token[3] ?? '', 'href')
    if (href === undefined) continue
    let url: URL
    try {
      url = new URL(href.trim())
    } catch {
      continue
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') continue
    const tags = [...new Set(folders.filter((tag) => tag.length > 0))]
    found.push({ url: url.href, title: text.replace(/\s+/g, ' ').trim(), tags })
  }
  return found
}
