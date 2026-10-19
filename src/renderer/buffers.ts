import type { BufferInfo, BufferList } from '../shared/buffers'

/**
 * The window's view of the buffer list (#60). The renderer decides nothing:
 * the main process owns the list and pushes a snapshot on every create, switch
 * and kill, and the page reflects it.
 *
 * M1 shows two buffers, the transcript above and the prompt below, laid out in
 * index.html. A buffer with no element of its own (a second transcript, until
 * windows split) is still listed in the mode line, which is what `C-x b` and
 * the palette (#65) work from.
 */
export async function installBufferList(): Promise<void> {
  window.nemesis.onBuffersChanged(render)
  render(await window.nemesis.buffers())
}

function render(list: BufferList): void {
  const modeline = document.getElementById('buffer-list')
  if (modeline) {
    modeline.textContent = list.buffers.map((buffer) => label(buffer, list.currentId)).join(' ')
  }

  // Several buffers may share an element (every pending request shows in
  // #request, #63); the current one, when any, is the one the element is for.
  const shown = new Map<string, BufferInfo>()
  for (const buffer of list.buffers) {
    if (buffer.elementId === null) continue
    if (!shown.has(buffer.elementId) || buffer.id === list.currentId) {
      shown.set(buffer.elementId, buffer)
    }
  }
  // A page shows only while its buffer is current, in the transcript's place:
  // the main process covers the page section with that page's view (#119).
  const current = list.buffers.find((buffer) => buffer.id === list.currentId)
  const pageCurrent = current?.kind === 'page'
  renderPageUrl(pageCurrent ? (current.url ?? null) : null)
  for (const section of document.querySelectorAll<HTMLElement>('[data-buffer-type]')) {
    const buffer = shown.get(section.id)
    // A killed buffer stops being shown; its section goes with it.
    section.hidden =
      buffer === undefined ||
      (buffer.kind === 'page' && !pageCurrent) ||
      (section.id === 'transcript' && pageCurrent)
    if (buffer !== undefined && buffer.id === list.currentId) {
      section.dataset['current'] = 'true'
    } else {
      delete section.dataset['current']
    }
  }
}

/** The current buffer is the one in brackets, as Emacs marks the mode line. */
function label(buffer: BufferInfo, currentId: string | null): string {
  return buffer.id === currentId ? `[${buffer.title}]` : buffer.title
}

/**
 * The current page's committed URL in the mode line (#119). Plain http: is
 * only ever a loopback page (#52), and its scheme is shown in red so it never
 * reads as https:.
 */
function renderPageUrl(url: string | null): void {
  const element = document.getElementById('page-url')
  if (element === null) return
  if (url === null) {
    element.replaceChildren()
    element.title = ''
    return
  }
  element.title = url
  if (url.startsWith('http:')) {
    const scheme = document.createElement('span')
    scheme.className = 'insecure'
    scheme.textContent = 'http'
    element.replaceChildren(scheme, url.slice('http'.length))
  } else {
    element.replaceChildren(url)
  }
}
