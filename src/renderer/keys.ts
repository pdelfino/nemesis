import type { BufferType, KeyBindings, KeyOutcome, KeyPress } from '../shared/keys'
import {
  formatStroke,
  MODAL_BUFFER_TYPES,
  startsCockpitChord,
  strokeFromKeyPress,
} from '../shared/keys'

/**
 * Key capture (#59). The renderer never decides what a key means: it reports
 * the press and the main process answers with the command it dispatched.
 *
 * Only the cockpit's chords leave the page (#61). The main process publishes
 * the shape of its keymaps at load, and a key is intercepted only when its
 * stroke is a bound chord or the prefix of one for the buffer under the point,
 * when a sequence is half typed, or when the buffer is modal (`y`/`n` on a
 * permission prompt). Every other key, `C-a` and `M-f` included, reaches the
 * editor under it untouched, and typed text stays in the renderer. Until the
 * shape arrives, every chord is reported, as before #61.
 *
 * The listener runs in the capture phase and stops propagation, so an editor
 * with Emacs keys of its own never sees `C-x` or `C-c C-c`.
 */

const BUFFER_TYPES: readonly BufferType[] = [
  'prompt',
  'transcript',
  'permission',
  'help',
  'diff',
  'plan',
  'spec',
  'review',
  'environment',
  'repl',
  'page',
]

/** Told what a key ran, so a buffer can act on it (the prompt sends on `send-prompt`). */
export type CommandListener = (outcome: KeyOutcome, bufferType: BufferType | null) => void

export interface KeyCapture {
  /** The shape of the keymaps, once the main process has answered. */
  bindings: KeyBindings | null
  onCommand: CommandListener | null
  /**
   * A buffer's say on a bound printable key (#83): `@` is a file mention at
   * the start of a word in the prompt and text inside one, and only the
   * editor knows where the point is. Asked for unmodified printable keys in
   * a buffer that is not modal; true keeps the key as text.
   */
  keepAsText: ((press: KeyPress) => boolean) | null
}

let pending = false

export function installKeyCapture(): KeyCapture {
  const capture: KeyCapture = { bindings: null, onCommand: null, keepAsText: null }
  window.addEventListener(
    'keydown',
    (event) => {
      void onKeyDown(event, capture)
    },
    { capture: true },
  )
  return capture
}

async function onKeyDown(event: KeyboardEvent, capture: KeyCapture): Promise<void> {
  if (event.isComposing) return
  const press: KeyPress = {
    key: event.key,
    code: event.code,
    ctrlKey: event.ctrlKey,
    altKey: event.altKey,
    shiftKey: event.shiftKey,
    metaKey: event.metaKey,
    bufferType: activeBufferType(),
  }
  const token = cockpitToken(press, capture)
  if (token === null) return

  // The answer is asynchronous, so the browser default is dropped up front,
  // and the editor under the key never sees it.
  event.preventDefault()
  event.stopPropagation()
  // A known prefix holds the sequence before the answer arrives, so the next
  // stroke is not typed into the buffer while the bridge call is in flight.
  if (
    !pending &&
    capture.bindings !== null &&
    isPrefix(token, capture.bindings, press.bufferType)
  ) {
    pending = true
  }
  try {
    const outcome = await window.nemesis.sendKey(press)
    // A capture (`describe-key`, #65) wants the next sequence whatever it is.
    pending = outcome.status === 'pending' || outcome.capture === true
    if (outcome.status === 'command') capture.onCommand?.(outcome, press.bufferType)
  } catch (error) {
    // A rejected bridge call must not leave the page stuck mid-sequence.
    pending = false
    console.error('Key dispatch failed:', error)
  }
}

/**
 * The stroke in Emacs notation when the press is the cockpit's to handle, or
 * null when the editor keeps it. A bare modifier is nobody's.
 */
function cockpitToken(press: KeyPress, capture: KeyCapture): string | null {
  const stroke = strokeFromKeyPress(press)
  if (stroke === null) return null
  const token = formatStroke(stroke)
  if (pending) return token
  if (press.bufferType !== null && MODAL_BUFFER_TYPES.includes(press.bufferType)) return token
  if (capture.bindings === null) {
    return press.ctrlKey || press.altKey || press.metaKey ? token : null
  }
  if (!startsCockpitChord(token, capture.bindings, press.bufferType)) return null
  const printable = !press.ctrlKey && !press.altKey && !press.metaKey && stroke.key.length === 1
  if (printable && capture.keepAsText?.(press) === true) return null
  return token
}

function isPrefix(token: string, bindings: KeyBindings, bufferType: BufferType | null): boolean {
  const buffer = bufferType === null ? undefined : bindings.byBufferType[bufferType]
  return [buffer, bindings.global].some((layer) => layer?.prefixes.includes(token) === true)
}

function activeBufferType(): BufferType | null {
  const host = document.activeElement?.closest('[data-buffer-type]')
  const value = host?.getAttribute('data-buffer-type') ?? null
  return value !== null && BUFFER_TYPES.includes(value as BufferType) ? (value as BufferType) : null
}
