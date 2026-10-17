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

  const shown = new Map<string, BufferInfo>()
  for (const buffer of list.buffers) {
    if (buffer.elementId !== null) shown.set(buffer.elementId, buffer)
  }
  for (const section of document.querySelectorAll<HTMLElement>('[data-buffer-type]')) {
    const buffer = shown.get(section.id)
    // A killed buffer stops being shown; its section goes with it.
    section.hidden = buffer === undefined
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
