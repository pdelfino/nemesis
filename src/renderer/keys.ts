import type { BufferType, KeyPress } from '../shared/keys'
import { MODAL_BUFFER_TYPES } from '../shared/keys'

/**
 * Key capture (#59). The renderer never decides what a key means: it reports
 * the press and the main process answers with the command it dispatched.
 *
 * Only chords leave the page. A plain character goes to the focused buffer and
 * is never reported, unless a sequence is half typed or the buffer is modal
 * (`y`/`n` on a permission prompt), so typed text stays in the renderer.
 */

const BUFFER_TYPES: readonly BufferType[] = ['prompt', 'transcript', 'permission']

let pending = false

export function installKeyCapture(): void {
  window.addEventListener('keydown', (event) => {
    void onKeyDown(event)
  })
}

async function onKeyDown(event: KeyboardEvent): Promise<void> {
  if (event.isComposing) return
  const bufferType = activeBufferType()
  const isChord = event.ctrlKey || event.altKey || event.metaKey
  const isModal = bufferType !== null && MODAL_BUFFER_TYPES.includes(bufferType)
  if (!isChord && !pending && !isModal) return

  // The answer is asynchronous, so the browser default is dropped up front.
  event.preventDefault()
  const press: KeyPress = {
    key: event.key,
    code: event.code,
    ctrlKey: event.ctrlKey,
    altKey: event.altKey,
    shiftKey: event.shiftKey,
    metaKey: event.metaKey,
    bufferType,
  }
  try {
    const outcome = await window.nemesis.sendKey(press)
    pending = outcome.status === 'pending'
  } catch (error) {
    // A rejected bridge call must not leave the page stuck mid-sequence.
    pending = false
    console.error('Key dispatch failed:', error)
  }
}

function activeBufferType(): BufferType | null {
  const host = document.activeElement?.closest('[data-buffer-type]')
  const value = host?.getAttribute('data-buffer-type') ?? null
  return value !== null && BUFFER_TYPES.includes(value as BufferType) ? (value as BufferType) : null
}
